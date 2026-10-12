'use strict';
/**
 * probe-renew.js — 用账号 cookie 里的 refresh_token 换一个新的 access token。
 *
 * 背景：access token 只有 15 分钟寿命，refresh_token 有 30 天。
 *   正规换发接口是 GET /api/v1/auths/，带 Bearer <refresh_token> 打过去，
 *   响应体里回新 token。
 *
 * 什么时候需要手动跑它：
 *   - 账号文件是「刚登录、还没重启服务」的状态（refreshToken 字段为空），
 *     access token 已经过期 → 代理会一直 401。
 *
 * 用法:
 *   node scripts/probes/probe-renew.js account-2           # 只看结果，不落盘
 *   node scripts/probes/probe-renew.js account-2 --save    # 换到新 token 并写回账号文件
 */
const axios = require('axios');
const config = require('../../src/config');
const accountStore = require('../../src/account-store');
const ssxmodManager = require('../../src/ssxmod-manager');
const tokenManager = require('../../src/token-manager');
const { buildHeaders } = require('../../src/qwen-headers');

const argv = process.argv.slice(2);
const ACCOUNT_ID = argv.find((a) => !a.startsWith('--')) || null;
const SAVE = argv.includes('--save');

(async () => {
  ssxmodManager.init();
  accountStore.load();

  const account = ACCOUNT_ID ? accountStore.get(ACCOUNT_ID) : accountStore.current();
  if (!account) {
    console.error(`找不到账号: ${ACCOUNT_ID || '(current)'}`);
    process.exit(1);
  }

  const fromCookie = tokenManager.findRefreshTokenInCookies(account);
  const bearer = account.refreshToken || fromCookie || account.token;

  console.log(`账号        : ${account.id}  (${account.email})`);
  console.log(`refreshToken 字段: ${account.refreshToken ? `有 (${account.refreshToken.length})` : '空'}`);
  console.log(`cookie 里     : ${fromCookie ? `有 (${fromCookie.length})` : '无'}`);
  const curExp = tokenManager.getTokenExpiry(account.token);
  console.log(`当前 token 剩余: ${curExp ? Math.round((curExp - Date.now()) / 1000) + 's' : '未知'}`);
  console.log('');

  if (!bearer) {
    console.error('没有任何可用凭据，必须重新登录。');
    process.exit(1);
  }

  const res = await axios.get(`${config.BASE_URL}/api/v1/auths/`, {
    headers: { ...buildHeaders('/c/new-chat', account), authorization: `Bearer ${bearer}` },
    timeout: 30000,
    validateStatus: () => true,
  });

  console.log(`GET /api/v1/auths/  ->  HTTP ${res.status}`);
  const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  console.log(`  body: ${body.slice(0, 300)}`);

  const fresh = tokenManager.extractTokenFromResponse(res.data, res.headers);
  if (!fresh) {
    console.log('\n❌ 没换到新 token。');
    process.exit(1);
  }

  const exp = tokenManager.getTokenExpiry(fresh);
  console.log(`\n✅ 换到新 token（${fresh.length} 字符）`);
  console.log(`   剩余: ${exp ? (Math.round((exp - Date.now()) / 1000 / 864) / 100).toFixed(2) + ' 天' : '未知'}`);
  console.log(`   与当前 token ${fresh === account.token ? '相同' : '不同'}`);

  if (SAVE) {
    accountStore.setToken(account, fresh);
    if (fromCookie && account.refreshToken !== fromCookie) {
      account.refreshToken = fromCookie;
      accountStore.persistAccount(account);
    }
    console.log(`\n💾 已写回 config/accounts/${account.id}.json`);
  } else {
    console.log('\n（加 --save 才会写回账号文件）');
  }
  process.exit(0);
})().catch((e) => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
