#!/usr/bin/env node
'use strict';
require('dotenv').config();
const axios = require('axios');

const KEY = (process.env.YYDS_API_KEY || '').trim();
if (!KEY) {
  console.error('❌ 缺 YYDS_API_KEY');
  process.exit(1);
}

const http = axios.create({
  baseURL: 'https://maliapi.215.im',
  timeout: 30000,
  proxy: false,
  headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
});

(async () => {
  console.log('🔍 探 215.im 连通性 ...');
  // 1. 域名目录
  try {
    const r = await http.get('/v1/domains');
    const body = r.data && r.data.data ? r.data.data : r.data;
    const doms = (body && body.domains) || [];
    console.log(`✅ GET /v1/domains -> ${doms.length} 个域名`);
    doms.slice(0, 5).forEach((d) => {
      const name = d.domain || d.name;
      const wc = d.dnsRecords && d.dnsRecords.wildcardMxValid;
      console.log(`     - ${name}${wc ? ' (wildcard)' : ''}  public=${d.public} ready=${d.ready} mx=${d.isMxValid}`);
    });
  } catch (e) {
    console.error('❌ 域名目录失败:', e.response?.status, e.response?.data || e.message);
    process.exit(1);
  }

  // 2. 建一个测试邮箱
  console.log('\n📧 试建一个邮箱 ...');
  try {
    const r = await http.post('/v1/accounts', {});
    const body = r.data && r.data.data ? r.data.data : r.data;
    const email = body && (body.address || body.email);
    const id = body && body.id;
    const token = body && body.token;
    console.log(`✅ 创建成功: ${email}  id=${id || '-'}  tokenLen=${token ? token.length : 0}`);
  } catch (e) {
    console.error('❌ 建邮箱失败:', e.response?.status, e.response?.data || e.message);
  }
})();
