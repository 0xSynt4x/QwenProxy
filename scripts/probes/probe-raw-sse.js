'use strict';
/**
 * probe-raw-sse.js — 把上游 Qwen 的原始 SSE 逐帧打出来，用于定位
 * 「正文混换行 / model 字段空」这类问题到底是上游给的还是代理改的。
 *
 * 用法: node scripts/probes/probe-raw-sse.js "你的问题"
 */
const axios = require('axios');
const config = require('../../src/config');
const accountStore = require('../../src/account-store');
const ssxmodManager = require('../../src/ssxmod-manager');
const { buildHeaders } = require('../../src/qwen-headers');
const { generateUUID } = require('../../src/util');

const question = process.argv[2] || '用一句话介绍乌鲁木齐';

(async () => {
  ssxmodManager.init();
  accountStore.load();
  const account = accountStore.current();
  const model = 'qwen3.8-max';

  const chat = await axios.post(
    `${config.BASE_URL}/api/v2/chats/new`,
    { chatId: '', models: [model], project_id: '', timestamp: Date.now(), chat_type: 't2t', chat_mode: 'normal' },
    { headers: buildHeaders('/c/new-chat', account), timeout: 30000 }
  );
  const chatId = chat.data.data.id;
  console.log('[chat_id]', chatId);

  const payload = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chatId,
    parentId: '',
    chat_id: chatId,
    chat_mode: 'normal',
    model,
    parent_id: null,
    timestamp: Date.now(),
    messages: [{
      id: null,
      fid: generateUUID(),
      parentId: null,
      childrenIds: [],
      role: 'user',
      content: question,
      user_action: 'chat',
      files: [],
      timestamp: Date.now(),
      models: [model],
      model: '',
      chat_type: 't2t',
      feature_config: {
        thinking_enabled: false,
        output_schema: 'phase',
        research_mode: 'normal',
        auto_thinking: false,
        thinking_mode: 'Auto',
        thinking_format: 'summary',
        auto_search: false,
      },
      extra: { meta: { subChatType: 't2t' } },
      sub_chat_type: 't2t',
      parent_id: null,
    }],
  };

  const res = await axios.post(
    `${config.BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`,
    payload,
    { headers: buildHeaders(`/c/${chatId}`, account), responseType: 'stream', timeout: 10 * 60 * 1000 }
  );

  let n = 0;
  let buf = '';
  res.data.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const t = line.trim();
      if (!t) continue;
      n += 1;
      console.log(`--- frame ${n} (${t.length} chars) ---`);
      console.log(t.length > 2000 ? t.slice(0, 2000) + ' …[truncated]' : t);
    }
  });
  res.data.on('end', () => { console.log(`\n[END] 共 ${n} 帧`); process.exit(0); });
  res.data.on('error', (e) => { console.error('[ERR]', e.message); process.exit(1); });
})().catch((e) => { console.error('[FATAL]', e.message, e.response ? JSON.stringify(e.response.data).slice(0, 500) : ''); process.exit(1); });
