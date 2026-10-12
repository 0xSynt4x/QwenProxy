#!/usr/bin/env node
/**
 * pool-status 号池汇总 离线测试
 * 不发真实请求。直接拿 buildPoolStatus 喂假账号列表，验证：
 * 汇总数字、每个模型的配额统计、账号状态的判定（打光/冷却/无登录态）、
 * 以及「全打光时 remaining 不为负」这类边界。
 */
'use strict';

const assert = require('assert');
const { buildPoolStatus } = require('../src/pool-status');

function section(name) {
  console.log(`\n=== ${name} ===`);
}

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail += 1;
    console.error(`  ❌ ${name}\n     ${e.message}`);
  }
}

const NOW = Date.parse('2026-10-25T10:00:00+08:00');
const TOMORROW = Date.parse('2026-10-26T00:00:00+08:00');
const MODELS = ['qwen3.8-max', 'qwen3.7-plus'];

/** 造一个 account-store.list() 形状的账号对象。 */
function acct(id, opts = {}) {
  return {
    id,
    email: `${id}@x.com`,
    token: opts.token === undefined ? 'tk' : opts.token,
    active: Boolean(opts.active),
    failures: opts.failures || 0,
    lastError: opts.lastError || '',
    lastUsedAt: opts.lastUsedAt || 0,
    unavailableUntil: opts.unavailableUntil || 0,
    daily: {
      date: '2026-10-25',
      counts: opts.counts || {},
      exhausted: opts.exhausted || {},
    },
  };
}

section('基本汇总');

// 3 个号：a 当前在用打了 3 次，b 满 20 次，c 一个模型被打光
const base = [
  acct('a', { active: true, counts: { 'qwen3.8-max': 3, _total: 3 }, lastUsedAt: NOW - 60000 }),
  acct('b', { counts: { 'qwen3.8-max': 20, _total: 20 } }),
  acct('c', { counts: { 'qwen3.8-max': 4, _total: 4 }, exhausted: { 'qwen3.8-max': TOMORROW } }),
];

check('总数 / 有 token / 可用号统计正确', () => {
  const s = buildPoolStatus(base, MODELS, 20, NOW);
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.withToken, 3);
  // a 待命、b 满 20 算打光、c 显式打光 ⇒ 只有 a 算可用
  assert.strictEqual(s.available, 1);
  assert.strictEqual(s.exhausted, 2);
  assert.strictEqual(s.activeId, 'a');
});

check('当日已用 = 各号 _total 之和', () => {
  const s = buildPoolStatus(base, MODELS, 20, NOW);
  assert.strictEqual(s.usedTotal, 27);
  assert.strictEqual(s.capacityTotal, 60);
});

check('按模型统计用量/容量/剩余/打光数', () => {
  const s = buildPoolStatus(base, MODELS, 20, NOW);
  const max = s.models.find((m) => m.model === 'qwen3.8-max');
  assert.strictEqual(max.used, 27); // 3 + 20 + 4
  assert.strictEqual(max.capacity, 60);
  assert.strictEqual(max.remaining, 33);
  assert.strictEqual(max.pct, 45);
  // c 是显式 exhausted、b 是自然打满 20
  assert.strictEqual(max.exhaustedCount, 1);
  assert.strictEqual(max.fullCount, 1);
  const plus = s.models.find((m) => m.model === 'qwen3.7-plus');
  assert.strictEqual(plus.used, 0);
  assert.strictEqual(plus.pct, 0);
});

check('nextResetAt 取最早的解封时间', () => {
  const s = buildPoolStatus(base, MODELS, 20, NOW);
  assert.strictEqual(s.nextResetAt, TOMORROW);
});

check('没传模型清单时用兜底清单，不炸', () => {
  const s = buildPoolStatus(base, [], 20, NOW);
  assert.ok(s.models.length > 0);
  assert.strictEqual(s.models[0].model.length > 0, true);
});

check('号池为空时所有合计都是 0，不除零', () => {
  const s = buildPoolStatus([], MODELS, 20, NOW);
  assert.strictEqual(s.total, 0);
  assert.strictEqual(s.available, 0);
  assert.strictEqual(s.capacityTotal, 0);
  assert.strictEqual(s.nextResetAt, null);
  s.models.forEach((m) => {
    assert.strictEqual(m.capacity, 0);
    assert.strictEqual(m.remaining, 0);
    assert.strictEqual(m.pct, 0);
  });
});

check('非数组入参退化成空号池', () => {
  const s = buildPoolStatus(undefined, MODELS, 20, NOW);
  assert.strictEqual(s.total, 0);
});

section('账号状态判定');

check('缺 token 的号标 off 且不计入容量', () => {
  const s = buildPoolStatus([acct('dead', { token: '' }), acct('ok')], MODELS, 20, NOW);
  assert.strictEqual(s.off, 1);
  assert.strictEqual(s.withToken, 1);
  assert.strictEqual(s.capacityTotal, 20);
  assert.strictEqual(s.accounts.find((a) => a.id === 'dead').status, 'off');
});

check('冷却中的号标 cooling 且不算可用', () => {
  const s = buildPoolStatus(
    [acct('warm', { unavailableUntil: NOW + 5 * 60 * 1000, lastError: 'RateLimited' })],
    MODELS, 20, NOW,
  );
  assert.strictEqual(s.cooling, 1);
  assert.strictEqual(s.available, 0);
  const a = s.accounts[0];
  assert.strictEqual(a.status, 'cooling');
  assert.strictEqual(a.coolingMs, 5 * 60 * 1000);
});

check('冷却已过期的号恢复可用', () => {
  const s = buildPoolStatus(
    [acct('cold', { unavailableUntil: NOW - 1000 })],
    MODELS, 20, NOW,
  );
  assert.strictEqual(s.accounts[0].status, 'idle');
  assert.strictEqual(s.available, 1);
});

check('过期的 exhausted 时间戳不算打光', () => {
  const s = buildPoolStatus(
    [acct('y', { exhausted: { 'qwen3.8-max': NOW - 1 } })],
    MODELS, 20, NOW,
  );
  assert.strictEqual(s.accounts[0].status, 'idle');
  assert.deepStrictEqual(s.accounts[0].exhaustedModels, []);
});

check('自然打满 20 次的号也算打光（无需报错标记）', () => {
  const s = buildPoolStatus(
    [acct('full', { counts: { 'qwen3.8-max': 20, _total: 20 } })],
    MODELS, 20, NOW,
  );
  const a = s.accounts[0];
  assert.strictEqual(a.status, 'exhausted');
  assert.deepStrictEqual(a.fullModels, ['qwen3.8-max']);
});

check('超量使用（计数超过上限）时 remaining 不为负', () => {
  const s = buildPoolStatus(
    [acct('over', { counts: { 'qwen3.8-max': 25, _total: 25 } })],
    MODELS, 20, NOW,
  );
  const max = s.models.find((m) => m.model === 'qwen3.8-max');
  assert.strictEqual(max.remaining, 0);
  assert.strictEqual(max.pct, 100);
});

check('_total 与模型计数分开：模型 0 次但总计有值时不算打光', () => {
  const s = buildPoolStatus(
    [acct('legacy', { counts: { _total: 7 } })],
    MODELS, 20, NOW,
  );
  const a = s.accounts[0];
  assert.strictEqual(a.used, 7);
  assert.deepStrictEqual(a.fullModels, []);
  assert.strictEqual(a.status, 'idle');
});

section('dailyLimit 传参');

check('传 0 / 负数时回落到 20', () => {
  const s = buildPoolStatus([acct('a')], MODELS, 0, NOW);
  assert.strictEqual(s.dailyLimit, 20);
  const s2 = buildPoolStatus([acct('a')], MODELS, -5, NOW);
  assert.strictEqual(s2.dailyLimit, 20);
});

check('自定义上限参与打光判定', () => {
  const s = buildPoolStatus(
    [acct('a', { counts: { 'qwen3.8-max': 5, _total: 5 } })],
    MODELS, 5, NOW,
  );
  assert.strictEqual(s.accounts[0].status, 'exhausted');
});

console.log(`\n总计: ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
