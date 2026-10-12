#!/usr/bin/env node
/**
 * 号池当天记账 + 额度识别 离线测试
 * 不发真实请求，只验证 account-store 的 daily 记账 / 排序 / 额度用尽 / 跨天重置
 * 以及 chat-adapter 的「正文配额文案」识别、qwen-client 的错误归类。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// ---------------------------------------------------------------------------
// 1. account-store：当天记账 / 额度用尽 / 排序 / 跨天重置
// ---------------------------------------------------------------------------
section('account-store daily 记账');

// 🔴 必须先在 require 之前把账号目录指到临时目录：config.js 在加载时就快照了
// ACCOUNTS_DIR，晚一步设就晚了。不在真号池上跑，避免污染线上数据。
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-daily-'));
process.env.QWEN_CONFIG_DIR = tmpRoot;
const store = require('../src/account-store');
const accountsDir = require('../src/config').ACCOUNTS_DIR;

/** 清空账号目录。load() 只读 ACCOUNTS_DIR 根、不递归子目录，所以靠这个隔离。 */
function scenario() {
  fs.rmSync(accountsDir, { recursive: true, force: true });
  fs.mkdirSync(accountsDir, { recursive: true });
}

/** 写一个号进去。 */
function writeAccount(id, extra = {}) {
  fs.writeFileSync(path.join(accountsDir, `${id}.json`), JSON.stringify({
    id, email: `${id}@x.com`, token: 'tk', cookie: 'ck', ...extra,
  }));
}

/** 复刻 command-handler 里 usage 命令那套渲染，验证字段都在。 */
function renderUsage(store) {
  const snap = store.usageSnapshot();
  if (!snap.length) return '号池是空的';
  const limit = store.DAILY_LIMIT;
  const totalUsed = snap.reduce((sum, a) => sum + a.used, 0);
  const lines = snap.map((a) => {
    const markers = [];
    if (a.active) markers.push('current');
    if (Object.keys(a.exhausted || {}).length) markers.push('exhausted');
    else if (a.used >= limit * 0.8) markers.push('almost-full');
    const tag = markers.length ? ` (${markers.join(' ')})` : '';
    return `${a.id}: 今天 ${a.used}/${limit} 次${tag} 明细: ${a.summary} date: ${a.date}`;
  });
  return { lines, totalUsed, limit, date: snap[0].date };
}

check('DAILY_LIMIT 默认是上游免费档的 20', () => {
  assert.strictEqual(store.DAILY_LIMIT, 20);
});

check('老账号 normalize 后自动有 daily 字段（结构兼容）', () => {
  scenario();
  writeAccount('legacy', { createdAt: Date.now() }); // 老账号文件没有 daily
  store.load();
  const got = store.get('legacy');
  assert(got, 'legacy 应被加载');
  assert(got.daily, 'normalize 应补 daily');
  assert.deepStrictEqual(got.daily, {
    date: store.beijingDateKey(),
    counts: {},
    exhausted: {},
  });
});

check('recordUsage 按模型计数，_total 累加', () => {
  scenario();
  writeAccount('acc');
  store.load();
  store.recordUsage('acc', 'qwen3.8-max');
  store.recordUsage('acc', 'qwen3.8-max');
  store.recordUsage('acc', 'qwen-plus');
  const acc = store.get('acc');
  assert.strictEqual(acc.daily.counts['qwen3.8-max'], 2, '模型各自的计数要分开');
  assert.strictEqual(acc.daily.counts['qwen-plus'], 1);
  assert.strictEqual(acc.daily.counts._total, 3, '_total 是跨模型合计');
});

check('markExhausted 后该号在当天从此不可用，别的号照样可用', () => {
  scenario();
  writeAccount('a');
  writeAccount('b');
  store.load();
  assert.strictEqual(store.isModelAvailable('a', 'qwen3.8-max'), true);
  store.markExhausted('a', 'qwen3.8-max');
  assert.strictEqual(store.isModelAvailable('a', 'qwen3.8-max'), false);
  // 「自动换号」能成立的前提：另一个号没打光，照样可用
  assert.strictEqual(store.isModelAvailable('b', 'qwen3.8-max'), true);
  const avail = store.candidates('qwen3.8-max').filter((x) => store.isModelAvailable(x, 'qwen3.8-max'));
  assert.strictEqual(avail.length, 1);
  assert.strictEqual(avail[0].id, 'b');
});

check('markExhausted 会主动换 activeId，不再粘在打光的号上', () => {
  scenario();
  writeAccount('x');
  writeAccount('y');
  store.load();
  store.select('x');
  assert.strictEqual(store.current().id, 'x');
  store.markExhausted('x', 'qwen3.8-max');
  assert.notStrictEqual(store.current().id, 'x', 'activeId 应让给没打光的号');
});

check('全打光时退回有 token 的号（不硬失败）', () => {
  scenario();
  writeAccount('a');
  writeAccount('b');
  store.load();
  store.markExhausted('a', 'qwen3.8-max');
  store.markExhausted('b', 'qwen3.8-max');
  const list = store.candidates('qwen3.8-max');
  assert(list.length > 0, '应兜底返回可用号池（让上游自己报错），不能返回空');
  assert(list.every((x) => x.token), '兜底只返回带 token 的号');
});

check('candidates 按当天用量升序轮询（雨露均沾）', () => {
  scenario();
  for (const id of ['p', 'q', 'r']) writeAccount(id);
  store.load();
  store.recordUsage('p', 'qwen3.8-max');
  store.recordUsage('p', 'qwen3.8-max');
  store.recordUsage('p', 'qwen3.8-max');
  store.recordUsage('q', 'qwen3.8-max');
  const usage = (id) => store.get(id).daily.counts['qwen3.8-max'] || 0;
  assert.strictEqual(usage('r'), 0, 'r 今天没用过');
  assert.strictEqual(usage('q'), 1, 'q 用过 1 次');
  assert.strictEqual(usage('p'), 3, 'p 用过 3 次');
  // candidates() 会把 active（p）粘到首位，摘掉它看剩余部分的真实排序
  const active = store.current().id;
  const rest = store.candidates('qwen3.8-max').filter((x) => x.id !== active).map((x) => x.id);
  const sorted = [...rest].sort((a, b) => usage(a) - usage(b));
  assert.deepStrictEqual(rest, sorted, '去掉粘性号后，剩下的按当天用量升序');
});
check('hybrid：今天打满 20 次的号直接被踢出候选', () => {
  // 免费档单号单模型 20 次/天。配额打满的号连「垫底」都不该占 —— 直接不给它，
  // 否则几百个号池里排到最后的号永远等不到机会。
  scenario();
  writeAccount('heavy');
  writeAccount('light');
  store.load();
  store.select('light');
  for (let i = 0; i < store.DAILY_LIMIT; i += 1) store.recordUsage('heavy', 'qwen3.8-max');
  const usage = (id) => store.get(id).daily.counts['qwen3.8-max'] || 0;
  assert.strictEqual(usage('heavy'), store.DAILY_LIMIT, 'heavy 已打满 20 次');
  assert.strictEqual(usage('light'), 0, 'light 没被动过');
  const list = store.candidates('qwen3.8-max').map((x) => x.id);
  assert.strictEqual(list.includes('heavy'), false, '打满的号不该出现在候选里');
  assert.strictEqual(list[0], 'light', '有剩额度的号顶上');
  assert.strictEqual(store.isModelAvailable('heavy', 'qwen3.8-max'), false, '满配额应等于不可用');
});

check('会话粘性：activeId 仍排首位（有剩额度时）', () => {
  scenario();
  writeAccount('a');
  writeAccount('b');
  store.load();
  store.recordUsage('a', 'qwen3.8-max'); // a 今天用过 1 次
  store.select('b');
  const list = store.candidates('qwen3.8-max');
  assert.strictEqual(list[0].id, 'b', '粘性账号应排首位');
});

check('跨天自动归零：date 变了 → counts / exhausted 全清', () => {
  scenario();
  writeAccount('z');
  store.load();
  store.recordUsage('z', 'qwen3.8-max');
  store.markExhausted('z', 'qwen3.8-max');

  // 1) 记账确实落盘了
  const file = path.join(accountsDir, 'z.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(raw.daily.counts['qwen3.8-max'] > 0, '写盘应带当天计数');

  // 2) 额度用尽的过期时间落在次日北京时间零点
  const tomorrow = store.beijingDateKey(Date.now() + 24 * 3600 * 1000);
  const nextMidnight = Date.parse(`${tomorrow}T00:00:00+08:00`);
  assert(
    raw.daily.exhausted['qwen3.8-max'] >= nextMidnight - 1000,
    '过期时间应落在次日北京时间零点'
  );

  // 3) 把日期改成昨天再 load → normalize 里 rollDaily 应清空一切
  raw.daily.date = '2000-01-01';
  fs.writeFileSync(file, JSON.stringify(raw));
  store.load();
  const z = store.get('z');
  assert.strictEqual(z.daily.date, store.beijingDateKey());
  assert.strictEqual(z.daily.counts['qwen3.8-max'], undefined, '跨天应清掉 counts');
  assert.strictEqual(z.daily.exhausted['qwen3.8-max'], undefined, '跨天应清掉 exhausted');
  assert.strictEqual(store.isModelAvailable('z', 'qwen3.8-max'), true, '跨天后号应恢复可用');
});

check('usageSnapshot 降序输出且带当天日期键', () => {
  const snap = store.usageSnapshot();
  assert(Array.isArray(snap));
  for (let i = 1; i < snap.length; i += 1) {
    assert(snap[i - 1].used >= snap[i].used, '应按 used 降序');
  }
  assert(snap.every((x) => typeof x.date === 'string'), '每条应带当天日期键');
});

check('$qwen-api usage 渲染：打光的号标 exhausted、有今天的号给明细', () => {
  scenario();
  writeAccount('a');
  writeAccount('b');
  store.load();
  for (let i = 0; i < 3; i += 1) store.recordUsage('a', 'qwen3.8-max');
  store.recordUsage('b', 'qwen3.8-max');
  store.markExhausted('b', 'qwen3.8-max');

  const view = renderUsage(store);
  assert.strictEqual(view.totalUsed, 4, '合计 = 3 + 1');
  assert.strictEqual(view.limit, store.DAILY_LIMIT);
  assert(/^a: 今天 3\/20 次/.test(view.lines[0]), 'a 排第一且用量为 3: ' + view.lines[0]);
  assert(/exhausted/.test(view.lines[1]), 'b 被标 exhausted: ' + view.lines[1]);
  assert(/qwen3\.8-max×1\(已用尽\)/.test(view.lines[1].split('明细: ')[1]), '明细应带已用尽标记: ' + view.lines[1]);
  assert(/^b: 今天 1\/20 次 \(exhausted\)/.test(view.lines[1]), 'b 排序第二: ' + view.lines[1]);
});

check('$qwen-api usage 渲染：空号池不炸', () => {
  scenario();
  store.load();
  assert.strictEqual(renderUsage(store), '号池是空的');
  assert.deepStrictEqual(store.usageSnapshot(), []);
});

// ---------------------------------------------------------------------------
// 2. chat-adapter：正文配额文案识别
// ---------------------------------------------------------------------------
section('chat-adapter 正文配额识别');

const chatAdapter = require('../src/chat-adapter');

const positives = [
  '今日对话次数已达上限，请明日再来。',
  '今日使用次数已达上限',
  '次数已用完',
  'Your daily limit reached, try tomorrow',
  'Too many requests today, please come back tomorrow',
];
const negatives = [
  '好的，我来帮你写一个 React 组件',
  '今天天气不错，适合出门散步',
  '预计本次对话需要 20 轮左右的往返',
  '今天的任务是重构登录模块',
];

positives.forEach((t) => {
  check(`识别配额文案: ${t.slice(0, 18)}`, () => {
    assert.strictEqual(chatAdapter.isQuotaExhaustedText(t), true);
  });
});
negatives.forEach((t) => {
  check(`不误伤正常回复: ${t.slice(0, 18)}`, () => {
    assert.strictEqual(chatAdapter.isQuotaExhaustedText(t), false);
  });
});

// ---------------------------------------------------------------------------
// 3. qwen-client：错误消息归类
// ---------------------------------------------------------------------------
section('qwen-client isQuotaError');

const qwenClient = require('../src/qwen-client');

[
  ['RateLimited: Account x reached Qwen daily limit', true],
  ['DailyQuotaExhausted: 今日对话次数已达上限', true],
  ['daily limit reached', true],
  ['Qwen session expired (token refresh did not help)', false],
  ['Unexpected status 500', false],
  ['', false],
].forEach(([msg, expected]) => {
  check(`归类: ${JSON.stringify(msg.slice(0, 26))}`, () => {
    assert.strictEqual(qwenClient.isQuotaError(msg), expected);
  });
});

// 清理
fs.rmSync(tmpRoot, { recursive: true, force: true });

// ---------------------------------------------------------------------------
console.log(`\n总计: ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
