'use strict';
/**
 * probe-credits2.js — 带完整参数与鉴权再试积分接口。
 *
 * 从 main.js 抠出的要点：
 *   - member/entitlement 走独立域名，请求带查询参数
 *     biz_id=ai_qwen & chat_client=h5 & device=pc & fr=pc & pr=qwen-i18n
 *     & la=<locale> & tz=<timezone> & wv=0.3.16
 *   - 头：Version / source / Admin-Enhancing-Security / X-Request-Id / Timezone
 *   - 鉴权：Authorization: Bearer <access token>（没 token 时改用 x-umid）
 *   - source 在网页端是 "web"
 */
const axios = require('axios');
const config = require('../../src/config');
const accountStore = require('../../src/account-store');
const ssxmodManager = require('../../src/ssxmod-manager');
const { buildHeaders } = require('../../src/qwen-headers');

const MEMBER = 'https://sg-member.qwen.com';
const ENTITLEMENT = 'https://sg-entitlement.qwen.com';

const accountId = process.argv[2] || null;
const useRefresh = process.argv.includes('--refresh');

function headersFor(base, account, path) {
  const h = buildHeaders('/c/new-chat', account);
  const host = base.replace('https://', '');
  const bearer = useRefresh ? (account.refreshToken || account.token) : account.token;
  return {
    ...h,
    host,
    origin: base,
    referer: `${base}/`,
    accept: 'application/json, text/plain, */*',
    authorization: `Bearer ${bearer}`,
    version: '0.3.16',
    source: 'web',
    'x-request-id': require('../../src/util').generateUUID(),
    timezone: new Date().toString().replace(/\s*\(.+\)$/, ''),
  };
}

const QS = {
  biz_id: 'ai_qwen',
  chat_client: 'h5',
  device: 'pc',
  fr: 'pc',
  pr: 'qwen-i18n',
  la: 'zh-CN',
  tz: 'Asia/Shanghai',
  wv: '0.3.16',
};

async function hit(method, base, path, account, data) {
  try {
    const res = await axios({
      method,
      url: base + path,
      headers: headersFor(base, account, path),
      params: QS,
      data,
      timeout: 25000,
      validateStatus: () => true,
    });
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    const isHtml = /^\s*<(!doctype|html)/i.test(body);
    return { status: res.status, body: isHtml ? '(HTML)' : body.slice(0, 1200) };
  } catch (e) {
    return { status: 'ERR', body: e.message.slice(0, 200) };
  }
}

(async () => {
  ssxmodManager.init();
  accountStore.load();
  const account = accountId ? accountStore.get(accountId) : accountStore.current();
  if (!account) { console.error('找不到账号'); process.exit(1); }
  console.log(`账号: ${account.id}  凭据: ${useRefresh ? 'refresh_token' : 'access token'}\n`);

  const targets = [
    ['GET', ENTITLEMENT, '/api/entitlement/credits/credits/history', undefined],
    ['POST', MEMBER, '/api/member/level/query', {}],
    ['POST', MEMBER, '/api/member/product/subscribe/query', {}],
  ];
  for (const [method, base, path, data] of targets) {
    const r = await hit(method, base, path, account, data);
    console.log(`${method} ${base}${path}`);
    console.log(`   -> ${r.status}  ${r.body}\n`);
  }
  process.exit(0);
})().catch((e) => { console.error('[FATAL]', e.message); process.exit(1); });
