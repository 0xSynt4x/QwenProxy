'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { logger } = require('./util');

let activeResolver = null;

/**
 * 为指定账号自动弹出 Playwright 验证码窗口。
 * @param {string} accountId
 * @param {string} captchaUrl
 * @returns {Promise<boolean>}
 */
function solveCaptcha(accountId, captchaUrl = '') {
  if (activeResolver) return activeResolver;

  logger.warn(`[WAF CAPTCHA] Launching browser window for account "${accountId}" to solve captcha slider...`, 'WAF');

  activeResolver = new Promise((resolve) => {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'login.js');
    const args = ['--account', accountId, '--cookie-only'];
    if (captchaUrl) args.push('--captcha', captchaUrl);
    
    // 以可见模式启动 login.js（默认 headless: false）
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: 'inherit',
      env: { ...process.env },
    });

    child.on('exit', (code) => {
      activeResolver = null;
      if (code === 0) {
        logger.info(`[WAF CAPTCHA] Captcha solved and cookies updated for account "${accountId}"!`, 'WAF');
        resolve(true);
      } else {
        logger.error(`[WAF CAPTCHA] Captcha resolution failed with code ${code}`, 'WAF');
        resolve(false);
      }
    });

    child.on('error', (err) => {
      activeResolver = null;
      logger.error(`[WAF CAPTCHA] Failed to launch Playwright browser: ${err.message}`, 'WAF');
      resolve(false);
    });
  });

  return activeResolver;
}

module.exports = { solveCaptcha };
