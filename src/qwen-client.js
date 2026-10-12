'use strict';

const axios = require('axios');
const config = require('./config');
const accountStore = require('./account-store');
const tokenManager = require('./token-manager');
const { buildHeaders } = require('./qwen-headers');
const { logger } = require('./util');

/**
 * Qwen Chat v2 HTTP 客户端，带完整的反爬请求头
 * 以及每个请求都重新生成的 SSXMOD cookie。
 *
 * 流程：
 *   1. POST /api/v2/chats/new          -> chat_id
 *   2. POST /api/v2/chat/completions?chat_id=...   -> SSE
 *
 * 上游始终是流式的（不支持 stream:false）。
 *
 * 鉴权铁律（2026-10 实测）：
 *   - 只认 `token`，cookie 完全不参与鉴权；
 *   - access token 只有 15 分钟寿命，所以每次请求前先经 token-manager 确保新鲜；
 *   - 收到 401/403 时先用 refresh_token 换一次新 token 再重试，仍失败才换账号。
 */

const isWafResponse = (status, contentType, bodyText) => {
  if (contentType && contentType.includes('text/html')) return true;
  if (status === 504) return true;
  if (typeof bodyText === 'string') {
    return /aliyun_waf|baxia|FAIL_SYS_USER_VALIDATE|RGV587_ERROR|_____tmd_____|x5secdata|<html/i.test(bodyText);
  }
  return false;
};

/**
 * 这个错误是否应该「标记账号额度用光，然后换号重试」。
 * 上游三种报额度的方式都归到这里：
 *   1. SSE error 帧  `RateLimited`
 *   2. SSE 普通正文  「今日对话次数已达上限」→ chat-adapter 报 DailyQuotaExhausted
 *   3. HTTP 正文直接回同一段文案
 */
const isQuotaError = (message) => /RateLimited|DailyQuotaExhausted|今日.*上限|请明日再来|daily limit/i.test(String(message || ''));

/** 401/403 时换一次新 token；成功返回新 token，失败返回 null。 */
async function tryRefreshOnAuthError(account) {
  try {
    const token = await tokenManager.refreshAccountToken(account);
    if (!token) return null;
    accountStore.setToken(account, token);
    logger.info(`Recovered from auth error by refreshing token for ${account.id}`, 'QWEN');
    return token;
  } catch (err) {
    logger.warn(`Auth-error refresh failed for ${account.id}: ${err.message}`, 'QWEN');
    return null;
  }
}

/**
 * 为新会话获取 chat_id。
 */
async function generateChatID(model, chatType = 't2t', targetAccount = null) {
  // 按「这个模型今天还有没有额度」筛候选 —— 号池几百个时不看额度就是瞎轮
  let candidates = accountStore.candidates(model);
  if (targetAccount && targetAccount.token) {
    candidates = [targetAccount, ...candidates.filter((a) => a.id !== targetAccount.id)];
  }
  if (!candidates.length) return null;
  for (const account of candidates) try {
    await tokenManager.ensureFreshToken(account);
    const res = await axios.post(
      `${config.BASE_URL}/api/v2/chats/new`,
      {
        chatId: '',
        models: [model],
        project_id: '',
        timestamp: Date.now(),
        chat_type: chatType,
        chat_mode: 'normal',
      },
      { headers: buildHeaders('/c/new-chat', account), timeout: 30000, validateStatus: () => true }
    );
    if (res.status === 401 || res.status === 403) {
      const refreshed = await tryRefreshOnAuthError(account);
      if (refreshed) {
        const retry = await axios.post(
          `${config.BASE_URL}/api/v2/chats/new`,
          { chatId: '', models: [model], project_id: '', timestamp: Date.now(), chat_type: chatType, chat_mode: 'normal' },
          { headers: buildHeaders('/c/new-chat', account), timeout: 30000, validateStatus: () => true }
        );
        const retryId = retry.data && retry.data.data && retry.data.data.id;
        if (retryId) {
          accountStore.markSuccess(account);
          return retryId;
        }
      }
      accountStore.markFailure(account, 'Unauthorized on /chats/new (token refresh did not help)', true);
      continue;
    }
    if (isWafResponse(res.status, res.headers['content-type'], JSON.stringify(res.data))) {
      accountStore.markFailure(account, 'WAF challenge on /chats/new', true);
      continue;
    }
    const id = (res.data && res.data.data && res.data.data.id) || null;
    if (id) accountStore.markSuccess(account);
    else accountStore.markFailure(account, 'Qwen did not return a chat id');
    if (id) return id;
  } catch (err) {
    accountStore.markFailure(account, err.message, isWafResponse(err.response && err.response.status, err.response && err.response.headers && err.response.headers['content-type'], String(err.response && err.response.data || '')));
    logger.warn(`generateChatId failed for ${account.id}: ${err.message}`, 'QWEN');
  }
  return null;
}

/**
 * 发送 chat 请求。`payload` 中已包含 chat_id/chatId。
 */
async function sendChatRequest(payload, preferredAccount = null) {
  const model = (payload.models && payload.models[0]) || config.DEFAULT_MODEL || 'qwen3.8-max';
  const chatType = payload.sub_chat_type || 't2t';
  const originalChatId = payload.chat_id || payload.chatId;

  /**
   * 「换下一个号重试」的统一收口。
   * 额度类错误（RateLimited / DailyQuotaExhausted / 正文配额文案）要把号标记成
   * 今天打光 —— 否则这个号下一轮还会被 candidates() 排到前面，反复踩同一个坑。
   */
  const handleAccountError = async (account, message) => {
    if (isQuotaError(message)) {
      accountStore.markExhausted(account, model);
      logger.warn(`Marked ${account.id} as quota-exhausted for ${model}: ${String(message).slice(0, 120)}`, 'QWEN');
    }
  };

  // 优先用会话绑定的账号，但前提是它这个模型今天还有额度
  let base = [];
  if (preferredAccount && preferredAccount.token) {
    base = [preferredAccount, ...accountStore.candidates(model).filter((a) => a.id !== preferredAccount.id)];
  } else {
    base = accountStore.candidates(model);
  }
  // 排重 + 过滤掉已确认没额度的号
  const seen = new Set();
  const accountQueue = [];
  for (const acc of base) {
    if (seen.has(acc.id)) continue;
    if (!accountStore.isModelAvailable(acc, model)) continue;
    seen.add(acc.id);
    accountQueue.push(acc);
  }
  const candidates = accountQueue;
  if (!candidates.length) {
    return { status: false, message: 'No account token configured' };
  }

  for (const account of candidates) try {    await tokenManager.ensureFreshToken(account);

    let accountChatId = originalChatId;
    if ((account.id !== candidates[0].id) || !accountChatId) {
      accountChatId = await generateChatID(model, chatType, account);
    }
    if (!accountChatId) {
      accountStore.markFailure(account, 'Failed to generate chat_id');
      continue;
    }

    const accountPayload = {
      ...payload,
      chat_id: accountChatId,
      chatId: accountChatId,
    };

    const url = `${config.BASE_URL}/api/v2/chat/completions?chat_id=${accountChatId}`;
    // 用 validateStatus 自己判状态码：401 时才有机会先续期再重试一次
    const response = await axios.post(url, accountPayload, {
      headers: buildHeaders(`/c/${accountChatId}`, account),
      responseType: 'stream',
      timeout: 10 * 60 * 1000,
      validateStatus: () => true,
    });

    if (response.status === 200) {
      accountStore.markSuccess(account);
      accountStore.recordUsage(account, model);
      return { status: true, response: response.data, account, chatId: accountChatId };
    }

    if (response.status === 401 || response.status === 403) {
      let bodyText = '';
      try { bodyText = await readStream(response.data); } catch (_) { /* ignore */ }
      const refreshed = await tryRefreshOnAuthError(account);
      if (refreshed) {
        const retry = await axios.post(url, accountPayload, {
          headers: buildHeaders(`/c/${accountChatId}`, account),
          responseType: 'stream',
          timeout: 10 * 60 * 1000,
          validateStatus: () => true,
        });
        if (retry.status === 200) {
          accountStore.markSuccess(account);
          accountStore.recordUsage(account, model);
          return { status: true, response: retry.data, account, chatId: accountChatId };
        }
      }
      accountStore.markFailure(account, 'Qwen session expired (token refresh did not help)', true);
      logger.warn(`Auth error for ${account.id} (status ${response.status})${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}, failing over`, 'QWEN');
      continue;
    }

    let bodyText = '';
    try { bodyText = await readStream(response.data); } catch (_) { /* ignore */ }
    const ct = response.headers['content-type'] || '';
    // 免费档额度的第三种回法：HTTP 正常，正文直接是那段配额文案。
    // 不拦的话代理会当成功，白扔一个号当天的余额。
    if (isQuotaError(bodyText)) {
      await handleAccountError(account, 'DailyQuotaExhausted: quota text in http body');
      continue;
    }
    if (isWafResponse(response.status, ct, bodyText)) {
      accountStore.markFailure(account, 'Qwen blocked by WAF', true);
      logger.warn(`WAF block for ${account.id} (status ${response.status}), failing over to next account`, 'QWEN');
      continue;
    }
    accountStore.markFailure(account, `Unexpected status ${response.status}`);
    logger.error(`chat completion failed for ${account.id}: status ${response.status}, failing over...`, 'QWEN');
    continue;
  } catch (err) {
    const status = err.response ? err.response.status : null;
    const ct = err.response ? err.response.headers['content-type'] : '';
    let bodyText = String(err.response && err.response.data ? err.response.data : '').slice(0, 2000);
    try {
      if (err.response && err.response.data && typeof err.response.data === 'object') {
        bodyText = await readStream(err.response.data);
      }
    } catch (_) {
      /* ignore */
    }
    if (status === 401 || status === 403 || isWafResponse(status, ct, bodyText)) {
      accountStore.markFailure(account, 'Qwen session expired or blocked by WAF', true);
      logger.warn(`WAF/session block for ${account.id} (status ${status}), failing over to next account`, 'QWEN');
      continue;
    }
    // 同样：配额文案走 HTTP 正文回来时，标额度 + 换号，不要按普通失败退避
    if (isQuotaError(bodyText) || isQuotaError(err.message)) {
      await handleAccountError(account, `DailyQuotaExhausted: ${bodyText || err.message}`);
      continue;
    }
    accountStore.markFailure(account, err.message);
    logger.error(`chat completion failed for ${account.id}: ${err.message}, failing over...`, 'QWEN');
    continue;
  }
  return { status: false, message: 'All Qwen accounts are unavailable. Re-login an account with `npm run accounts`.' };
}

function readStream(stream) {
  if (!stream || typeof stream !== 'object') return Promise.resolve('');
  if (typeof stream[Symbol.asyncIterator] === 'function') {
    return (async () => {
      let out = '';
      for await (const chunk of stream) out += chunk;
      return out;
    })();
  }
  if (typeof stream.on === 'function') {
    return new Promise((resolve) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        try {
          resolve(Buffer.concat(chunks).toString('utf8'));
        } catch (e) {
          resolve(chunks.join(''));
        }
      });
      stream.on('error', () => resolve(chunks.join('')));
    });
  }
  return Promise.resolve(String(stream));
}

module.exports = { sendChatRequest, generateChatID, isWafResponse, isQuotaError };