'use strict';

const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
// 账号目录可被 QWEN_CONFIG_DIR 覆盖（测试要跑在临时目录里，不碰真号池）
const CONFIG_DIR = process.env.QWEN_CONFIG_DIR
  ? path.resolve(process.env.QWEN_CONFIG_DIR)
  : path.join(PROJECT_ROOT, 'config');
const ACCOUNT_FILE = path.join(CONFIG_DIR, 'account.json');
const ACCOUNTS_DIR = path.join(CONFIG_DIR, 'accounts');
const CACHE_FILE = path.join(CONFIG_DIR, 'models-cache.json');

const BASE_URL = 'https://chat.qwen.ai';

// SPA build id —— Qwen 要求前端版本号匹配。
//
// 🔴 2026-10-12 实测（别照着线上前端改！）：
//   线上 SPA 现在是 0.3.16，但**用它会被判 Unauthorized**；
//   反而是旧的 0.2.83 放行。所以这个值**保持 0.2.83**。
//   只有当 0.2.83 开始被 WAF 拦（`FAIL_SYS_USER_VALIDATE` / `RGV587_ERROR`）时，
//   才去线上抓新的 build id 填进 .env 覆盖这里。
const QWEN_WEB_VERSION = process.env.QWEN_WEB_VERSION || '0.2.83';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// 默认模型清单 —— 2026-10-12 用真实账号打 `GET /api/models` 实测到的 7 个。
// （原版硬编码 5 个，其中 qwen3-coder-plus 账号根本看不到，另两个 omni 模型漏了。）
// `npm run models` 会用账号实际可见的清单覆盖/补充这里。
const BASE_MODELS = [
  'qwen3.8-max',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
  'qwen3.5-plus',
  'qwen3.8-omni-flash',
  'qwen3.5-omni-plus',
];

// 上下文/输出上限。key 是模型 id。
// 注意：`npm run models` 拉到的真实 `max_context_length` 会优先覆盖这里的值，
// 这里只是「没拉过缓存时的兜底」。
const MODEL_LIMITS = {
  'qwen3.8-max': { context: 1000000, output: 131072 },
  'qwen3.7-max': { context: 1000000, output: 81920 },
  'qwen3.7-plus': { context: 1000000, output: 65536 },
  'qwen3.6-plus': { context: 1000000, output: 65536 },
  'qwen3.5-plus': { context: 1000000, output: 65536 },
  'qwen3.8-omni-flash': { context: 1000000, output: 65536 },
  'qwen3.5-omni-plus': { context: 262144, output: 65536 },
  'qwen3.8-max-preview': { context: 1000000, output: 65536 },
  'qwen3.6-max-preview': { context: 262144, output: 81920 },
  'qwen3.6-27b': { context: 262144, output: 81920 },
  'qwen3.6-35b-a3b': { context: 262144, output: 81920 },
  'qwen3.5-flash': { context: 1000000, output: 65536 },
  'qwen3.5-397b-a17b': { context: 262144, output: 65536 },
  'qwen3.5-omni-flash': { context: 262144, output: 65536 },
  'qwen3-max-2026-01-23': { context: 262144, output: 32768 },
  'qwen-plus-2025-07-28': { context: 131072, output: 81920 },
  'qwen3-coder-plus': { context: 1048576, output: 65536 },
  'qwen3-vl-plus': { context: 262144, output: 81920 },
  'qwen3-omni-flash-2025-12-01': { context: 65536, output: 13684 },
};

/**
 * 读 `config/models-cache.json`（由 `npm run models` 生成）。
 * 兼容两种格式：
 *   - 旧：`{ fetchedAt, models: ['a','b'] }`
 *   - 新：`{ fetchedAt, models: [{ id, context, output }] }`（带真实上下文长度）
 */
function loadModelCache() {
  const empty = { models: BASE_MODELS, limits: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.models) ? raw.models : null;
    if (!list || !list.length) return empty;

    const ids = [];
    const limits = {};
    for (const entry of list) {
      if (typeof entry === 'string') {
        ids.push(entry);
        continue;
      }
      if (entry && typeof entry === 'object' && entry.id) {
        ids.push(entry.id);
        const context = Number(entry.context || entry.max_context_length || 0);
        const output = Number(entry.output || entry.max_output_tokens || 0);
        if (context || output) limits[entry.id] = { context: context || 65536, output: output || 32768 };
      }
    }
    if (!ids.length) return empty;
    return { models: [...new Set([...BASE_MODELS, ...ids])], limits };
  } catch (_) {
    return empty;
  }
}

const modelCache = loadModelCache();
const MODELS = modelCache.models;
// 缓存里带真实上下文长度时优先用它，否则用内置兜底表
const EFFECTIVE_MODEL_LIMITS = { ...MODEL_LIMITS, ...modelCache.limits };

// 线上 FE 实际使用的默认模型是 qwen3.8-max，但通过 /v1 可以请求任意模型。
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'qwen3.8-max';

// WAF 可接受的 JSON 请求体大小上限（防止 agent 上下文撑爆）。
const MAX_PAYLOAD_BYTES = Number(process.env.MAX_PAYLOAD_BYTES || 16 * 1024 * 1024);

// Keep agent prompts bounded: tool output can otherwise be copied into every
// following Qwen request and make the upstream close before producing SSE.
const AGENT_HISTORY_MAX_CHARS = Number(process.env.AGENT_HISTORY_MAX_CHARS || 12000);
const AGENT_MESSAGE_MAX_CHARS = Number(process.env.AGENT_MESSAGE_MAX_CHARS || 3000);

const PORT = Number(process.env.PORT || 3265);
// 若 Qwen 不再下发 SSE，请求不应永久挂起。
const STREAM_IDLE_TIMEOUT_MS = Number(process.env.STREAM_IDLE_TIMEOUT_MS || 180000);

module.exports = {
  PROJECT_ROOT,
  CONFIG_DIR,
  ACCOUNT_FILE,
  ACCOUNTS_DIR,
  CACHE_FILE,
  BASE_URL,
  QWEN_WEB_VERSION,
  USER_AGENT,
  BASE_MODELS,
  MODELS,
  MODEL_LIMITS: EFFECTIVE_MODEL_LIMITS,
  DEFAULT_MODEL,
  MAX_PAYLOAD_BYTES,
  AGENT_HISTORY_MAX_CHARS,
  AGENT_MESSAGE_MAX_CHARS,
  PORT,
  STREAM_IDLE_TIMEOUT_MS,
};
