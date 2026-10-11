// 探针：逐个模型发一句话，看是否被「今日对话次数已达上限」之类限流拦
// 用法: node scripts/probes/probe-models.js
'use strict';
const accountStore = require('../../src/account-store');
const qwen = require('../../src/qwen-client');
const adapter = require('../../src/chat-adapter');

const MODELS = [
  'qwen3.8-max',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
  'qwen3.5-plus',
  'qwen3.5-omni-plus',
  'qwen3.8-omni-flash',
];

(async () => {
  accountStore.load();
  const acc = accountStore.current();
  for (const m of MODELS) {
    try {
      const body = adapter.buildChatBody(null, m, [{ role: 'user', content: '只回答两个字：收到' }], false, '', false, {});
      const r = await qwen.sendChatRequest(body, acc);
      if (!r.status) {
        console.log(`${m.padEnd(20)} FAIL ${r.message}`);
        continue;
      }
      let text = '';
      for await (const chunk of r.response) text += chunk.toString();
      const pieces = [...text.matchAll(/"content":"((?:[^"\\]|\\.){0,60})/g)].map((x) => x[1]);
      const joined = pieces.join('').replace(/\\n/g, '\\n');
      console.log(`${m.padEnd(20)} ${joined.slice(0, 80) || '(empty)  ' + text.slice(0, 150)}`);
    } catch (e) {
      console.log(`${m.padEnd(20)} ERR ${e.message}`);
    }
  }
})();
