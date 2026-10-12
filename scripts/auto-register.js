#!/usr/bin/env node
'use strict';

/**
 * auto-register.js — 自动注册 chat.qwen.ai + 落进 QwenProxy 多账号池。
 *
 * 流程：
 *   1. 调 215.im (YYDS Mail) API 申请一个临时邮箱
 *   2. Playwright headed 打开 chat.qwen.ai 注册页，填邮箱、提交
 *   3. 轮询 215.im 收件箱抓验证码
 *   4. 把验证码填进表单
 *   5. 登录态稳定后读 localStorage token + cookie jar
 *   6. 调 accountStore.save() 写到 config/accounts/reg-N.json
 *
 * 用法：
 *   node scripts/auto-register.js            # 跑 1 个号
 *   node scripts/auto-register.js --num=3    # 跑 3 个号（并发，默认间隔 5s 错峰）
 *   node scripts/auto-register.js --num=1 --email-prefix=hn
 *   node scripts/auto-register.js --num=10 --concurrency=5 --delay=8000
 *   node scripts/auto-register.js --num=3 --no-validate   # 跳过注册后验证
 *
 * 账号 id：永远是 reg-N，N 从「现有号池里最大的 reg-N + 1」开始续，
 *         不会覆盖已有账号（跑完池子里会多出 reg-6、reg-7 ...）。
 *         某个号注册失败也会占掉那个编号，下次接着往下走。
 *
 * 依赖：项目里 playwright 是 optionalDependencies，puppeteer 是主依赖。
 *       这里用 playwright（跟 capture-login.js 风格一致）。
 */

require('dotenv').config();

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const accountStore = require('../src/account-store');
const config = require('../src/config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 注册后验证：拿刚抓到的 token 打一发 GET /api/v1/auths/。
 * 200 = token 真能用；401/403 = 坏号；其它 = 上游抖动。
 * 注意：这个接口不进对话配额，随便打不耗每天 20 次。
 */
async function validateToken(token) {
  const { data, status } = await axios.get(`${config.BASE_URL}/api/v1/auths/`, {
    headers: { authorization: `Bearer ${token}`, 'user-agent': config.USER_AGENT },
    timeout: 20000,
    proxy: false,
    validateStatus: () => true,
  });
  if (status === 200) return { ok: true, email: (data && (data.email || data.username)) || '' };
  if (status === 401 || status === 403) return { ok: false, reason: `auth rejected (HTTP ${status})` };
  return { ok: false, reason: `unexpected HTTP ${status}: ${JSON.stringify(data).slice(0, 120)}` };
}

// ============================================================================
// 参数解析
// ============================================================================
const args = process.argv.slice(2);
const num = Number(
  (args.find((a) => a.startsWith('--num=')) || '').split('=')[1] ||
    process.env.AUTO_REGISTER_COUNT ||
    1
);
// 并发几个号同时注册。默认 3 —— Cloudflare 滑块只能人工过，一次多开几个窗口
// 就能一次性把这一批全点完，比串行快 N 倍。
const concurrency = Math.max(
  1,
  Number(
    (args.find((a) => a.startsWith('--concurrency=')) || '').split('=')[1] ||
      process.env.AUTO_REGISTER_CONCURRENCY ||
      3
  )
);
// 串行模式（跑一个成一个再跑下一个），调试时用
const serial = args.includes('--serial') || process.env.AUTO_REGISTER_SERIAL === '1';
const emailPrefix =
  (args.find((a) => a.startsWith('--email-prefix=')) || '').split('=')[1] || 'qwen';
// 每个号开工前的批次间隔（毫秒），避免 N 个窗口同时砸建箱/发码接口撞 WAF。
// 默认 5000：并发 3 时三个号错开 0/5/10s 起跑；串行时每两号之间歇这么久。
const delayMs = Math.max(
  0,
  Number(
    (args.find((a) => a.startsWith('--delay=')) || '').split('=')[1] ||
      process.env.AUTO_REGISTER_DELAY_MS ||
      5000
  )
);
// 注册成功后是否打一发 /api/v1/auths/ 验证 token 真能用（不耗每日对话配额）。
// --no-validate 或 AUTO_REGISTER_VALIDATE=0 可关掉（纯离线调试时用）。
const validate =
  !args.includes('--no-validate') && process.env.AUTO_REGISTER_VALIDATE !== '0';
// 本次运行日志落盘（默认 logs/auto-register-<时间戳>.log），成功/失败逐行记，
// 方便断点续跑：失败的 reg-N 下次直接 --num 补，不用翻控制台。
const logFileArg = (args.find((a) => a.startsWith('--log-file=')) || '').split('=')[1] || '';

// 本次运行的日志文件：控制台照常打印，同时逐行落盘，跑完尾部追加 JSON 汇总。
// 放 logs/ 下，.gitignore 已排除（备份仓库不进日志）。
const runStamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const logFile = logFileArg || path.join(config.PROJECT_ROOT, 'logs', `auto-register-${runStamp}.log`);
let logStream = null;
function logLine(line = '') {
  console.log(line);
  try {
    if (!logStream) {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      logStream = fs.createWriteStream(logFile, { flags: 'a' });
    }
    logStream.write(`${line}\n`);
  } catch (_) {}
}

// 注册窗口视口。640x480 够填邮箱+验证码了，大了几个窗口互相遮成全屏，
// 人工点 CF 滑块时根本找不着目标窗口。
const VIEWPORT = { width: 640, height: 480 };
// ============================================================================
// 215.im / YYDS Mail 客户端
// ============================================================================

// ============================================================================
// 215.im / YYDS Mail 客户端
// ============================================================================
const YYDS_BASE = 'https://maliapi.215.im';
const YYDS_KEY = (process.env.YYDS_API_KEY || '').trim();
const YYDS_DOMAIN = (process.env.YYDS_DOMAIN || '').trim();

if (!YYDS_KEY || !YYDS_KEY.startsWith('AC-')) {
  console.error('❌ 缺 .env 里的 YYDS_API_KEY（应 AC- 开头）。');
  process.exit(1);
}

const http = axios.create({
  baseURL: YYDS_BASE,
  timeout: 30_000,
  // 215.im 国内站，强制直连不走代理
  proxy: false,
  headers: { 'X-API-Key': YYDS_KEY, 'Content-Type': 'application/json' },
});

async function yydsListDomains() {
  try {
    const { data } = await http.get('/v1/domains');
    const body = data && data.data ? data.data : data;
    const doms = (body && body.domains) || [];
    const ok = doms.filter((d) => {
      if (!d || d.public === false || d.isPublic === false) return false;
      if (d.ready === false || d.isVerified === false) return false;
      if (d.isMxValid === false) return false;
      const dns = d.dnsRecords || {};
      if (dns.receivingReady === false) return false;
      return Boolean(d.domain || d.name);
    });
    return ok.map((d) => ({
      name: d.domain || d.name,
      wildcard: Boolean((d.dnsRecords || {}).wildcardMxValid || d.wildcardMxValid),
    }));
  } catch (e) {
    console.error('⚠️  list domains 失败:', e.response?.data || e.message);
    return [];
  }
}

function pickDomain(domains, exclude = new Set()) {
  const avail = domains.filter((d) => !exclude.has(d.name.toLowerCase()));
  if (!avail.length) return null;
  // exact-domain 信誉比 wildcard 好，优先用
  const exact = avail.filter((d) => !d.wildcard);
  const pool = exact.length ? exact : avail;
  return pool[Math.floor(Math.random() * pool.length)].name;
}

async function yydsCreateMailbox(localPart, domain) {
  const payload = {};
  if (localPart) payload.localPart = localPart;
  if (domain) payload.domain = domain;

  // 失败一次（shared domain 锁了）就自动换
  const tried = new Set();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (domain) tried.add(domain.toLowerCase());
    try {
      const { data } = await http.post('/v1/accounts', payload);
      const body = data && data.data ? data.data : data;
      if (!body || !(body.address || body.email)) {
        throw new Error(`返回异常: ${JSON.stringify(data).slice(0, 200)}`);
      }
      return {
        id: body.id || body.inboxId || body.accountId || '',
        email: body.address || body.email,
        token: body.token || body.tempToken || '',
      };
    } catch (e) {
      const status = e.response?.status;
      const bodyText = JSON.stringify(e.response?.data || e.message).slice(0, 200);
      if (status === 403 && /shared domain/i.test(bodyText) && !YYDS_DOMAIN) {
        // 换域名重试
        const fresh = await yydsListDomains();
        const next = pickDomain(fresh, tried);
        if (next) {
          payload.domain = next;
          tried.add(next.toLowerCase());
          console.log(`  ↻ shared domain，换到 ${next}`);
          continue;
        }
      }
      throw new Error(`YYDS create ${status || ''}: ${bodyText}`);
    }
  }
  throw new Error('YYDS create: 试了 4 个域名都不行');
}

async function yydsFetchMessages({ id, email, token }) {
  const attempts = [];
  if (token) {
    attempts.push({ url: '/v1/messages', headers: { Authorization: `Bearer ${token}` } });
  }
  attempts.push({ url: '/v1/messages', headers: { 'X-API-Key': YYDS_KEY } });
  if (id) {
    attempts.push({ url: `/v1/inboxes/${encodeURIComponent(id)}/messages`, headers: { 'X-API-Key': YYDS_KEY } });
  }
  let lastErr = null;
  for (const a of attempts) {
    try {
      const { data } = await http.get(a.url, {
        headers: a.headers,
        params: { address: email, limit: 20 },
      });
      const body = data && data.data ? data.data : data;
      const msgs = (body && (body.messages || body.items)) || [];
      if (msgs.length) return msgs;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

const CODE_RE = /(?<!\d)(\d{6,8})(?!\d)/g;
const DASH_CODE_RE = /\b([A-Z0-9]{2,4}-[A-Z0-9]{2,4})\b/g;

function stripHtml(s) {
  if (!s) return '';
  if (typeof s !== 'string') s = String(s);
  return s
    .replace(/<(style|script)[^>]*>.*?<\/\1>/gis, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function extractCode(msg) {
  // 服务端有时直接给 verificationCode 字段，优先采信
  if (msg.verificationCode) return String(msg.verificationCode);
  if (msg.code) return String(msg.code);

  const text = [
    msg.subject,
    msg.content,
    msg.text,
    msg.textBody,
    msg.html,
    msg.htmlBody,
    msg.body,
    msg.bodyPreview,
  ]
    .filter(Boolean)
    .map((x) => (typeof x === 'string' ? x : String(x)))
    .join('\n');

  // 先抓纯数字码（6-8 位）
  const clean = stripHtml(text);
  const digits = clean.match(CODE_RE) || [];
  if (digits.length) return digits[0];

  // 再抓带分隔符的码（XAI 风格 XXXX-XXXX）
  const dashed = (text.match(DASH_CODE_RE) || []).filter((c) => /[A-Z]/.test(c));
  if (dashed.length) return dashed[0];

  return null;
}

async function waitForVerificationCode(mailbox, { timeoutMs = 180_000, pollMs = 5_000, onWait = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastSeenCount = 0;
  while (Date.now() < deadline) {
    let msgs = [];
    try {
      msgs = await yydsFetchMessages(mailbox);
    } catch (e) {
      console.log(`  ⏳ 拉收件失败: ${e.message.slice(0, 80)}`);
    }
    if (msgs.length > lastSeenCount) {
      console.log(`  📬 收件箱新增 ${msgs.length - lastSeenCount} 封（共 ${msgs.length}）`);
      lastSeenCount = msgs.length;
    }
    for (const m of msgs) {
      const code = extractCode(m);
      if (code) {
        console.log(`  ✅ 拿到验证码: ${code}`);
        return { code, message: m };
      }
    }
    // 每轮让外面看看页面有没有要人介入的（CF 滑块 / 风控弹窗）
    if (typeof onWait === 'function') {
      try {
        const intervention = await onWait(Date.now() - (deadline - timeoutMs));
        if (intervention === 'abort') {
          process.stdout.write('\n');
          console.log('  ⛔ 用户中止等验证码');
          return null;
        }
      } catch (_) {}
    }
    const elapsed = Math.round((Date.now() - (deadline - timeoutMs)) / 1000);
    process.stdout.write(`  ⏳ 等验证码... ${elapsed}s\r`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  process.stdout.write('\n');
  return null;
}

// 鸣叫：Windows 喇叭
function beep() {
  try {
    process.stdout.write('\x07');
  } catch (_) {}
}

function loudAlert(msg) {
  // 控制台 + 喇叭（按 \x07 多次）+ 浏览器窗口置顶尝试
  console.log('\n' + '!'.repeat(60));
  console.log(`  🔔 ${msg}`);
  console.log('!'.repeat(60) + '\n');
  for (let i = 0; i < 5; i += 1) beep();
}

// 并发时每个号认自己的 mailbox：由 registerOne 参数传进去，
// 不再用共享全局变量（多个号串邮箱就是在等别人的验证码）

// ============================================================================
// Playwright 注册流程（用 incognito context：共享 browser，独立 cookie/localStorage）
async function registerOne({ email, accountId, mailbox, slot }) {
  const browser = await getSharedBrowser();

  console.log(`  🌐 注册 ${email} (新 incognito context) ...`);
  // 共享 browser，每个号开一个 incognito context（独立 cookie/localStorage）
  // 不再 launchPersistentContext，省启动开销 + 共享 CF 验证态
  const ctx = await browser.newContext({
    userAgent: config.USER_AGENT,
    locale: 'en-US',
    viewport: VIEWPORT,
  });

  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((e) => {
      console.log('  ⚠️  goto warning:', e.message);
    });
    // 等表单可交互
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

    // 窗口错开放：不要让 N 个 640x480 完全重叠，人工点 CF 滑块时找不到窗口
    try {
      const col = slot % 3;
      const row = Math.floor(slot / 3) % 5;
      await page.setViewportSize(VIEWPORT);
      await page.evaluate(
        ([x, y]) => {
          try { window.moveTo(x, y); window.resizeTo(640, 480); } catch (_) {}
        },
        [col * 660, row * 500]
      );
    } catch (_) {}

    // 浏览器窗口置顶 + 抢焦点（让人能看到）
    try { await page.bringToFront(); } catch (_) {}

    // CF / Turnstile 检测器：检测到就给提示，置顶页面
    let cfAlerted = false;
    const detectCf = async () => {
      const cfInfo = await page.evaluate(() => {
        const turnstile = document.querySelector('cf-turnstile, [class*="turnstile" i], [id*="turnstile" i]');
        const cfIframe = document.querySelector('iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"]');
        const challenge = document.querySelector('#challenge-stage, [class*="challenge" i]');
        const title = (document.title || '').toLowerCase();
        const isCf = Boolean(turnstile || cfIframe || challenge) || /just a moment|attention required|cf-ray/i.test(document.body.innerText || '');
        if (!isCf) return null;
        return { title, src: cfIframe && cfIframe.src };
      });
      if (cfInfo && !cfAlerted) {
        cfAlerted = true;
        try { await page.bringToFront(); } catch (_) {}
        loudAlert(`[${accountId}] 浏览器弹出 Cloudflare 验证，请在窗口里手动过（最多 2 分钟，过完继续）`);
      }
      return cfInfo ? 'cf' : null;
    };

    // 已登录检测：URL 已经跳到 /chat 或 localStorage 已有 token —— 这种 profile 被复用
    const alreadyLoggedIn = await page.evaluate(() => {
      try {
        if (location.pathname.startsWith('/chat')) return true;
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i) || '';
          const v = localStorage.getItem(k) || '';
          if (/token|auth/i.test(k) && /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(v)) return true;
        }
      } catch (_) {}
      return false;
    }).catch(() => false);
    if (alreadyLoggedIn) {
      throw new Error('这个 context 里已经登录了一个号，跳过（incognito context 不该复用）');
    }

    console.log('  ✏️  填邮箱 ...');
    // 优先尝试按 placeholder / label 找，文本匹配兼容 EN/CN
    const emailInput = page
      .getByPlaceholder(/email|邮箱|mail/i)
      .or(page.getByLabel(/email|邮箱|mail/i))
      .or(page.locator('input[type="email"], input[name*="email" i], input[autocomplete="email"]'))
      .first();
    await emailInput.waitFor({ state: 'visible', timeout: 60_000 });
    await emailInput.fill('').catch(() => {});
    await emailInput.fill(email);

    // 提交（按 Send code / Get code / 发送验证码 / Sign up 类的按钮）
    const sendBtn = page
      .getByRole('button', { name: /send.*code|get.*code|发送|sign\s*up|register|注册/i })
      .first();
    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click();
      console.log('  📨 已点 Send Code');
    } else {
      // 兜底：按回车
      await emailInput.press('Enter');
      console.log('  📨 已 Enter 提交');
    }

    console.log(`  🕐 等验证码（最多 3 分钟）...`);
    const got = await waitForVerificationCode(mailbox, {
      timeoutMs: 180_000,
      onWait: async (elapsedMs) => {
        await detectCf();
        const sec = Math.floor(elapsedMs / 1000);
        // 30s 整点 + 1 分钟还没收到才报警（不要每 30s 一次烦死）
        if (sec === 30 || sec === 60 || sec === 90 || sec === 120 || sec === 150) {
          loudAlert(`[${accountId}] 已等验证码 ${sec}s：\n  · 看浏览器是不是有 CF 滑块 / 风控弹窗（要你手动过）\n  · 是不是 215.im 邮箱 Qwen 没投递（看下页面提示）\n  · 别关浏览器！`);
        }
        return null;
      },
    });
    if (!got) throw new Error('215.im 超时未收到验证码');

    // 填验证码
    console.log('  ✏️  填验证码 ...');
    // Qwen 验证码 UI 经常是 6 个独立的格子（每个 maxlength=1）。
    // 先找这种格子：找到了就逐位 type；找不到再退到单 input fill。
    const otpBoxes = page.locator(
      'input[maxlength="1"][inputmode="numeric"], input[maxlength="1"][autocomplete*="one-time" i]'
    );
    const otpCount = await otpBoxes.count();
    if (otpCount >= 4 && got.code.length >= otpCount) {
      console.log(`     找到 ${otpCount} 格 OTP 框，逐位输入 ...`);
      for (let i = 0; i < otpCount; i += 1) {
        await otpBoxes.nth(i).click();
        await otpBoxes.nth(i).type(got.code[i] || '', { delay: 30 });
      }
    } else {
      const codeInput = page
        .getByPlaceholder(/code|验证码|otp|verification/i)
        .or(page.getByLabel(/code|验证码|otp|verification/i))
        .or(page.locator('input[name*="code" i], input[autocomplete="one-time-code"]'))
        .first();
      await codeInput.waitFor({ state: 'visible', timeout: 30_000 });
      await codeInput.fill(got.code);
    }

    // 等一下，让前端 re-validate（输完最后一位经常 300-800ms 才 enable 按钮）
    await page.waitForTimeout(800);

    // 提交（继续 / verify / 完成）
    const verifyBtn = page
      .getByRole('button', { name: /verify|confirm|continue|登录|注册|next|完成|确定|submit/i })
      .or(page.locator('button[class*="otp-panel" i], button[class*="verify" i]'))
      .first();
    await verifyBtn.waitFor({ state: 'visible', timeout: 15_000 });
    // 按钮有时仍 disabled，再等最多 10s
    const enabledDeadline = Date.now() + 10_000;
    while (Date.now() < enabledDeadline) {
      const enabled = await verifyBtn.isEnabled().catch(() => false);
      if (enabled) break;
      await page.waitForTimeout(300);
    }
    if (await verifyBtn.isEnabled().catch(() => false)) {
      await verifyBtn.click();
      console.log('  ✅ 已点 verify');
    } else {
      // 兜底：Enter 提交
      await page.keyboard.press('Enter');
      console.log('  ⏎ 按钮仍 disabled，用 Enter 兜底');
    }

    // 等 Cloudflare / Turnstile：撞上就停下来让人手动过
    const cfWaitDeadline = Date.now() + 60_000;
    while (Date.now() < cfWaitDeadline) {
      const cfPresent = await page.evaluate(() => {
        return Boolean(
          document.querySelector('cf-turnstile, iframe[src*="challenges.cloudflare"], #challenge-stage, [class*="turnstile" i]')
        );
      });
      if (!cfPresent) break;
      console.log('  ⚠️  检测到 Cloudflare 验证，请手动过（你有 60s）...');
      await page.waitForTimeout(3000);
    }

    // 等登录态：URL 跳到 /chat，或 token 落进 localStorage
    console.log('  ⏳ 等登录态稳定（最多 90s）...');
    const tokenDeadline = Date.now() + 90_000;
    let token = '';
    let sourcePage = page;
    while (Date.now() < tokenDeadline) {
      // 主页面
      for (const p of ctx.pages()) {
        try {
          const t = await p.evaluate(() => {
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
            } catch (_) {}
            return '';
          });
          if (t) {
            token = t;
            sourcePage = p;
            break;
          }
        } catch (_) {}
      }
      if (token) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!token) throw new Error('90s 内没拿到 localStorage token');

    console.log(`  ✅ 抓到 token（${token.length} 字符）`);

    // 拿 email（先 fetch /api/v1/auths/，再解 JWT）
    let finalEmail = email;
    try {
      const fromApi = await sourcePage.evaluate(async () => {
        try {
          const r = await fetch('/api/v1/auths/');
          if (r.ok) {
            const d = await r.json();
            return d.email || d.username || (d.user && d.user.email) || (d.data && d.data.email) || '';
          }
        } catch (_) {}
        return '';
      });
      if (fromApi) finalEmail = fromApi;
    } catch (_) {}
    if (finalEmail === email) {
      try {
        const parts = token.split('.');
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        const fromJwt = payload.email || payload.preferred_username || payload.sub || '';
        if (fromJwt) finalEmail = fromJwt;
      } catch (_) {}
    }

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

    return { token, email: finalEmail, cookie: cookieJar };
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ============================================================================
// 共享 browser（开 1 次，所有号共用，CF 验证态复用）
// ============================================================================
let sharedBrowser = null;
async function getSharedBrowser() {
  if (sharedBrowser) return sharedBrowser;
  let playwright;
  try {
    playwright = require('playwright');
  } catch (e) {
    throw new Error('playwright 未安装。`npm install` 或 `PUPPETEER_SKIP_DOWNLOAD=1 npm install`');
  }
  console.log('  🌐 启 Chrome（共享实例）...');
  sharedBrowser = await playwright.chromium.launch({
    headless: false,
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    ignoreDefaultArgs: ['--no-sandbox'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=en-US',
    ],
  });
  return sharedBrowser;
}

async function closeSharedBrowser() {
  if (sharedBrowser) {
    try { await sharedBrowser.close(); } catch (_) {}
    sharedBrowser = null;
  }
}

// ============================================================================
// 主流程
// ============================================================================
(async () => {
  accountStore.load();

  // 🔴 号池不覆盖：从现有 reg-N 的最大编号往后续，绝不复用已存在的 id。
  function nextRegIndex() {
    let max = 0;
    for (const a of accountStore.list()) {
      const m = /^reg-(\d+)$/.exec(a.id || '');
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  }

  let regIndex = nextRegIndex();
  console.log(`🚀 QwenProxy 自动注册 — 计划 ${num} 个号`);
  console.log(`   起始编号: reg-${regIndex}（已有 ${regIndex - 1} 个 reg- 号，不会被覆盖）`);

  // 域名列表
  const domains = await yydsListDomains();
  if (YYDS_DOMAIN) {
    console.log(`   指定域名: ${YYDS_DOMAIN}`);
  } else if (domains.length) {
    const sample = domains.slice(0, 3).map((d) => `${d.name}${d.wildcard ? '(wc)' : ''}`).join(', ');
    console.log(`   可用域名: ${sample}${domains.length > 3 ? ' ...' : ''}`);
  } else {
    console.log('   ⚠️  没拿到公共域名列表（建号时让 API 自选）');
  }

  let okCount = 0;
  let failCount = 0;

  // 全部号的「任务单」——并发模式下窗口是同时开的，先把邮箱/编号都领好，
  // 再由 worker 池同时消费。串行模式就是同一个池子 limit=1，行为跟以前一致。
  const jobs = [];
  for (let i = 0; i < num; i += 1) {
    // accountId 用全局续号（不是 i），失败也要占掉编号，保证不覆盖旧号
    const accountId = `reg-${regIndex}`;
    regIndex += 1;
    // localPart：<prefix>-<accountId>-<rand>，避免 215.im 撞名
    const local = `${emailPrefix}-${accountId.replace(/^reg-/, '')}-${Date.now().toString(36).slice(-4).toLowerCase()}`;
    const domain = YYDS_DOMAIN || pickDomain(domains) || '';
    jobs.push({ index: i + 1, accountId, local, domain });
  }

  const workerCount = serial ? 1 : concurrency;
  console.log(`\n🚀 开跑：${num} 个号，并发 ${workerCount} 个窗口（--serial 可切串行）`);

  let nextJob = 0;
  const results = [];
  async function worker(workerId) {
    let doneByMe = 0;
    while (true) {
      const myTurn = nextJob++;
      if (myTurn >= jobs.length) return;
      const { index: slotNo, accountId, local, domain } = jobs[myTurn];
      const slot = myTurn; // 窗口平铺位置
      // 批次间隔：同 worker 的两号之间歇 delayMs；不同 worker 起跑错开 workerId * 2s，
      // 避免 N 个窗口同时建箱/点发码撞 WAF。串行模式就是 worker=1 的自然间隔。
      const stagger = doneByMe > 0 ? delayMs : workerId * 2000;
      if (stagger > 0) {
        logLine(`  ⏸️  [${accountId}] 歇 ${(stagger / 1000).toFixed(0)}s 再开工（防风控）...`);
        await sleep(stagger);
      }
      doneByMe += 1;
      let mailbox = null;
      try {
        mailbox = await yydsCreateMailbox(local, domain);
        logLine(`\n========== [${slotNo}/${num}] → ${accountId} ==========`);
        logLine(`  📧 临时邮箱: ${mailbox.email}  (id=${mailbox.id || '-'})`);
        const result = await registerOne({
          email: mailbox.email,
          accountId,
          mailbox,
          slot,
        });
        // 注册后验证：坏号当场标出来，不污染号池的可用计数
        let lastError = '';
        if (validate) {
          try {
            const check = await validateToken(result.token);
            if (!check.ok) {
              lastError = `post-register validation failed: ${check.reason}`;
              logLine(`  ⚠️  验证没过: ${check.reason}（号照常落盘，lastError 已标记）`);
            } else {
              logLine(`  🔍 验证通过${check.email ? ` (${check.email})` : ''}`);
              if (check.email && result.email !== check.email) result.email = check.email;
            }
          } catch (e) {
            lastError = `post-register validation error: ${e.message.slice(0, 120)}`;
            logLine(`  ⚠️  验证请求失败: ${e.message.slice(0, 120)}（号照常落盘）`);
          }
        }
        const saved = accountStore.save(
          {
            ...result,
            savedAt: Date.now(),
            failures: lastError ? 1 : 0,
            unavailableUntil: 0,
            lastError,
          },
          accountId
        );
        logLine(`  💾 已保存: [${saved.id}] ${saved.email}  (cookies: ${result.cookie.length})${lastError ? ' ⚠️待查' : ''}`);
        logLine(`      文件: config/accounts/${saved.id}.json`);
        results.push({ ok: !lastError, accountId, saved, validationError: lastError || undefined });
      } catch (e) {
        logLine(`  ❌ 失败: [${accountId}] ${e.message}`);
        results.push({ ok: false, accountId, err: String((e && e.message) || e) });
      }
    }
  }

  // 并发模式：同时最多 workerCount 个号在跑。每个号独立 incognito context
  // （独立 cookie/localStorage），CF 滑块要人工过时一次性全点完。
  logLine(`   日志: ${logFile}`);
  logLine(`   批次间隔: ${delayMs}ms，注册后验证: ${validate ? '开' : '关'}`);
  await Promise.all(Array.from({ length: Math.min(workerCount, jobs.length) }, (_, i) => worker(i)));

  okCount = results.filter((r) => r.ok).length;
  failCount = results.length - okCount;

  if (okCount > 1) {
    logLine('  ℹ️  本批号各自在独立 context / 邮箱里跑，不用额外歇息');
  }

  await closeSharedBrowser();
  logLine(`\n🏁 收工：成功 ${okCount} / 失败 ${failCount} / 共 ${num}`);
  const failedIds = results.filter((r) => !r.ok).map((r) => r.accountId);
  if (failedIds.length) {
    logLine(`   失败编号: ${failedIds.join(', ')}（编号已占住，直接重跑 --num=${failedIds.length} 补号即可）`);
  }
  try {
    if (!logStream) fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `\nSUMMARY ${JSON.stringify({ stamp: runStamp, ok: okCount, fail: failCount, total: num, failedIds, results: results.map((r) => ({ accountId: r.accountId, ok: r.ok, err: r.err || r.validationError || undefined })) })}\n`);
    if (logStream) logStream.end();
  } catch (_) {}
  process.exit(failCount > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
