// 探针：检查 content / reasoning_content 里是否混入凭空换行
// 用法: node probe-content.js
'use strict';
const axios = require('axios');

const BODY = {
  model: 'qwen3.8-max',
  stream: false,
  messages: [
    {
      role: 'user',
      content:
        '请用一段连续的话介绍乌鲁木齐，要求：绝对不要换行，不要用任何 markdown 标记、不要用列表、不要用加粗，就是一大段纯文字。',
    },
  ],
};

(async () => {
  const t0 = Date.now();
  const res = await axios.post('http://127.0.0.1:3265/v1/chat/completions', BODY, {
    headers: { 'content-type': 'application/json' },
    timeout: 120000,
  });
  const msg = res.data.choices[0].message;
  console.log(`耗时 ${Date.now() - t0}ms  model=${JSON.stringify(res.data.model)}`);
  console.log('--- content ---');
  console.log(JSON.stringify(msg.content));
  console.log('content 里换行数 =', (msg.content.match(/\n/g) || []).length);
  console.log('--- reasoning_content ---');
  console.log(JSON.stringify(msg.reasoning_content));
  console.log('reasoning 里换行数 =', ((msg.reasoning_content || '').match(/\n/g) || []).length);
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
