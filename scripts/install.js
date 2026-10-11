#!/usr/bin/env node
/**
 * npm run install:setup
 *
 * 交互式安装器：
 *   1. 检查环境（node、npm、依赖）。
 *   2. 引导登录 Qwen 账号（capture-login.js）。
 *   3. 刷新模型清单（npm run models）。
 *   4. Linux 上可选装 systemd 用户服务（Windows 上跳过，给出手动方案）。
 *   5. 可选把 `qwen` provider 写进 opencode 配置。
 *   6. 打印总结和地址。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, 'config');
const ACCOUNT_FILE = path.join(CONFIG_DIR, 'account.json');
const ACCOUNTS_DIR = path.join(CONFIG_DIR, 'accounts');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (q, def = '') =>
  new Promise((resolve) => {
    rl.question(def ? `${q} [${def}] ` : `${q} `, (a) => resolve(a.trim() || def));
  });

const yesNo = async (q, def = 'y') => {
  const a = (await ask(q, def)).toLowerCase();
  return a === 'y' || a === 'yes' || a === '是' || a === '好' || a === 'д' || a === 'да';
};

const run = (cmd, opts = {}) => {
  console.log(`\n  $ ${cmd}\n`);
  try {
    return execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
  } catch (e) {
    return null;
  }
};

function line(char = '-') {
  console.log(char.repeat(60));
}

function heading(t) {
  console.log(`\n== ${t} ==`);
}

function hasPkg(name) {
  try {
    return !!require.resolve(name, { paths: [ROOT] });
  } catch (_) {
    return false;
  }
}

const isWindows = process.platform === 'win32';

async function ensureDeps() {
  heading('依赖');
  const deps = ['express', 'axios', 'dotenv', 'cors'];
  const missing = deps.filter((d) => !hasPkg(d));
  if (missing.length) {
    console.log(`未安装：${missing.join(', ')}`);
    if (await yesNo('现在安装（npm install）？')) {
      run('npm install --no-audit --no-fund');
    }
  } else {
    console.log('基础依赖已就位。');
  }
  const pw = hasPkg('playwright');
  const pp = hasPkg('puppeteer');
  if (!pw && !pp) {
    console.log('\n自动抓登录态需要 Playwright。');
    if (isWindows) {
      console.log('Windows 上可以借本机 Chrome，不必下 Chromium：');
      console.log('  set PLAYWRIGHT_CHANNEL=chrome');
      console.log('  （写进 .env 也行）');
    }
    if (await yesNo('安装 playwright？')) {
      run('npm install playwright --no-audit --no-fund');
      if (!isWindows) run('npx playwright install chromium --with-deps');
    }
  }
}

async function ensureLogin() {
  const accountStore = require('../src/account-store');
  heading('Qwen 账号');
  accountStore.load();
  if (accountStore.isAccount()) {
    console.log('已找到保存的 Qwen 账号。');
    if (await yesNo('要重新登录吗？', 'n')) {
      run('node scripts/capture-login.js');
    }
    return;
  }
  console.log('需要一个 Qwen Chat 账号（chat.qwen.ai，免费注册）。');
  if (await yesNo('现在开浏览器登录？')) {
    run('node scripts/capture-login.js');
  } else {
    console.log('已跳过。之后可跑：node scripts/capture-login.js');
  }
}

async function syncModels() {
  heading('模型');
  if (await yesNo('拉取最新模型清单（npm run models）？')) {
    run('npm run models');
  } else {
    console.log('已跳过。之后可跑：npm run models');
  }
}

async function installSystemd() {
  heading('开机自启');
  if (isWindows) {
    console.log('Windows 上没有 systemd，跳过。');
    console.log('要开机自启，用「任务计划程序」或 nssm 挂 `node server.js`。');
    console.log('最省事：需要时手动 `npm start`。');
    return;
  }
  let hasSystemd = false;
  if (fs.existsSync('/run/systemd/system')) {
    hasSystemd = true;
  } else {
    try {
      execSync('systemctl --user status', { stdio: 'ignore' });
      hasSystemd = true;
    } catch (_) {}
  }
  if (!hasSystemd) {
    console.log('没找到 systemd —— 跳过。');
    return;
  }
  const serviceName = 'qwen-proxy.service';
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const unitPath = path.join(unitDir, serviceName);
  const already = fs.existsSync(unitPath);

  if (already) {
    if (await yesNo(`服务 ${serviceName} 已存在。要重装吗（enable --now）？`, 'y')) {
      writeUnit(unitPath);
      run('systemctl --user daemon-reload');
      run(`systemctl --user enable --now ${serviceName}`);
    }
    return;
  }
  if (await yesNo('装 systemd 用户服务做自启？')) {
    fs.mkdirSync(unitDir, { recursive: true });
    writeUnit(unitPath);
    run('systemctl --user daemon-reload');
    run(`systemctl --user enable --now ${serviceName}`);
    console.log('服务已启用。管理：systemctl --user status qwen-proxy');
  } else {
    console.log('已跳过。手动启动：npm start');
  }
}

function writeUnit(unitPath) {
  const node = process.execPath;
  const unit = `[Unit]
Description=QwenProxy - local OpenAI-compatible proxy for chat.qwen.ai
After=network.target

[Service]
Type=simple
ExecStart=${node} ${path.join(ROOT, 'server.js')}
WorkingDirectory=${ROOT}
Restart=on-failure
RestartSec=3
Environment=PORT=3265
Environment=QWEN_WORKSPACE=${path.join(os.homedir(), 'qwen-workspace')}
TimeoutStopSec=10

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(unitPath, unit, 'utf8');
  console.log(`  unit: ${unitPath}`);
}

async function installOpencode() {
  heading('opencode');
  const cfgHome = process.env.OPENCODE_CONFIG_DIR
    ? path.resolve(process.env.OPENCODE_CONFIG_DIR)
    : path.join(os.homedir(), '.config', 'opencode');
  const cfgPath = path.join(cfgHome, 'opencode.json');

  if (!fs.existsSync(cfgPath)) {
    console.log(`没找到 opencode 配置（${cfgPath}）。`);
    if (await yesNo('要创建 opencode.json 并写入 qwen provider 吗？')) {
      fs.mkdirSync(cfgHome, { recursive: true });
      fs.writeFileSync(cfgPath, JSON.stringify(providerConfig(), null, 2) + '\n', 'utf8');
      console.log('  已创建：', cfgPath);
    }
    return;
  }

  const raw = fs.readFileSync(cfgPath, 'utf8');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (_) {
    console.log('  opencode.json 不是合法 JSON（可能是 .jsonc）。跳过改写。');
    return;
  }
  if (cfg.provider && cfg.provider.qwen) {
    if (await yesNo('qwen provider 已存在。要更新吗？')) {
      cfg.provider.qwen = providerConfig().provider.qwen;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      console.log('  已更新：', cfgPath);
    }
    return;
  }
  if (await yesNo('把 qwen provider 加进 opencode.json？')) {
    cfg.provider = cfg.provider || {};
    cfg.provider.qwen = providerConfig().provider.qwen;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    console.log('  已添加：', cfgPath);
  }
}

/** 与 config.js 的 BASE_MODELS 保持一致 —— 实测账号可见的 7 个。 */
function providerConfig() {
  const models = {
    'qwen3.8-max': [1000000, 131072],
    'qwen3.7-max': [1000000, 131072],
    'qwen3.7-plus': [1000000, 65536],
    'qwen3.6-plus': [1000000, 65536],
    'qwen3.5-plus': [1000000, 65536],
    'qwen3.8-omni-flash': [1000000, 65536],
    'qwen3.5-omni-plus': [262144, 65536],
  };
  const modelConfig = Object.fromEntries(Object.entries(models).map(([id, [context, output]]) => [id, {
    name: id,
    reasoning: !id.includes('omni'),
    tool_call: true,
    limit: { context, output },
  }]));
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      qwen: {
        npm: '@ai-sdk/openai-compatible',
        name: 'QwenProxy',
        options: {
          baseURL: 'http://localhost:3265/v1',
          apiKey: 'local',
        },
        models: modelConfig,
      },
    },
  };
}

async function summary() {
  heading('总结');
  line();
  const acc = fs.existsSync(ACCOUNT_FILE)
    || (fs.existsSync(ACCOUNTS_DIR) && fs.readdirSync(ACCOUNTS_DIR).some((name) => name.endsWith('.json')));
  console.log('  Qwen 账号        : ' + (acc ? 'OK' : '未配置（node scripts/capture-login.js）'));
  console.log('  模型清单         : ' + (fs.existsSync(path.join(CONFIG_DIR, 'models-cache.json')) ? '有缓存' : 'npm run models'));
  console.log('  网页聊天         : http://localhost:3265/');
  console.log('  OpenAI API       : http://localhost:3265/v1');
  console.log('  Workspace（文件）: ' + (process.env.QWEN_WORKSPACE || path.join(os.homedir(), 'qwen-workspace')));
  line();
  console.log('\n搞定。启动：npm start（或直接开 http://localhost:3265）');
}

(async () => {
  console.log('');
  console.log('  QwenProxy — 安装器');
  console.log('  代理 + 网页聊天 + 工具 + opencode');
  line();

  if (!process.env.OPENCODE_ALLOW_UNSAFE && process.getuid && process.getuid() === 0) {
    console.log('\n别用 root 跑安装器。');
    process.exit(1);
  }

  await ensureDeps();
  await ensureLogin();
  await syncModels();
  await installSystemd();
  await installOpencode();
  await summary();

  rl.close();
})().catch((e) => {
  console.error('\n安装中断：', e.message);
  rl.close();
  process.exit(1);
});
