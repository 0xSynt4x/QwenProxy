'use strict';
/**
 * probe-credits.js — 查 Qwen 账号的积分/会员额度（前端走独立域名）。
 *
 * 前端 bundle 里抠出来的信息：
 *   member 服务    : https://sg-member.qwen.com        （WM）
 *   entitlement 服务: https://sg-entitlement.qwen.com  （KM）
 *   积分历史: GET  /api/entitlement/credits/credits/history
 *   会员等级: POST /api/member/level/query
 *   套餐列表: POST /api/member/product/query
 *   订阅查询: POST /api/member/product/subscribe/query
 *
 * 用法: node scripts/probes/probe-credits.js [account-id]
 */
const axios = require('axios');
const config = require('../../src/config');
const accountStore = require('../../src/account-store');
const ssxmodManager = require('../../src/ssxmod-manager');
const { buildHeaders } = require('../../src/qwen-headers');

const MEMBER = 'https://sg-member.qwen.com';
const ENTITLEMENT = 'https://sg-entitlement.qwen.com';

const accountId = process.argv[2] || null;

/** 针对指定 host 重建头：host/origin/referer 都要跟着换。 */
function headersFor(base, account, path) {
  const h = buildHeaders('/c/new-chat', account);
  const host = base.replace('https://', '');
  return {
    ...h,
    host,
    origin: base,
    referer: `${base}${path}`,
    accept: 'application/json, text/plain, */*',
  };
}

async function hit(method, base, path, account, data) {
  const url = base + path;
  const h = headersFor(base, account, path);
  try {
    const res = await axios({
      method,
      url,
      headers: h,
      data,
      timeout: 25000,
      validateStatus: () => true,
    });
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    const isHtml = /^\s*<(!doctype|html)/i.test(body);
    return { status: res.status, body: isHtml ? '(HTML 页面 —— 不是 API 响应)' : body.slice(0, 900) };
  } catch (e) {
    return { status: 'ERR', body: e.message.slice(0, 200) };
  }
}

(async () => {
  ssxmodManager.init();
  accountStore.load();
  const account = accountId ? accountStore.get(accountId) : accountStore.current();
  if (!account) {
    console.error('找不到账号');
    process.exit(1);
  }
  console.log(`账号: ${account.id} (${account.email})\n`);

  const targets = [
    ['GET', ENTITLEMENT, '/api/entitlement/credits/credits/history', undefined],
    ['POST', MEMBER, '/api/member/level/query', {}],
    ['POST', MEMBER, '/api/member/product/query', {}],
    ['POST', MEMBER, '/api/member/product/subscribe/query', {}],
  ];

  for (const [method, base, path, data] of targets) {
    const r = await hit(method, base, path, account, data);
    console.log(`${method.padEnd(5)} ${base}${path}`);
    console.log(`      -> ${r.status}`);
    console.log(`      ${r.body}\n`);
  }
  process.exit(0);
})().catch((e) => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
