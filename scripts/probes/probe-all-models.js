'use strict';
/**
 * probe-all-models.js — 对账号把 7 个模型各打一发，看每个模型的配额状态。
 *
 * 用途：验证「每日配额是按模型算的，还是按账号算的」。
 *   2026-10-12 实测：account-1 的 qwen3.8-max 已 QUOTA，同一时刻其余 6 个模型全部 OK
 *   ⇒ 配额是按模型算的。
 *
 * 用法:
 *   node scripts/probes/probe-all-models.js account-1
 */
const path = require('path');
const axios = require('axios');
const config = require('../../src/config');
const accountStore = require('../../src/account-store');
const ssxmodManager = require('../../src/ssxmod-manager');
const { buildHeaders } = require('../../src/qwen-headers');
const { generateUUID } = require('../../src/util');

const MODELS = [
  'qwen3.8-max',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
  'qwen3.5-plus',
  'qwen3.8-omni-flash',
  'qwen3.5-omni-plus',
];

const ACCOUNT_ID = process.argv[2] || null;

function classify(raw) {
  const t = String(raw || '');
  if (/FAIL_SYS_USER_VALIDATE|RGV587_ERROR|_____tmd_____|x5secdata/i.test(t)) return 'WAF';
  if (/今日对话次数已达上限|次数已达上限/.test(t)) return 'QUOTA';
  if (/"content"/.test(t)) return 'OK';
  return 'OTHER';
}

async function sendOnce(account, model) {
  const headers = buildHeaders('/c/new-chat', account);
  const chat = await axios.post(
    `${config.BASE_URL}/api/v2/chats/new`,
    { chatId: '', models: [model], project_id: '', timestamp: Date.now(), chat_type: 't2t', chat_mode: 'normal' },
    { headers, timeout: 30000, validateStatus: () => true }
  );
  const chatId = chat.data && chat.data.data && chat.data.data.id;
  if (!chatId) return 'OTHER';

  const payload = {
    stream: true, version: '2.1', incremental_output: true,
    chatId, parentId: '', chat_id: chatId, chat_mode: 'normal',
    model, parent_id: null, timestamp: Date.now(),
    messages: [{
      id: null, fid: generateUUID(), parentId: null, childrenIds: [],
      role: 'user', content: '只回答两个字：收到', user_action: 'chat', files: [],
      timestamp: Date.now(), models: [model], model: '', chat_type: 't2t',
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

  console.log(`账号 ${account.id} (${account.email})  模型逐个体检  ${new Date().toISOString()}`);
  const tally = {};
  for (const m of MODELS) {
    let kind;
    try { kind = await sendOnce(account, m); } catch (e) { kind = 'OTHER'; }
    tally[kind] = (tally[kind] || 0) + 1;
    console.log(`  ${m.padEnd(20)} ${kind}`);
    await new Promise((r) => setTimeout(r, 1200));
  }
  console.log('汇总: ' + Object.entries(tally).map(([k, v]) => `${k}=${v}`).join('  '));
  process.exit(0);
})().catch((e) => { console.error('[FATAL]', e.message); process.exit(1); });
