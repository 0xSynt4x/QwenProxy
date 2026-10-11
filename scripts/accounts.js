#!/usr/bin/env node
'use strict';

/**
 * accounts.js — 多账号管理面板（CLI）。
 *
 * 用法：npm run accounts
 *
 * 登录一律走 `capture-login.js`（稳健版）。原版 `login.js` 会在受限文档上
 * 抛 `SecurityError: Failed to read the 'localStorage' property from 'Window'`。
 */
const readline = require('readline');
const { spawnSync } = require('child_process');
const path = require('path');
const accountStore = require('../src/account-store');

let rl = null;

function getReadLine() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return rl;
}

function ask(question) {
  return new Promise((resolve) => {
    getReadLine().question(question, (answer) => resolve(String(answer || '').trim()));
  });
}

function clear() {
  process.stdout.write('\x1b[2J\x1b[0f');
}

function printAccounts() {
  accountStore.load();
  const list = accountStore.list();
  console.log('==================================================');
  console.log('       📋 QWEN 账号面板');
  console.log('==================================================\n');

  if (!list.length) {
    console.log('  ⚠️ 还没有保存的账号。按 [a] 添加。\n');
  } else {
    for (const [index, account] of list.entries()) {
      const isCurrent = account.active ? ' ⭐️ (当前使用)' : '';
      let state = '✅ 可用';
      if (!account.available) {
        const untilStr = account.unavailableUntil > 0
          ? new Date(account.unavailableUntil).toLocaleTimeString()
          : 'WAF 封锁中';
        state = `❌ 封锁至 ${untilStr}`;
      }

      const tokenPreview = account.token ? `${account.token.slice(0, 16)}...` : '❌ 无 token';
      console.log(`  [${index + 1}] ID: ${account.id}${isCurrent}`);
      console.log(`      账号:     ${account.email}`);
      console.log(`      状态:     ${state} | 失败次数: ${account.failures}`);
      console.log(`      Token:    ${tokenPreview}`);
      if (account.hasRefreshToken) {
        console.log('      续期:     ✅ 有 refresh_token（可自动续期）');
      } else {
        console.log('      续期:     ⚠️ 没有 refresh_token（过期需重登）');
      }
      if (account.lastError) {
        console.log(`      最近错误: ${account.lastError}`);
      }
      console.log('  ------------------------------------------------');
    }
  }

  console.log('\n  [a] 添加账号       [r] 重新登录（刷新 token）');
  console.log('  [s] 设为当前账号   [u] 解除封锁');
  console.log('  [t] 逐个测试       [d] 删除账号');
  console.log('  [q] 退出\n');

  return list;
}

function runLogin(id, isRelogin = false) {
  if (rl) {
    rl.close();
    rl = null;
  }

  const loginScript = path.join(__dirname, 'capture-login.js');
  const args = ['--account', id];

  console.log(`\n🚀 正在打开浏览器${isRelogin ? '刷新' : '添加'}账号 [${id}]…\n`);
  const result = spawnSync(process.execPath, [loginScript, ...args], { stdio: 'inherit' });

  if (result.status !== 0) {
    console.log('\n❌ 登录失败或取消。\n');
  } else {
    console.log('\n✅ 已更新。\n');
  }
}

async function main() {
  while (true) {
    clear();
    const list = printAccounts();
    const command = (await ask('选择操作: ')).toLowerCase();

    if (command === 'q' || command === 'quit' || command === 'exit') {
      console.log('\n退出。');
      break;
    }

    if (command === 'a' || command === 'add') {
      let id = await ask('新账号 ID（直接回车自动取）: ');
      if (!id) id = `account-${list.length + 1}`;
      runLogin(id, false);
      await ask('按回车继续…');
    } else if (command === 'r' || command === 'relogin') {
      if (!list.length) {
        console.log('没有可刷新的账号。');
        await ask('回车…');
        continue;
      }
      const value = await ask('要重新登录的账号编号或 ID: ');
      const account = list[Number(value) - 1] || accountStore.get(value);
      if (account) {
        runLogin(account.id, true);
      } else {
        console.log('❌ 没找到该账号。');
      }
      await ask('按回车继续…');
    } else if (command === 's' || command === 'select') {
      if (!list.length) continue;
      const value = await ask('要设为当前的账号编号或 ID: ');
      const account = list[Number(value) - 1] || accountStore.get(value);
      if (account) {
        accountStore.select(account.id);
        console.log(`\n✅ 账号 [${account.id}] 已设为当前。\n`);
      } else {
        console.log('❌ 没找到该账号。');
      }
      await ask('回车…');
    } else if (command === 'u' || command === 'unlock') {
      if (!list.length) continue;
      const value = await ask('要解除封锁的账号编号或 ID（填 "all" 全部）: ');
      if (value.toLowerCase() === 'all') {
        for (const acc of list) accountStore.reset(acc.id);
        console.log('\n✅ 所有账号已解除封锁。\n');
      } else {
        const account = list[Number(value) - 1] || accountStore.get(value);
        if (account) {
          accountStore.reset(account.id);
          console.log(`\n✅ 账号 [${account.id}] 已解除封锁。\n`);
        } else {
          console.log('❌ 没找到该账号。');
        }
      }
      await ask('回车…');
    } else if (command === 't' || command === 'test') {
      if (!list.length) continue;
      const qwenClient = require('../src/qwen-client');
      const chatAdapter = require('../src/chat-adapter');
      console.log('\n🧪 正在逐个测试账号（会真发请求，别频繁刷）…\n');
      for (const acc of list) {
        process.stdout.write(`  测试 [${acc.id}] (${acc.email})… `);
        try {
          const prepared = await chatAdapter.preparePublicPayload(
            {
              model: 'qwen3.8-max',
              messages: [{ role: 'user', content: 'ping' }],
            },
            { account: acc }
          );
          const res = await qwenClient.sendChatRequest(prepared.qwenPayload, acc);
          if (res.status) {
            let text = '';
            await new Promise((resFn) => {
              res.response.on('data', (c) => { text += c.toString(); });
              res.response.on('end', resFn);
            });
            if (text.includes('RateLimited')) {
              console.log('❌ 今日额度已用完（RateLimited）');
              accountStore.markFailure(acc, 'RateLimited');
            } else if (text.includes('FAIL_SYS_USER_VALIDATE') || text.includes('RGV587_ERROR')) {
              console.log('❌ 触发 WAF 验证码（RGV587）');
              accountStore.markFailure(acc, 'WAF Captcha Challenge', true);
            } else if (text.includes('choices') || text.includes('delta') || text.includes('content')) {
              console.log('✅ 正常');
              accountStore.markSuccess(acc);
            } else {
              console.log(`❌ 响应异常: ${text.slice(0, 80)}`);
              accountStore.markFailure(acc, 'Invalid SSE response');
            }
          } else {
            console.log(`❌ 出错: ${res.message}`);
          }
        } catch (e) {
          console.log(`❌ 异常: ${e.message}`);
        }
      }
      await ask('\n按回车继续…');
    } else if (command === 'd' || command === 'delete') {
      if (!list.length) continue;
      const value = await ask('要删除的账号编号或 ID: ');
      const account = list[Number(value) - 1] || accountStore.get(value);
      if (account) {
        const confirm = await ask(`确认删除账号 [${account.id}]？（y/N）: `);
        if (confirm.toLowerCase() === 'y' || confirm.toLowerCase() === 'yes') {
          const fs = require('fs');
          const file = path.join(require('../src/config').ACCOUNTS_DIR, `${account.id}.json`);
          if (fs.existsSync(file)) fs.unlinkSync(file);
          accountStore.load();
          console.log('\n✅ 账号已删除。');
        }
      } else {
        console.log('❌ 没找到该账号。');
      }
      await ask('回车…');
    }
  }

  if (rl) rl.close();
}

main().catch((err) => {
  console.error(err);
  if (rl) rl.close();
  process.exitCode = 1;
});
