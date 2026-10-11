'use strict';

const crypto = require('crypto');

/**
 * 通用工具：UUID、timezone 请求头、sha256、日志。
 */

const generateUUID = () => crypto.randomUUID();

/**
 * 浏览器风格的 ASCII timezone 请求头（不含非 ASCII 字符，否则 HTTP 头会损坏）。
 * 示例："Thu Aug 07 2026 10:00:00 GMT+0000 (Coordinated Universal Time)"
 */
const getTimezoneHeader = () =>
  new Date()
    .toString()
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const sha256Hex = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- 日志 ----------
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL = LEVELS[process.env.LOG_LEVEL || 'info'];

const ts = () => new Date().toISOString().slice(11, 19);

const emit = (level, tag, msg, extra) => {
  if (LEVELS[level] < LEVEL) return;
  const prefix = `[${ts()}] [${level.toUpperCase()}]${tag ? ` [${tag}]` : ''}`;
  if (extra && extra instanceof Error) {
    console.error(`${prefix} ${msg}: ${extra.message}`);
    if (extra.stack) console.error(extra.stack.split('\n').slice(0, 4).join('\n'));
  } else if (extra !== undefined) {
    console.log(`${prefix} ${msg}`, extra);
  } else {
    console.log(`${prefix} ${msg}`);
  }
};

const logger = {
  debug: (msg, tag, extra) => emit('debug', tag, msg, extra),
  info: (msg, tag, extra) => emit('info', tag, msg, extra),
  warn: (msg, tag, extra) => emit('warn', tag, msg, extra),
  error: (msg, tag, extra) => emit('error', tag, msg, extra),
  network: (msg, tag) => emit('info', tag || 'NET', msg),
};

module.exports = { generateUUID, getTimezoneHeader, sha256Hex, sleep, logger };
