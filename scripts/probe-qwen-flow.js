#!/usr/bin/env node
'use strict';
/**
 * probe-qwen-flow.js — 只测 215.im → Qwen 投递 + 验证码提取。
 * 不开浏览器。给我诊断结论：域名能不能收信、Qwen 邮件格式是什么。
 */
require('dotenv').config();
const axios = require('axios');

const KEY = (process.env.YYDS_API_KEY || '').trim();
if (!KEY) { console.error('❌ 缺 YYDS_API_KEY'); process.exit(1); }

const http = axios.create({
  baseURL: 'https://maliapi.215.im',
  timeout: 30_000,
  proxy: false,
  headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
});

const STRIP_HTML = (s) => !s ? '' : s.replace(/<(style|script)[^>]*>.*?<\/\1>/gis, ' ').replace(/<[^>]+>/g, ' ');
const CODE_RE = /(?<!\d)(\d{6,8})(?!\d)/g;

function extractAllCodes(text) {
  const clean = STRIP_HTML(text || '');
  return clean.match(CODE_RE) || [];
}

(async () => {
  // 1. 建一个邮箱
  const r1 = await http.post('/v1/accounts', {});
  const body = r1.data && r1.data.data ? r1.data.data : r1.data;
  const email = body.address || body.email;
  const id = body.id;
  const token = body.token;
  console.log('✅ 建邮箱:', email);
  console.log('   id:', id);
  console.log('   token 长度:', token ? token.length : 0);

  // 2. 让用户去 chat.qwen.ai 提交这个邮箱（人工步骤）
  console.log('\n⏸  现在去浏览器打开 https://chat.qwen.ai 注册页');
  console.log('   把这邮箱填进去、点 Send Code、看到验证页就回来。');
  console.log('   邮箱: ' + email);
  console.log('\n⏳ 我现在每 5s 拉一次收件箱，收到验证码就退出。');
  console.log('   按 Ctrl+C 也能停。\n');

  // 3. 轮询 5 分钟
  const deadline = Date.now() + 5 * 60_000;
  let lastCount = 0;
  while (Date.now() < deadline) {
    try {
      const params = { address: email, limit: 20 };
      const headers = token ? { Authorization: `Bearer ${token}` } : { 'X-API-Key': KEY };
      const r2 = await http.get('/v1/messages', { params, headers });
      const b2 = r2.data && r2.data.data ? r2.data.data : r2.data;
      const msgs = (b2 && (b2.messages || b2.items)) || [];
      if (msgs.length > lastCount) {
        console.log(`📬 收件箱新增 ${msgs.length - lastCount} 封（共 ${msgs.length}）`);
        lastCount = msgs.length;
        for (const m of msgs) {
          console.log('\n--- 邮件 ---');
          console.log('subject :', m.subject);
          console.log('from    :', m.from_address || m.from || m.sender);
          console.log('text    :', (m.text || m.textBody || '').slice(0, 200));
          console.log('html前300:', (m.html || m.htmlBody || '').slice(0, 300));
          const codes = extractAllCodes([m.subject, m.text, m.textBody, m.html, m.htmlBody, m.body, m.bodyPreview].join('\n'));
          if (m.verificationCode) console.log('🎯 verificationCode 字段:', m.verificationCode);
          console.log('🎯 提取到的码:', codes);
        }
        if (msgs.length) {
          console.log('\n✅ 至少收到 1 封了 — 这号能收 Qwen 信、码能提。');
          process.exit(0);
        }
      }
    } catch (e) {
      console.log('  拉件失败:', e.response?.status || '', e.message);
    }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 5000));
  }
  console.log('\n⏰ 5 分钟没收到，域名可能 Qwen 不投递。换域名加 YYDS_DOMAIN= 重跑。');
})();
