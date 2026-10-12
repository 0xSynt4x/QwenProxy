'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { logger } = require('./util');

let accounts = new Map();
let activeId = null;
let cursor = 0;

/**
 * 当天用量记账（北京时间日切）。
 *
 * 🔴 背景：Qwen 免费档是「每号每模型每天 20 次」，配额按模型算。
 * 原版只记 `failures` / `lastUsedAt`，完全没有「今天这个号的这个模型用了几次」
 * 的概念 —— 号池一多就只能瞎轮，把 20 次额度瞬间打光在同一个号上。
 *
 * 这里在账号文件里存：
 *   daily: { date, counts: {model: n}, exhausted: {model: untilMs} }
 * `date` 是北京时间 YYYY-MM-DD，跨天自动归零；
 * `exhausted` 由上游显式告知「已达上限」时打上，到次日自动失效。
 */
const DAILY_LIMIT = Number(process.env.QWEN_DAILY_LIMIT || 20);

function safeId(value) {
  const id = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
  return id || `account-${Date.now()}`;
}

function accountPath(id) {
  return path.join(config.ACCOUNTS_DIR, `${safeId(id)}.json`);
}

function normalize(data, id) {
  const account = {
    ...data,
    id: safeId(data.id || id),
    email: data.email || data.id || 'unknown',
    failures: Number(data.failures || 0),
    unavailableUntil: Number(data.unavailableUntil || 0),
    lastError: data.lastError || '',
    lastUsedAt: Number(data.lastUsedAt || 0),
    // 长命凭据（30 天）。老账号文件可能没有，由 token-manager 启动时从 cookie 补。
    refreshToken: data.refreshToken || '',
    lastRefreshAt: Number(data.lastRefreshAt || 0),
  };
  rollDaily(account);
  return account;
}

function persist(account) {
  fs.mkdirSync(config.ACCOUNTS_DIR, { recursive: true });
  fs.writeFileSync(accountPath(account.id), JSON.stringify(account, null, 2), 'utf8');
}

function migrateLegacy() {
  if (!fs.existsSync(config.ACCOUNT_FILE)) return;
  try {
    const legacy = JSON.parse(fs.readFileSync(config.ACCOUNT_FILE, 'utf8'));
    if (legacy && legacy.token) {
      const account = normalize(legacy, legacy.id || legacy.email || 'account-1');
      accounts.set(account.id, account);
      persist(account);
      fs.renameSync(config.ACCOUNT_FILE, `${config.ACCOUNT_FILE}.migrated`);
      logger.info(`Legacy account migrated to config/accounts/${account.id}.json`, 'ACCOUNT');
    }
  } catch (err) {
    logger.warn(`Could not migrate legacy account: ${err.message}`, 'ACCOUNT');
  }
}

function load() {
  accounts = new Map();
  fs.mkdirSync(config.ACCOUNTS_DIR, { recursive: true });
  migrateLegacy();
  for (const file of fs.readdirSync(config.ACCOUNTS_DIR).filter((name) => name.endsWith('.json'))) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(config.ACCOUNTS_DIR, file), 'utf8'));
      if (raw && raw.token) {
        const account = normalize(raw, path.basename(file, '.json'));
        accounts.set(account.id, account);
      }
    } catch (err) {
      logger.warn(`Skipping invalid account ${file}: ${err.message}`, 'ACCOUNT');
    }
  }
  if (activeId && !accounts.has(activeId)) activeId = null;
  if (!activeId) activeId = accounts.keys().next().value || null;
  return current();
}

/**
 * 写入新 token：同时更新顶层 `token` 和 cookie 数组里 name === 'token' 的那条，
 * 两处必须一致 —— 上游鉴权只认 token，但 SPA 一致性也不能破。
 */
function setToken(account, token) {
  if (!account || !token) return account;
  account.token = token;
  if (Array.isArray(account.cookie)) {
    const hit = account.cookie.find((c) => c && c.name === 'token');
    if (hit) hit.value = token;
    else account.cookie.push({ name: 'token', value: token, domain: '.qwen.ai', path: '/' });
  }
  persist(account);
  return account;
}

function reset(account) {
  const target = typeof account === 'string' ? get(account) : account || current();
  if (!target) return null;
  target.failures = 0;
  target.unavailableUntil = 0;
  target.lastError = '';
  persist(target);
  return target;
}

function save(data, requestedId) {
  let explicitId = requestedId || (data && data.id);
  // 如果传入的是默认的服务用 ID（playwright-capture / manual）且没有显式 requestedId ——
  // 不要覆盖已有用户，而是新建一个唯一的 account-N
  if (!requestedId && (explicitId === 'playwright-capture' || explicitId === 'manual')) {
    explicitId = null;
  }
  let id = explicitId || `account-${accounts.size + 1}`;
  let nextNumber = accounts.size + 1;
  while (!explicitId && accounts.has(safeId(id))) {
    id = `account-${++nextNumber}`;
  }
  const account = normalize(data, id);
  accounts.set(account.id, account);
  persist(account);
  activeId = account.id;
  logger.info(`Account ${account.id} saved`, 'ACCOUNT');
  return account;
}

function list() {
  return [...accounts.values()].map((account) => {
    const daily = rollDaily(account);
    return {
      id: account.id,
      email: account.email,
      token: account.token || '',
      savedAt: account.savedAt,
      failures: account.failures || 0,
      unavailableUntil: account.unavailableUntil || 0,
      lastError: account.lastError || '',
      lastUsedAt: account.lastUsedAt || 0,
      hasRefreshToken: Boolean(account.refreshToken),
      active: account.id === activeId,
      available: isAvailable(account),
      // 当天用量：counts 按模型分，exhausted 是被显式标记打光的模型
      daily: daily,
    };
  });
}

function isAvailable(account) {
  return Boolean(account && account.token && (!account.unavailableUntil || account.unavailableUntil <= Date.now()));
}

/** 北京时间（UTC+8）的日期键，Qwen 配额按北京日的零点重置。 */
function beijingDateKey(ts = Date.now()) {
  return new Date(ts + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 跨天则清零；返回账号上的 daily 对象（总是当天）。 */
function rollDaily(account) {
  if (!account) return null;
  const key = beijingDateKey();
  if (!account.daily || account.daily.date !== key) {
    account.daily = { date: key, counts: {}, exhausted: {} };
  }
  if (!account.daily.counts) account.daily.counts = {};
  if (!account.daily.exhausted) account.daily.exhausted = {};
  return account.daily;
}

/** 这些记账接口既收账号对象，也收账号 id 字符串（调用方手里常常只有 id）。 */
function asAccount(account) {
  if (!account) return null;
  if (typeof account === 'string') return get(account);
  return account;
}

/** 该账号今天在某模型上还能不能用。 */
function isModelAvailable(account, model) {
  const target = asAccount(account);
  if (!target || !target.token) return false;
  if (!model) return isAvailable(target);
  const daily = rollDaily(target);
  const until = Number(daily.exhausted[model] || 0);
  // exhausted 里存的是「失效时间戳」，通常就是次日零点
  if (until && until > Date.now()) return false;
  if (Number(daily.counts[model] || 0) >= DAILY_LIMIT) return false;
  return isAvailable(target);
}

function get(id) { return accounts.get(safeId(id)) || null; }
function current() { return activeId ? accounts.get(activeId) || null : null; }
function isAccount() { return Boolean(current() && current().token); }

function select(id) {
  const account = get(id);
  if (!account) throw new Error(`Account not found: ${id}`);
  activeId = account.id;
  return account;
}

/**
 * 取可用账号候选列表，按「当日用量升序 + 最久未用」排序。
 *
 * 🔴 轮询策略（号池几百个时的关键）：
 *   1. 先按当天用量少的排前面 —— 20 次/模型/天 的额度摊平到整个池子，
 *      不会头几个号被打光、后面的号躺着；
 *   2. 同用量下最久没用的优先，避免连续两轮砸同一个号；
 *   3. 当前 active 号排在首位（保持会话-账号绑定的粘性），但前提是它还有额度。
 *
 * @param {string} [model] 传了才做「该模型今天还有没有额度」的过滤。
 */
function candidates(model) {
  const withModel = Boolean(model);
  const usable = (a) => (withModel ? isModelAvailable(a, model) : isAvailable(a));
  let all = [...accounts.values()].filter(usable);
  if (!all.length && accounts.size > 0) {
    // 全部号今天都打光/都在冷却：退回「只要能连」的集合，让上层明确报错而不是直接 401。
    all = [...accounts.values()].filter((a) => Boolean(a && a.token));
  }
  if (!all.length) return [];
  const usageOf = (a) => {
    const daily = rollDaily(a);
    return Number((daily && daily.counts && daily.counts[model || '_total']) || 0);
  };
  all.sort((a, b) => {
    const diff = usageOf(a) - usageOf(b);
    if (diff !== 0) return diff;
    return (a.lastUsedAt || 0) - (b.lastUsedAt || 0);
  });
  const active = current();
  if (active && usable(active)) {
    return [active, ...all.filter((a) => a.id !== active.id)];
  }
  return all;
}

function markSuccess(account) {
  if (!account) return;
  account.failures = 0;
  account.unavailableUntil = 0;
  account.lastError = '';
  account.lastUsedAt = Date.now();
  activeId = account.id;
  persist(account);
}

/**
 * 记一次当天用量。`model` 缺省时记一个 `_total` 桶。
 *
 * 只在真正被上游接受（拿到 chat_id 或收到首帧）时调用 —— 失败的重试不计数，
 * 否则一次失败的请求会把好号的额度白白扣掉。
 */
function recordUsage(account, model) {
  const target = asAccount(account);
  if (!target) return;
  const daily = rollDaily(target);
  if (!daily) return;
  const key = model ? String(model) : '_total';
  daily.counts[key] = Number(daily.counts[key] || 0) + 1;
  // 模型计数和总计分开：选号排序看的是「该模型今天还剩多少额度」，看总计会把
  // 「3 个模型各用 1 次」误判成快打光。总计只给用量榜看。
  if (model) daily.counts._total = Number(daily.counts._total || 0) + 1;
  persist(target);
}

/**
 * 把某个模型标记成「今天别再用这个号打了」。
 * `until` 缺省时算「明天北京时间零点」，因为免费档配额本来就是按天重置的。
 */
function markExhausted(account, model, until = 0) {
  const target = asAccount(account);
  if (!target) return;
  const daily = rollDaily(target);
  if (!daily) return;
  const key = model ? String(model) : '_total';
  const tomorrow = beijingDateKey(Date.now() + 24 * 3600 * 1000);
  const nextReset = until || Date.parse(`${tomorrow}T00:00:00+08:00`);
  daily.exhausted[key] = nextReset;
  target.lastError = model
    ? `Daily quota exhausted for ${model} (resets at next Beijing midnight)`
    : 'Daily quota exhausted (resets at next Beijing midnight)';
  persist(target);
  if (activeId === target.id) {
    // 换号也要看模型：打光的只是这个模型，但不能因为「别的模型有额度」
    // 就把会话继续挂在同一个号上死磕。没号可换就保持原样。
    const pool = candidates(key) || [];
    const next = pool.find((candidate) => candidate.id !== target.id);
    if (next) activeId = next.id;
  }
}

/** 当天用量快照（给命令行/状态展示用）。 */
function usageSnapshot() {
  const key = beijingDateKey();
  return [...accounts.values()]
    .map((account) => {
      const daily = (account.daily && account.daily.date === key) ? account.daily : { counts: {}, exhausted: {} };
      const models = Object.keys(daily.counts || {})
        .filter((m) => m !== '_total')
        .map((m) => `${m}×${daily.counts[m]}${daily.exhausted?.[m] ? '(已用尽)' : ''}`);
      return {
        id: account.id,
        email: account.email,
        date: key,
        active: account.id === activeId,
        counts: daily.counts || {},
        used: Number(daily.counts._total || 0),
        exhausted: daily.exhausted || {},
        summary: models.length ? models.join(', ') : '今天 0 次',
      };
    })
    .sort((a, b) => Number(b.counts._total || 0) - Number(a.counts._total || 0));
}

function markFailure(account, error, permanent = false) {
  if (!account) return;
  account.failures = Number(account.failures || 0) + 1;
  account.lastError = String(error || 'Request failed').slice(0, 240);
  let backoff;
  if (String(error).includes('RateLimited')) {
    backoff = 6 * 60 * 60 * 1000;
  } else if (permanent) {
    backoff = 30 * 60 * 1000;
  } else {
    backoff = Math.min(15 * 60 * 1000, 30 * 1000 * 2 ** Math.min(account.failures - 1, 5));
  }
  account.unavailableUntil = Date.now() + backoff;
  persist(account);
  if (activeId === account.id) {
    const next = candidates().find((candidate) => candidate.id !== account.id);
    if (next) activeId = next.id;
  }
}

function buildCookieHeader(account, ssxmodItna, ssxmodItna2) {
  // Keep the old buildCookieHeader(ssxmodItna, ssxmodItna2) call working.
  if (typeof account === 'string' || account == null) {
    ssxmodItna2 = ssxmodItna;
    ssxmodItna = account;
    account = current();
  }
  const target = account || current();
  if (!target) return '';
  const parts = [];
  if (target.token) parts.push(`token=${target.token}`);
  if (Array.isArray(target.cookie)) {
    for (const c of target.cookie) {
      if (!c || !c.name || c.name === 'token' || c.name.startsWith('ssxmod')) continue;
      parts.push(`${c.name}=${c.value}`);
    }
  }
  if (ssxmodItna) parts.push(`ssxmod_itna=${ssxmodItna}`);
  if (ssxmodItna2) parts.push(`ssxmod_itna2=${ssxmodItna2}`);
  return parts.join(';');
}

function remove(id) {
  const target = get(id);
  if (!target) return false;
  accounts.delete(target.id);
  const file = accountPath(target.id);
  if (fs.existsSync(file)) {
    try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
  }
  if (activeId === target.id) {
    activeId = accounts.keys().next().value || null;
  }
  return true;
}

module.exports = {
  save,
  load,
  list,
  get,
  current,
  candidates,
  select,
  reset,
  remove,
  markSuccess,
  markFailure,
  markExhausted,
  recordUsage,
  usageSnapshot,
  isAccount,
  isAvailable,
  isModelAvailable,
  buildCookieHeader,
  setToken,
  persistAccount: persist,
  DAILY_LIMIT,
  beijingDateKey,
};
