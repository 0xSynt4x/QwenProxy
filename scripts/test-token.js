#!/usr/bin/env node
'use strict';

/**
 * test-token.js —— token-manager 的离线自测（不打网络）。
 *
 * 覆盖：
 *   - JWT payload 解码
 *   - exp / 剩余时间 / 是否将过期
 *   - 从响应体或 set-cookie 里抠 token
 *   - 从账号 cookie 数组里找 refresh_token
 *   - setToken 同时更新顶层字段和 cookie 数组里那条
 *
 * 用法：node scripts/test-token.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
// 🔴 账号目录必须在 require 之前指到临时目录：config.js 加载时就快照了
// ACCOUNTS_DIR。setToken 会真落盘，不隔离就会污染真号池。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-token-test-'));
process.env.QWEN_CONFIG_DIR = tmpDir;
const tokenManager = require('../src/token-manager');
const accountStore = require('../src/account-store');
const accountsDir = require('../src/config').ACCOUNTS_DIR;

/** 造一个假的 JWT（只有 payload 有意义，签名随便）。 */
function makeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.fakesignature`;
}

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

console.log('=== decodeJwtPayload ===');
const accessToken = makeJwt({ id: 'u1', exp: 1791750089, iat: 1791749189 });
const refreshToken = makeJwt({ id: 'u1', type: 'refresh_token', exp: 1794341189, iat: 1791749189 });

check('解出 exp', () => {
  const payload = tokenManager.decodeJwtPayload(accessToken);
  assert.strictEqual(payload.exp, 1791750089);
});
check('非 JWT 返回 null', () => {
  assert.strictEqual(tokenManager.decodeJwtPayload('not-a-jwt'), null);
  assert.strictEqual(tokenManager.decodeJwtPayload(undefined), null);
});

console.log('=== getTokenExpiry / getTokenRemainingMs ===');
check('exp 转成毫秒时间戳', () => {
  assert.strictEqual(tokenManager.getTokenExpiry(accessToken), 1791750089 * 1000);
});
check('refresh_token 剩余时间 > access token', () => {
  const a = tokenManager.getTokenRemainingMs(accessToken);
  const r = tokenManager.getTokenRemainingMs(refreshToken);
  assert.ok(r > a, `expected refresh(${r}) > access(${a})`);
});

console.log('=== isTokenExpiring ===');
check('已过期的 token 判定为将过期', () => {
  const expired = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  assert.strictEqual(tokenManager.isTokenExpiring(expired), true);
});
check('剩 30 天的 token 判定为新鲜', () => {
  const fresh = makeJwt({ exp: Math.floor(Date.now() / 1000) + 30 * 86400 });
  assert.strictEqual(tokenManager.isTokenExpiring(fresh), false);
});
check('剩 10 分钟的 token 在默认 1 天阈值下判定为将过期', () => {
  const soon = makeJwt({ exp: Math.floor(Date.now() / 1000) + 600 });
  assert.strictEqual(tokenManager.isTokenExpiring(soon), true);
});
check('读不到 exp 时不误判为过期', () => {
  assert.strictEqual(tokenManager.isTokenExpiring('garbage'), false);
});

console.log('=== extractTokenFromResponse ===');
check('优先取 body.token', () => {
  assert.strictEqual(tokenManager.extractTokenFromResponse({ token: 'body-tok' }, {}), 'body-tok');
});
check('回退到 set-cookie', () => {
  const headers = { 'set-cookie': ['x-ap=cn; Path=/', 'token=cookie-tok; Domain=.qwen.ai; HttpOnly'] };
  assert.strictEqual(tokenManager.extractTokenFromResponse({}, headers), 'cookie-tok');
});
check('都没有返回 null', () => {
  assert.strictEqual(tokenManager.extractTokenFromResponse({}, {}), null);
});

console.log('=== findRefreshTokenInCookies ===');
check('从 cookie 数组里找到 refresh_token', () => {
  const account = { cookie: [{ name: 'acw_tc', value: 'a' }, { name: 'refresh_token', value: refreshToken }] };
  assert.strictEqual(tokenManager.findRefreshTokenInCookies(account), refreshToken);
});
check('没有 refresh_token 返回 null', () => {
  assert.strictEqual(tokenManager.findRefreshTokenInCookies({ cookie: [{ name: 'a', value: 'b' }] }), null);
});

console.log('=== setToken 双写 ===');
check('顶层 token 与 cookie 里的 token 保持一致', () => {
  const account = { id: 'test-account', token: 'old', cookie: [{ name: 'token', value: 'old' }, { name: 'x', value: 'y' }] };
  try {
    accountStore.setToken(account, 'new-token');
    assert.strictEqual(account.token, 'new-token');
    assert.strictEqual(account.cookie.find((c) => c.name === 'token').value, 'new-token');
    assert.strictEqual(account.cookie.find((c) => c.name === 'x').value, 'y', '其它 cookie 不应被改动');
    // 顺便验证双写是真的落了盘
    const saved = JSON.parse(fs.readFileSync(path.join(accountsDir, 'test-account.json'), 'utf8'));
    assert.strictEqual(saved.token, 'new-token', '落盘的顶层 token 也要更新');
    assert.strictEqual(saved.cookie.find((c) => c.name === 'token').value, 'new-token', '落盘的 cookie 也要更新');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log(`\nALL PASS (${passed} checks)`);
