'use strict';
/**
 * probe-quota.js — 受控实验：区分「WAF 风控」与「每日对话配额」。
 *
 * 背景：2026-10-12 旧账号（account-1）在连打探针后开始报
 *   {"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试"], ...}
 * 同时期还出现过正文「今日对话次数已达上限，请明日再来。」。
 * 两者是不同现象，本脚本负责干净地把它们区分开。
 *
 * 三种响应形态（本脚本会自动分类）：
 *   OK        —— 正常 SSE，有 content
 *   QUOTA     —— 上游回正文「今日对话次数已达上限」
 *   WAF       —— 上游回 RGV587_ERROR / FAIL_SYS_USER_VALIDATE（JSON 而非 SSE）
 *   OTHER     —— 其它（网络错误、未知 body）
 *
 * 用法:
 *   node scripts/probes/probe-quota.js --account account-2 --mode baseline
 *   node scripts/probes/probe-quota.js --account account-2 --mode rate --count 20 --gap 0
 *   node scripts/probes/probe-quota.js --account account-2 --mode quota --max 100
 *   node scripts/probes/probe-quota.js --account account-2 --mode single
 */
const axios = require('axios');
const config = require('../../src/config');
const accountStore = require('../../src/account-store');
const ssxmodManager = require('../../src/ssxmod-manager');
const { buildHeaders } = require('../../src/qwen-headers');
const { generateUUID } = require('../../src/util');

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const ACCOUNT_ID = arg('account', null);
const MODE = arg('mode', 'single');
const COUNT = Number(arg('count', 10));
const GAP_MS = Number(arg('gap', 0));
const MAX = Number(arg('max', 60));
const MODEL = arg('model', 'qwen3.8-max');
const PROMPT = arg('prompt', '只回答两个字：收到');
const DUMP = argv.includes('--dump');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 分类 ----------
function classify(status, contentType, raw) {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw || '');
  if (/FAIL_SYS_USER_VALIDATE|RGV587_ERROR|_____tmd_____|x5secdata/i.test(text)) {
    return { kind: 'WAF', detail: text.slice(0, 160) };
  }
  if (/今日对话次数已达上限|次数已达上限/.test(text)) {
    return { kind: 'QUOTA', detail: '今日对话次数已达上限' };
  }
  if (status !== 200) {
    return { kind: 'OTHER', detail: `HTTP ${status}: ${text.slice(0, 160)}` };
  }
  return { kind: 'OK', detail: '' };
}

/** 发一次对话，返回分类结果 + 拿到的正文。 */
async function sendOnce(account, prompt) {
  const headers = buildHeaders('/c/new-chat', account);
  const chat = await axios.post(
    `${config.BASE_URL}/api/v2/chats/new`,
    { chatId: '', models: [MODEL], project_id: '', timestamp: Date.now(), chat_type: 't2t', chat_mode: 'normal' },
    { headers, timeout: 30000, validateStatus: () => true }
  );
  if (chat.status !== 200 || !chat.data || !chat.data.data || !chat.data.data.id) {
    return { kind: 'OTHER', detail: `chats/new HTTP ${chat.status}: ${JSON.stringify(chat.data).slice(0, 140)}`, content: '' };
  }
  const chatId = chat.data.data.id;

  const payload = {
    stream: true, version: '2.1', incremental_output: true,
    chatId, parentId: '', chat_id: chatId, chat_mode: 'normal',
    model: MODEL, parent_id: null, timestamp: Date.now(),
    messages: [{
      id: null, fid: generateUUID(), parentId: null, childrenIds: [],
      role: 'user', content: prompt, user_action: 'chat', files: [],
      timestamp: Date.now(), models: [MODEL], model: '', chat_type: 't2t',
      feature_config: {
        thinking_enabled: false, output_schema: 'phase', research_mode: 'normal',
        auto_thinking: false, thinking_mode: 'Auto', thinking_format: 'summary', auto_search: false,
      },
      extra: { meta: { subChatType: 't2t' } },
      sub_chat_type: 't2t', parent_id: null,
    }],
  };

  const res = await axios.post(
    `${config.BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`,
    payload,
    {
      headers: { ...buildHeaders(`/c/${chatId}`, account), accept: 'text/event-stream' },
      responseType: 'stream', timeout: 120000, validateStatus: () => true,
    }
  );

  const ct = String(res.headers['content-type'] || '');
  let raw = '';
  let content = '';
  await new Promise((resolve) => {
    res.data.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      raw += s;
      // 从 SSE 里抽 content
      for (const line of s.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        try {
          const obj = JSON.parse(t.slice(5).trim());
          const d = obj.choices && obj.choices[0] && obj.choices[0].delta;
          if (d && d.content) content += d.content;
        } catch (_) {}
      }
    });
    res.data.on('end', resolve);
    res.data.on('error', resolve);
  });

  const cls = classify(res.status, ct, raw);
  return { ...cls, content, raw, chatId, status: res.status, contentType: ct };
}

// ---------- 主流程 ----------
(async () => {
  ssxmodManager.init();
  accountStore.load();

  const account = ACCOUNT_ID ? accountStore.get(ACCOUNT_ID) : accountStore.current();
  if (!account) {
    console.error(`找不到账号: ${ACCOUNT_ID || '(current)'}`);
    process.exit(1);
  }

  const all = accountStore.list();
  console.log('=== 实验环境 ===');
  console.log(`账号     : ${account.id}  (${account.email})`);
  console.log(`全部账号 : ${all.map((a) => a.id).join(', ')}`);
  console.log(`模型     : ${MODEL}`);
  console.log(`模式     : ${MODE}`);
  console.log(`时间     : ${new Date().toISOString()}`);
  console.log('');

  const results = [];
  const record = (label, r) => {
    results.push(r.kind);
    const tag = r.kind.padEnd(6);
    const extra = r.kind === 'OK' ? `content=${JSON.stringify((r.content || '').slice(0, 40))}` : r.detail.slice(0, 110);
    console.log(`${label}  ${tag}  ${extra}`);
    if (DUMP && r.raw && r.kind !== 'OK') {
      console.log('     --- 原始响应 (content-type: ' + r.contentType + ') ---');
      console.log(r.raw.split('\n').slice(0, 12).map((l) => '     ' + l.slice(0, 300)).join('\n'));
      console.log('     --- 原始响应结束 ---');
    }
  };

  if (MODE === 'single' || MODE === 'baseline') {
    console.log('=== 单次基线：新账号第一次请求能否成功 ===');
    const r = await sendOnce(account, PROMPT);
    record('[1]', r);
  } else if (MODE === 'rate') {
    console.log(`=== 连打测试：${COUNT} 次，间隔 ${GAP_MS}ms（看第几次开始触发 WAF）===`);
    for (let i = 1; i <= COUNT; i += 1) {
      try {
        const r = await sendOnce(account, `${PROMPT}（第 ${i} 次）`);
        record(`[${i}]`, r);
        if (r.kind === 'WAF') {
          console.log(`\n>>> 第 ${i} 次触发 WAF，停止。`);
          break;
        }
      } catch (e) {
        record(`[${i}]`, { kind: 'OTHER', detail: e.message });
      }
      if (GAP_MS > 0) await sleep(GAP_MS);
    }
  } else if (MODE === 'quota') {
    console.log(`=== 配额探测：连续发到出现 QUOTA 或 WAF，上限 ${MAX} 次，间隔 ${GAP_MS}ms ===`);
    for (let i = 1; i <= MAX; i += 1) {
      try {
        const r = await sendOnce(account, `${PROMPT}（第 ${i} 次）`);
        record(`[${i}]`, r);
        if (r.kind === 'WAF' || r.kind === 'QUOTA') {
          console.log(`\n>>> 第 ${i} 次命中 ${r.kind}，停止。`);
          break;
        }
      } catch (e) {
        record(`[${i}]`, { kind: 'OTHER', detail: e.message });
      }
      if (GAP_MS > 0) await sleep(GAP_MS);
    }
  }

  // ---------- 汇总 ----------
  const tally = results.reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {});
  console.log('\n=== 汇总 ===');
  console.log('总请求数 :', results.length);
  for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(6)}: ${v}`);
  process.exit(0);
})().catch((e) => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
