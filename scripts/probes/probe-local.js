'use strict';
/**
 * probe-local.js — 打本地代理，看 OpenAI 格式返回。
 * 用法: node probe-local.js [stream|nonstream]
 */
const axios = require('axios');

const mode = process.argv[2] || 'nonstream';
const stream = mode === 'stream';

(async () => {
  const t0 = Date.now();
  const res = await axios.post(
    'http://127.0.0.1:3265/v1/chat/completions',
    {
      model: 'qwen3.8-max',
      stream,
      messages: [{ role: 'user', content: '用三句话介绍乌鲁木齐，每句话一行' }],
    },
    { responseType: stream ? 'stream' : 'json', timeout: 300000, validateStatus: () => true }
  );

  console.log('HTTP', res.status, `${Date.now() - t0}ms`);

  if (!stream) {
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }

  let buf = '';
  const frames = [];
  await new Promise((resolve) => {
    res.data.on('data', (c) => {
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        frames.push(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
    });
    res.data.on('end', resolve);
  });
  console.log(`共 ${frames.length} 帧`);
  let content = '';
  let reasoning = '';
  for (const f of frames) {
    const payload = f.replace(/^data: /, '').trim();
    if (payload === '[DONE]') { console.log('--- [DONE] ---'); continue; }
    let obj;
    try { obj = JSON.parse(payload); } catch (_) { console.log('--- 非 JSON ---', payload.slice(0, 200)); continue; }
    const d = obj.choices && obj.choices[0] && obj.choices[0].delta;
    if (obj.error) console.log('--- ERROR ---', JSON.stringify(obj.error));
    if (d) {
      if (d.reasoning_content) reasoning += d.reasoning_content;
      if (d.content) content += d.content;
      if (obj.choices[0].finish_reason) console.log('--- finish_reason:', obj.choices[0].finish_reason, '| model 字段:', JSON.stringify(obj.model), '---');
    }
  }
  console.log('\n=== reasoning ===\n' + reasoning);
  console.log('\n=== content（原文，含转义）===\n' + JSON.stringify(content));
  console.log('\n=== content（可读）===\n' + content);
})().catch((e) => { console.error('[FATAL]', e.message); process.exit(1); });
