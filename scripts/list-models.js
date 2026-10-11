#!/usr/bin/env node
'use strict';

/**
 * npm run models —— 拉取当前账号在 chat.qwen.ai 上实际可见的模型清单，
 * 连同每个模型的上下文/输出上限一起写进 config/models-cache.json。
 *
 * 用法：
 *   npm run models              # 打印并保存
 *   npm run models -- --no-save # 只打印不保存
 *
 * 上游 `/api/models` 的每个模型自带 `max_context_length` / `max_summary_generation_length`，
 * 所以这里一并存下来，`/v1/models` 就不用靠手维护的兜底表了。
 */
const fs = require('fs');
const axios = require('axios');
const config = require('../src/config');
const accountStore = require('../src/account-store');
const ssxmodManager = require('../src/ssxmod-manager');
const tokenManager = require('../src/token-manager');
const { buildHeaders } = require('../src/qwen-headers');

const save = !process.argv.includes('--no-save');

/** 从上游模型对象里抠出 id 和两个长度上限。 */
function normalizeModel(entry) {
  if (typeof entry === 'string') return { id: entry };
  if (!entry || typeof entry !== 'object') return null;
  const id = entry.id || entry.model || entry.name;
  if (!id) return null;
  const meta = (entry.info && entry.info.meta) || entry.meta || {};
  const context = Number(
    meta.max_context_length || entry.max_context_length || meta.context_length || 0
  );
  const output = Number(
    meta.max_summary_generation_length || entry.max_output_tokens || meta.max_output_tokens || 0
  );
  const out = { id };
  if (context) out.context = context;
  if (output) out.output = output;
  return out;
}

(async () => {
  ssxmodManager.init();
  accountStore.load();
  const account = accountStore.current();
  if (!account) {
    console.error('没有可用账号。先跑：npm run login（或 npm run accounts 查看）');
    process.exit(1);
  }

  // token 可能只剩几分钟，先确保新鲜
  await tokenManager.ensureFreshToken(account);

  try {
    const res = await axios.get(`${config.BASE_URL}/api/models`, {
      headers: buildHeaders('/', account),
      timeout: 30000,
      validateStatus: () => true,
    });

    if (res.status === 401 || res.status === 403) {
      console.error(`鉴权失败（HTTP ${res.status}）。token 已过期且续期无效，请重新登录：npm run login`);
      process.exit(1);
    }
    if (res.status !== 200) {
      console.error(`上游返回 HTTP ${res.status}：${JSON.stringify(res.data).slice(0, 300)}`);
      process.exit(1);
    }

    const raw = res.data && res.data.data ? res.data.data : res.data;
    const list = Array.isArray(raw)
      ? raw.map(normalizeModel).filter(Boolean)
      : Object.keys(raw || {}).map((id) => ({ id }));

    if (!list.length) {
      console.error('上游返回了空模型清单。检查 `npm run login` 的账号是否正常。');
      process.exit(1);
    }

    console.log(`账号 ${account.email} 可见模型（共 ${list.length} 个）：`);
    for (const m of list.slice(0, 60)) {
      const ctx = m.context ? `  上下文 ${m.context}` : '';
      const out = m.output ? `  输出 ${m.output}` : '';
      console.log(`  - ${m.id}${ctx}${out}`);
    }

    if (save) {
      const payload = { fetchedAt: new Date().toISOString(), models: list };
      fs.writeFileSync(config.CACHE_FILE, JSON.stringify(payload, null, 2));
      console.log(`\n已保存 ${list.length} 个模型 -> ${config.CACHE_FILE}`);
      console.log('重启服务后 /v1/models 即会带上这些模型的真实上下文长度。');
    }
  } catch (e) {
    console.error('拉取模型清单失败：', e.message);
    const body =
      e.response && e.response.data
        ? JSON.stringify(e.response.data).slice(0, 300)
        : String(e.response || '');
    if (/<html|aliyun_waf|baxia/i.test(body)) {
      console.error('上游返回的是 WAF/HTML 拦截页 —— 账号被风控了，等冷却或重新登录。');
    }
    process.exit(1);
  }
  process.exit(0);
})();
