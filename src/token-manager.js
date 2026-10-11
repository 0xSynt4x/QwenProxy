'use strict';

const axios = require('axios');
const config = require('./config');
const accountStore = require('./account-store');
const { buildHeaders } = require('./qwen-headers');
const { logger } = require('./util');

/**
 * Token 生命周期管理。
 *
 * 🔴 背景（2026-10 实测）：
 *   - Qwen Web 的 access token 只有 **900 秒（15 分钟）**寿命；
 *   - 但登录 cookie 里那条 `refresh_token` 有 **30 天**寿命，
 *     而且它**可以直接当 `Authorization: Bearer` 用**，权限与 access token 等价；
 *   - 正规换发接口是 `GET /api/v1/auths/`：带旧 token 打过去，响应体里回一个新 token，
 *     同时回 `set-cookie: token=<同一个>`。换出来的 token 寿命 ≈30 天，且不轮换
 *     （连续换两次拿到的是同一个）。
 *
 * 所以这里做两件事：
 *   1. 账号文件里优先用 `refresh_token`（长命）当 token，本身就几乎不会过期；
 *   2. 万一还是快过期了，就用 `/api/v1/auths/` 提前换一个新的。
 *
 * 原版仓库**一行续期代码都没有**，token 一过期就 500 —— 这是最致命的坑。
 */

const REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 剩不到 1 天就提前换
const MIN_REFRESH_INTERVAL_MS = 60 * 1000; // 同一账号最快 1 分钟换一次，防打爆

const inFlight = new Map();

/** 解 JWT payload（不校验签名，只为读 exp）。失败返回 null。 */
function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

/** 返回 token 过期时间（毫秒时间戳），读不到返回 null。 */
function getTokenExpiry(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') return null;
  return payload.exp * 1000;
}

/** 返回剩余毫秒数；读不到 exp 返回 null。 */
function getTokenRemainingMs(token) {
  const exp = getTokenExpiry(token);
  if (exp == null) return null;
  return exp - Date.now();
}

/** token 是否已过期或即将过期（默认阈值 1 天）。读不到 exp 时按「不过期」处理，避免误伤。 */
function isTokenExpiring(token, thresholdMs = REFRESH_THRESHOLD_MS) {
  const remaining = getTokenRemainingMs(token);
  if (remaining == null) return false;
  return remaining <= thresholdMs;
}

/** 从响应体或 set-cookie 里抠出新 token。 */
function extractTokenFromResponse(data, headers) {
  if (data && typeof data === 'object' && typeof data.token === 'string' && data.token) {
    return data.token;
  }
  const raw = (headers && (headers['set-cookie'] || headers['Set-Cookie'])) || [];
  const list = Array.isArray(raw) ? raw : [raw];
  for (const line of list) {
    const match = String(line || '').match(/(?:^|;\s*)token=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

/**
 * 拿当前 token 去换一个新的。失败返回 null（不抛，交给调用方决定退避）。
 * 优先用账号里的 `refresh_token` 字段，没有就用 `token` 本身。
 */
async function refreshAccountToken(account) {
  if (!account) return null;
  const bearer = account.refreshToken || account.token;
  if (!bearer) return null;

  const res = await axios.get(`${config.BASE_URL}/api/v1/auths/`, {
    headers: { ...buildHeaders('/c/new-chat', account), authorization: `Bearer ${bearer}` },
    timeout: 30000,
    // 别让 axios 因为 4xx 直接抛，我们想自己看状态码
    validateStatus: () => true,
  });

  if (res.status === 401 || res.status === 403) {
    logger.warn(`Token refresh rejected for ${account.id} (status ${res.status}) — 需要重新登录`, 'TOKEN');
    return null;
  }
  if (res.status !== 200) {
    logger.warn(`Token refresh unexpected status ${res.status} for ${account.id}`, 'TOKEN');
    return null;
  }
  const token = extractTokenFromResponse(res.data, res.headers);
  if (!token) {
    logger.warn(`Token refresh returned no token for ${account.id}`, 'TOKEN');
    return null;
  }
  return token;
}

/**
 * 确保账号 token 新鲜。返回可用的 token 字符串。
 * - token 还够用 → 原样返回（不产生网络请求）
 * - 快过期/已过期 → 换发并落盘
 * - 换发失败 → 返回原 token（让上层按 401 走换账号逻辑，不要在这里死循环）
 */
async function ensureFreshToken(account) {
  if (!account || !account.token) return null;
  if (!isTokenExpiring(account.token)) return account.token;

  const remaining = getTokenRemainingMs(account.token);
  const now = Date.now();
  if (account.lastRefreshAt && now - account.lastRefreshAt < MIN_REFRESH_INTERVAL_MS) {
    return account.token;
  }
  if (inFlight.has(account.id)) return inFlight.get(account.id);

  const task = (async () => {
    logger.info(
      `Refreshing token for ${account.id} (剩余 ${remaining == null ? '未知' : Math.round(remaining / 1000) + 's'})`,
      'TOKEN'
    );
    try {
      const token = await refreshAccountToken(account);
      account.lastRefreshAt = Date.now();
      if (!token) return account.token;
      accountStore.setToken(account, token);
      logger.info(
        `Token refreshed for ${account.id} (新剩余 ${Math.round((getTokenRemainingMs(token) || 0) / 1000)}s)`,
        'TOKEN'
      );
      return token;
    } catch (err) {
      account.lastRefreshAt = Date.now();
      logger.warn(`Token refresh failed for ${account.id}: ${err.message}`, 'TOKEN');
      return account.token;
    } finally {
      inFlight.delete(account.id);
    }
  })();

  inFlight.set(account.id, task);
  return task;
}

/**
 * 从账号 cookie 里找出 refresh_token 的值（登录时抓下来的那份）。
 * 用于给老账号文件补 `refreshToken` 字段，不用重新登录。
 */
function findRefreshTokenInCookies(account) {
  if (!account || !Array.isArray(account.cookie)) return null;
  const hit = account.cookie.find((c) => c && c.name === 'refresh_token' && c.value);
  return hit ? hit.value : null;
}

/**
 * 启动时补全：老账号文件没有 `refreshToken` 字段的，从 cookie 里补上并落盘。
 * 同时如果当前 token 不是长命值（剩余 < 1 天）而 refresh_token 更长，就直接换上。
 */
function backfillRefreshToken(account) {
  if (!account) return account;
  const fromCookie = findRefreshTokenInCookies(account);
  if (!fromCookie) return account;

  let dirty = false;
  if (account.refreshToken !== fromCookie) {
    account.refreshToken = fromCookie;
    dirty = true;
  }

  const currentRemaining = getTokenRemainingMs(account.token);
  const refreshRemaining = getTokenRemainingMs(fromCookie);
  const shouldSwap =
    refreshRemaining != null &&
    (currentRemaining == null || currentRemaining < refreshRemaining) &&
    isTokenExpiring(account.token, 0); // 只在当前 token 已过期时才自动替换，避免误改正在用的凭据

  if (shouldSwap) {
    accountStore.setToken(account, fromCookie);
    logger.info(`Account ${account.id} token swapped to the 30-day refresh_token`, 'TOKEN');
    return account;
  }
  if (dirty) accountStore.persistAccount(account);
  return account;
}

module.exports = {
  decodeJwtPayload,
  getTokenExpiry,
  getTokenRemainingMs,
  isTokenExpiring,
  refreshAccountToken,
  ensureFreshToken,
  findRefreshTokenInCookies,
  backfillRefreshToken,
  extractTokenFromResponse,
};
