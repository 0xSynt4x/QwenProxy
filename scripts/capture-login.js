#!/usr/bin/env node
'use strict';

/**
 * capture-login.js — 稳健版 Qwen 登录抓取。
 *
 * 为什么不用 scripts/login.js：
 *   原脚本用 page.waitForFunction 在页面上下文里读 localStorage，Qwen 现在会
 *   跳转到受限文档（WAF / OAuth 中转页），直接抛
 *   "SecurityError: Failed to read the 'localStorage' property from 'Window'".
 *   本脚本改为「Node 侧轮询 + 每次 evaluate 都 try/catch」，并且用
 *   persistent context 让登录态跨进程存活，遍历所有标签页找 token。
 *
 * 用法: node scripts/capture-login.js [--account <id>]
 */

const path = require('path');
const config = require('../src/config');
const accountStore = require('../src/account-store');

const args = process.argv.slice(2);
const accountArgIdx = args.indexOf('--account');
const accountId = accountArgIdx >= 0 ? args[accountArgIdx + 1] : undefined;

const USER_DATA_DIR = path.join(config.PROJECT_ROOT, '.chrome-profile');
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

const log = (...a) => console.log(`[${new Date().toLocaleTimeString('en-GB')}]`, ...a);

function readTokenFromPage(page) {
  return page
    .evaluate(() => {
      try {
        const direct =
          window.localStorage.getItem('token') ||
          window.localStorage.getItem('active_token');
        if (direct && direct.length > 60) return direct;
        for (let i = 0; i < window.localStorage.length; i += 1) {
          const k = window.localStorage.key(i);
          const v = window.localStorage.getItem(k) || '';
          const m = v.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
          if (m) return m[0];
        }
        return '';
      } catch (_) {
        return '';
      }
    })
    .catch(() => '');
}

(async () => {
  let playwright;
  try {
    playwright = require('playwright');
  } catch (e) {
    log('ERROR: playwright 未安装:', e.message);
    process.exit(1);
  }

  accountStore.load();

  log('启动 Chrome (persistent profile) …');
  log(`profile: ${USER_DATA_DIR}`);
  log('⚠️  请在打开的窗口里登录 Qwen 账号。登录成功后脚本会自动抓取 token。');

  const ctx = await playwright.chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    userAgent: config.USER_AGENT,
    locale: 'en-US',
    viewport: null,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=en-US',
    ],
  });

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(config.BASE_URL, { waitUntil: 'domcontentloaded' }).catch((e) => {
    log('goto warning:', e.message);
  });

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let token = '';
  let sourcePage = null;

  while (Date.now() < deadline) {
    for (const p of ctx.pages()) {
      const t = await readTokenFromPage(p);
      if (t) {
        token = t;
        sourcePage = p;
        break;
      }
    }
    if (token) break;
    await new Promise((r) => setTimeout(r, 2500));
  }

  if (!token) {
    log('❌ 超时：15 分钟内没抓到 token。');
    await ctx.close().catch(() => {});
    process.exit(1);
  }

  log(`✅ 抓到 token（${token.length} 字符，${token.slice(0, 12)}…）`);

  // 尝试拿 email
  let email = '';
  try {
    email = await sourcePage.evaluate(async () => {
      try {
        const res = await fetch('/api/v1/auths/');
        if (res.ok) {
          const d = await res.json();
          return d.email || d.username || (d.user && d.user.email) || (d.data && d.data.email) || '';
        }
      } catch (_) {}
      return '';
    });
  } catch (_) {}
  if (!email) {
    try {
      const parts = token.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
      email = payload.email || payload.preferred_username || payload.user_name || payload.sub || '';
    } catch (_) {}
  }
  if (!email) email = accountId || 'qwen-user';

  const rawCookies = await ctx.cookies().catch(() => []);
  const cookieJar = rawCookies
    .filter((c) => c.value !== null && c.value !== '')
    .filter((c) => c.name !== 'ssxmod_itna' && c.name !== 'ssxmod_itna2')
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
    }));

  const saved = accountStore.save(
    {
      token,
      email,
      cookie: cookieJar,
      savedAt: Date.now(),
      failures: 0,
      unavailableUntil: 0,
      lastError: '',
    },
    accountId
  );

  log(`✅ 账号已保存: [${saved.id}] ${saved.email}  (cookies: ${cookieJar.length})`);
  log(`   文件: config/accounts/${saved.id}.json`);

  await ctx.close().catch(() => {});
  process.exit(0);
})().catch((e) => {
  log('FATAL:', e.message);
  process.exit(1);
});
