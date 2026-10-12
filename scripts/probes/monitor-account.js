'use strict';
/**
 * monitor-account.js — 定时探测账号状态，记录 WAF 冷却与配额恢复的时间点。
 *
 * 用途：WAF 是临时封禁（猜约 15 分钟），配额是当日封顶（猜次日恢复）。
 * 本脚本每 N 秒打一次单发请求，只在「状态发生变化」时打印，避免刷屏。
 *
 * 用法:
 *   node scripts/probes/monitor-account.js --account account-2 --interval 75 --minutes 40
 */
const path = require('path');
const config = require('../../src/config');
const accountStore = require('../../src/account-store');
const ssxmodManager = require('../../src/ssxmod-manager');
const { buildHeaders } = require('../../src/qwen-headers');
const { generateUUID } = require('../../src/util');
const axios = require('axios');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const ACCOUNT_ID = arg('account', null);
const INTERVAL_MS = Number(arg('interval', 75)) * 1000;
const MINUTES = Number(arg('minutes', 40));
const MODEL = 'qwen3.8-max';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function classify(raw) {
  const t = String(raw || '');
  if (/FAIL_SYS_USER_VALIDATE|RGV587_ERROR|_____tmd_____/i.test(t)) return 'WAF';
  if (/今日对话次数已达上限/.test(t)) return 'QUOTA';
  if (/"content"/.test(t)) return 'OK';
  return 'OTHER';
}

async function probe(account) {
  const headers = buildHeaders('/c/new-chat', account);
  const chat = await axios.post(
    `${config.BASE_URL}/api/v2/chats/new`,
    { chatId: '', models: [MODEL], project_id: '', timestamp: Date.now(), chat_type: 't2t', chat_mode: 'normal' },
    { headers, timeout: 30000, validateStatus: () => true }
  );
  const chatId = chat.data && chat.data.data && chat.data.data.id;
  if (!chatId) return 'OTHER';

  const payload = {
    stream: true, version: '2.1', incremental_output: true,
    chatId, parentId: '', chat_id: chatId, chat_mode: 'normal',
    model: MODEL, parent_id: null, timestamp: Date.now(),
    messages: [{
      id: null, fid: generateUUID(), parentId: null, childrenIds: [],
      role: 'user', content: '只回答两个字：收到', user_action: 'chat', files: [],
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
    { headers: { ...buildHeaders(`/c/${chatId}`, account), accept: 'text/event-stream' },
      responseType: 'stream', timeout: 120000, validateStatus: () => true }
  );

  let raw = '';
  await new Promise((resolve) => {
    res.data.on('data', (c) => { raw += c.toString('utf8'); });
    res.data.on('end', resolve);
    res.data.on('error', resolve);
  });
  return classify(raw);
}

(async () => {
  ssxmodManager.init();
  accountStore.load();
  const account = ACCOUNT_ID ? accountStore.get(ACCOUNT_ID) : accountStore.current();
  if (!account) { console.error('找不到账号'); process.exit(1); }

  const deadline = Date.now() + MINUTES * 60 * 1000;
  let last = null;
  let n = 0;

  console.log(`=== 监控 ${account.id} (${account.email})，每 ${INTERVAL_MS / 1000}s 一次，共 ${MINUTES} 分钟 ===`);
  console.log(`开始: ${new Date().toLocaleTimeString('en-GB')}`);

  while (Date.now() < deadline) {
    n += 1;
    let state;
    try {
      state = await probe(account);
    } catch (e) {
      state = 'OTHER';
    }
    const ts = new Date().toLocaleTimeString('en-GB');
    if (state !== last) {
      console.log(`[${ts}] #${n}  *** 状态变化: ${last || '(起始)'} -> ${state} ***`);
      last = state;
    } else {
      console.log(`[${ts}] #${n}  ${state}`);
    }
    if (state === 'OK') {
      console.log(`\n>>> ${ts} 账号已恢复（${last} -> OK），共等了 ${n} 次探测。`);
      break;
    }
    await sleep(INTERVAL_MS);
  }
  process.exit(0);
})().catch((e) => { console.error('[FATAL]', e.message); process.exit(1); });
