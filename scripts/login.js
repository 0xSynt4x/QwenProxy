#!/usr/bin/env node
'use strict';

/**
 * login.js — 保存或刷新 Qwen Chat 账号到 config/accounts/<id>.json。
 *
 * 会打开真浏览器（Playwright）访问 chat.qwen.ai。
 * 传了 --relogin 就不复用旧 token，会等用户重新登录。
 */
const config = require('../src/config');
const accountStore = require('../src/account-store');
const { logger } = require('../src/util');

const args = process.argv.slice(2);
const useManual = args.includes('--manual');
const isRelogin = args.includes('--relogin');
const cookieOnly = args.includes('--cookie-only');
const headless = args.includes('--headless');

const accountArgIdx = args.indexOf('--account');
const accountId = accountArgIdx >= 0 ? args[accountArgIdx + 1] : undefined;

const captchaArgIdx = args.indexOf('--captcha');
const captchaUrl = captchaArgIdx >= 0 ? args[captchaArgIdx + 1] : undefined;

// ---- 手动输入 token ----
if (useManual) {
  console.log(`
=== 手动输入 QWEN TOKEN ===

1. 打开 https://chat.qwen.ai 并登录你的账号。
2. F12 -> Application -> Local Storage -> https://chat.qwen.ai
3. 复制 "token" 这个键的值（JWT，以 eyJ 开头）。

把 token 粘到下面然后回车：
`);
  process.stdout.write('> ');
  const { stdin } = process;
  stdin.setEncoding('utf8');
  let input = '';
  stdin.on('data', (d) => {
    input += d;
    if (input.includes('\n')) {
      const token = input.trim().split('\n').pop().trim();
      if (!token) {
        logger.error('token 是空的。', 'LOGIN');
        process.exit(1);
      }
      accountStore.save({ token, email: accountId || 'manual', cookie: [], savedAt: Date.now() }, accountId);
      logger.info('token 已保存。', 'LOGIN');
      process.exit(0);
    }
  });
  return;
}

let playwright;
try {
  playwright = require('playwright');
} catch (e) {
  logger.error(
    'Playwright 没装。跑：npm i playwright && npx playwright install chromium（或者用 --manual）',
    'LOGIN',
    e
  );
  process.exit(1);
}

(async () => {
  accountStore.load();
  const existingAcc = accountId ? accountStore.get(accountId) : null;
  const initialToken = (existingAcc && !isRelogin) ? existingAcc.token : null;

  logger.info('正在启动浏览器…（如果出现 WAF 滑块，在窗口里过一下）', 'LOGIN');

  const browser = await playwright.chromium.launch({
    headless,
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--lang=en-US'],
  });

  const context = await browser.newContext({
    userAgent: config.USER_AGENT,
    locale: 'en-US',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const page = await context.newPage();

  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('i18nextLng', 'en-US');
      window.localStorage.setItem('lang', 'en-US');
      window.localStorage.setItem('language', 'en-US');
    } catch (_) {}
  });

  // 打开目标页
  const targetUrl = captchaUrl || config.BASE_URL;
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

  // 登录前清掉浏览器里的旧 token，免得抓到上一个账号的
  await page.evaluate(() => {
    try {
      window.localStorage.removeItem('token');
      window.localStorage.removeItem('active_token');
      window.sessionStorage.clear();
    } catch (_) {}
  });

  if (!cookieOnly) {
    logger.info('在打开的浏览器窗口里登录你的 Qwen 账号…', 'LOGIN');
    
    // 等用户登录后出现的新 token
    await page.waitForFunction(
      (oldTok) => {
        const t = window.localStorage.getItem('token') || window.localStorage.getItem('active_token');
        if (!t || t.length < 60) return false;
        if (oldTok && t === oldTok) return false;
        return true;
      },
      initialToken,
      { timeout: 5 * 60 * 1000 }
    );
    // 留两秒让资料请求跑完
    await page.waitForTimeout(2000);
  } else {
    await page.waitForTimeout(4000);
  }

  // 取 token 和真实的邮箱/用户名
  const extracted = await page.evaluate(async () => {
    let tok = window.localStorage.getItem('token') || window.localStorage.getItem('active_token');
    if (!tok) {
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const v = window.localStorage.getItem(window.localStorage.key(i)) || '';
        const m = v.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
        if (m) { tok = m[0]; break; }
      }
    }

    let email = '';
    // 1) 先从 Qwen API 拿资料
    try {
      const res = await fetch('/api/v1/auths/');
      if (res.ok) {
        const data = await res.json();
        email = data.email || data.username || data.user?.email || data.data?.email || data.name || '';
      }
    } catch (_) {}

    // 2) 再从 localStorage 里找邮箱
    if (!email) {
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const k = window.localStorage.key(i) || '';
        const v = window.localStorage.getItem(k) || '';
        if (v.includes('@')) {
          try {
            const obj = JSON.parse(v);
            if (obj.email || obj.username) { email = obj.email || obj.username; break; }
          } catch (_) {
            if (v.includes('@') && !v.includes('{') && v.length < 80) { email = v; break; }
          }
        }
      }
    }

    // 3) 最后解 JWT payload
    if (!email && tok && tok.includes('.')) {
      try {
        const parts = tok.split('.');
        const payload = JSON.parse(atob(parts[1]));
        email = payload.email || payload.preferred_username || payload.user_name || payload.sub || '';
      } catch (_) {}
    }

    return { token: tok, email: email || '' };
  });

  let cookieJar = [];
  try {
    cookieJar = await context.cookies();
  } catch (e) {
    logger.warn('没能取到 cookie: ' + e.message, 'LOGIN');
  }

  if (!extracted.token) {
    logger.error('没找到 token，登录没完成。', 'LOGIN');
    await browser.close();
    process.exit(1);
  }

  const persistable = cookieJar
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

  const finalEmail = extracted.email || (existingAcc && existingAcc.email !== 'user' ? existingAcc.email : null) || accountId || 'qwen-user';

  const saved = accountStore.save(
    {
      token: extracted.token,
      email: finalEmail,
      cookie: persistable,
      savedAt: Date.now(),
      failures: 0,
      unavailableUntil: 0,
      lastError: '',
    },
    accountId
  );

  logger.info(`✅ 成功！账号 [${saved.id}] (${saved.email}) 已保存。`, 'LOGIN');
  await browser.close();
  process.exit(0);
})().catch((e) => {
  logger.error('登录过程出错：' + e.message, 'LOGIN', e);
  process.exit(1);
});
