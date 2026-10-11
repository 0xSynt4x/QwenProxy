'use strict';

const config = require('./config');
const accountStore = require('./account-store');
const ssxmodManager = require('./ssxmod-manager');
const { generateUUID, getTimezoneHeader } = require('./util');

/**
 * 构造访问 chat.qwen.ai 所需的完整浏览器请求头。
 *
 * 单独成模块的原因：`qwen-client`（发对话）和 `token-manager`（续期 token）都要用同一套头，
 * 而两者互相 require 会成环 —— 抽到这里两边共用。
 *
 * 🔴 铁律：头必须与线上 SPA 完全一致（含 sec-ch-ua / sec-fetch-* / origin / host /
 * x-accel-buffering），少任何一个都会被 Aliyun WAF 拦成
 * `FAIL_SYS_USER_VALIDATE` / `RGV587_ERROR`。
 */
function buildHeaders(refererPath, account) {
  const cookie = accountStore.buildCookieHeader(
    account,
    ssxmodManager.getSsxmodItna(),
    ssxmodManager.getSsxmodItna2()
  );
  return {
    'sec-ch-ua-platform': '"Windows"',
    referer: `${config.BASE_URL}${refererPath}`,
    'accept-language': 'zh-CN,zh;q=0.9',
    'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'user-agent': config.USER_AGENT,
    'content-type': 'application/json',
    accept: 'application/json',
    'accept-encoding': 'gzip, deflate, br, zstd',
    source: 'web',
    version: config.QWEN_WEB_VERSION,
    timezone: getTimezoneHeader(),
    'x-request-id': generateUUID(),
    connection: 'keep-alive',
    cookie,
    host: config.BASE_URL.replace('https://', ''),
    origin: config.BASE_URL,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'x-accel-buffering': 'no',
  };
}

module.exports = { buildHeaders };
