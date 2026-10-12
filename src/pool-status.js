'use strict';

/**
 * pool-status.js —— 把 account-store.list() 的结果攒成「号池看板」要的 JSON。
 *
 * 纯函数：不读盘、不看全局状态，方便离线测试。网页 `/pool.html` 每几秒
 * 拉一次 `/api/pool`，渲染的就是这个结构。
 *
 * 为什么要单独一层：几百个号的状态汇总（每个模型打了多少、谁打光了、
 * 谁在冷却、整体还剩多少配额）不能散在路由里，否则没法测。
 */

/** 总计桶的 key —— recordUsage 里模型计数和总计数是分开的两个桶。 */
const TOTAL_KEY = '_total';

/** 没传模型清单时的兜底（和上游免费档那几个主力模型对齐）。 */
const FALLBACK_MODELS = [
  'qwen3.8-max',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
  'qwen3.5-plus',
];

function isFresh(ts, now) {
  return Number(ts || 0) > now;
}

/**
 * @param {Array} accounts accountStore.list() 的输出（含 daily 记账）
 * @param {string[]} models 要逐个统计配额的模型清单
 * @param {number} dailyLimit 单号单模型当天上限
 * @param {number} [now] 当前时间戳（测试可注入）
 */
function buildPoolStatus(accounts, models, dailyLimit, now = Date.now()) {
  const list = Array.isArray(accounts) ? accounts : [];
  const limit = Number(dailyLimit) > 0 ? Number(dailyLimit) : 20;
  const modelList = Array.isArray(models) && models.length ? models.slice() : FALLBACK_MODELS.slice();

  const rows = list.map((a) => {
    const daily = (a && a.daily) || {};
    const counts = daily.counts || {};
    const exhausted = daily.exhausted || {};
    // exhausted 里存的是「解封时间戳」，通常是次日北京时间零点
    const exhaustedModels = Object.keys(exhausted)
      .filter((m) => isFresh(exhausted[m], now))
      .map((m) => ({ model: m, resetAt: Number(exhausted[m] || 0) }));
    // 用量自然打到顶的模型（没被显式标记，但次数已满）
    const fullModels = Object.keys(counts)
      .filter((m) => m !== TOTAL_KEY && Number(counts[m] || 0) >= limit);
    const coolingMs = Math.max(0, Number((a && a.unavailableUntil) || 0) - now);
    const hasToken = Boolean(a && a.token);
    let status = 'idle';
    if (!hasToken) status = 'off';
    else if (coolingMs > 0) status = 'cooling';
    else if (exhaustedModels.length || fullModels.length) status = 'exhausted';
    else if (a.active) status = 'active';
    return {
      id: a.id,
      email: a.email || '',
      active: Boolean(a.active),
      hasToken,
      failures: Number((a && a.failures) || 0),
      lastError: (a && a.lastError) || '',
      lastUsedAt: Number((a && a.lastUsedAt) || 0),
      coolingMs,
      exhaustedModels,
      fullModels,
      used: Number(counts[TOTAL_KEY] || 0),
      counts,
      status,
    };
  });

  const withToken = rows.filter((r) => r.hasToken);

  const modelStats = modelList.map((model) => {
    const used = rows.reduce((sum, r) => sum + Number(r.counts[model] || 0), 0);
    const capacity = withToken.length * limit;
    const exhaustedCount = rows.filter((r) => r.exhaustedModels.some((e) => e.model === model)).length;
    const fullCount = rows.filter((r) => Number(r.counts[model] || 0) >= limit).length;
    return {
      model,
      used,
      capacity,
      remaining: Math.max(0, capacity - used),
      exhaustedCount,
      fullCount,
      pct: capacity > 0 ? Math.min(100, Math.round((used / capacity) * 100)) : 0,
    };
  });

  const usedTotal = rows.reduce((sum, r) => sum + r.used, 0);
  const resets = rows
    .flatMap((r) => r.exhaustedModels.map((e) => e.resetAt))
    .filter((t) => t > now);

  return {
    now,
    dailyLimit: limit,
    total: rows.length,
    withToken: withToken.length,
    // 可用 = 有 token、不在冷却、今天还有额度
    available: rows.filter((r) => r.status === 'active' || r.status === 'idle').length,
    activeId: (rows.find((r) => r.active) || {}).id || null,
    cooling: rows.filter((r) => r.status === 'cooling').length,
    exhausted: rows.filter((r) => r.status === 'exhausted').length,
    off: rows.filter((r) => r.status === 'off').length,
    usedTotal,
    capacityTotal: withToken.length * limit,
    nextResetAt: resets.length ? Math.min(...resets) : null,
    models: modelStats,
    accounts: rows,
  };
}

module.exports = { buildPoolStatus, TOTAL_KEY, FALLBACK_MODELS };
