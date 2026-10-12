# QwenProxy — Agent Guide

## 语言规则

**永远用用户使用的语言回复。** 用户说中文就回中文，说英文就回英文。除非用户明确要求，不要切换语言。

---

## 这是什么

一个本地的 OpenAI 兼容反向代理，后端是 chat.qwen.ai 的免费网页 API。为 **OpenCode** 这类 AI 客户端设计 —— 不花 API 钱就能用上工具调用、会话记忆、文件读写这些 agent 功能。

核心改动（相对上游 angyedz/QwenFreeApi）：

- **token 自动续期** —— 原版没有，access token 15 分钟过期就 500。
- **模型清单对齐实测** —— 7 个真实可用模型，去掉不可见的 `qwen3-coder-plus`。
- **响应 `model` 字段透传** —— 原版硬写空字符串。
- **思维链换行修复** —— 原版用 `\n` 拼接上游分片，导致 reasoning 里凭空多换行。
- **文档汉化 + Windows 化** —— 原版全俄语 + 只有 Linux systemd。

---

## 给 agent 的安装流程

用户让你装/配置这个代理时，按顺序做，**不要跳过、不要让用户手动做能自动做的事**：

### 第 1 步 —— 装依赖

```bash
cd /path/to/QwenProxy
npm install
```

本机已有 Chrome 时跳过下载内核：

```bash
PUPPETEER_SKIP_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
```

### 第 2 步 —— 开浏览器让用户登录

```bash
node scripts/capture-login.js
```

告诉用户：

> 浏览器开了，去 chat.qwen.ai 登录你的账号（没有就免费注册一个），登完跟我说「好了」，我接着弄。

⚠️ Windows 上先确认 `.env` 里有 `PLAYWRIGHT_CHANNEL=chrome`，否则脚本找不到浏览器。

等用户确认后，脚本自己会抓到登录态并关窗口。检查 `config/accounts/` 里至少有一个 `.json`。

### 第 3 步 —— 起服务

```bash
npm start
```

验证：

```bash
curl -s http://localhost:3265/health
```

应该回 `{"ok":true,"account":"loaded","ssxmod":"ready"}`。

**Windows 上不要装 systemd** —— 原版的 `npm run daemon` 是 Linux 专用的，已经删了。要开机自启就用任务计划程序或 nssm。

### 第 4 步 —— 配 OpenCode

写（或改）`~/.config/opencode/opencode.json`：

```json
{
  "provider": {
    "qwen": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "QwenProxy",
      "options": {
        "baseURL": "http://localhost:3265/v1",
        "apiKey": "local"
      },
      "models": {
        "qwen3.8-max": {
          "name": "Qwen 3.8 Max",
          "reasoning": true,
          "tool_call": true,
          "limit": { "context": 1000000, "output": 131072 }
        }
      }
    }
  },
  "mcpServers": {
    "qwen-memo": {
      "command": "node",
      "args": ["REPO_PATH/mcp-server.js"]
    }
  }
}
```

把 `REPO_PATH` 换成真实绝对路径。文件已存在时**只补 `provider` 和 `mcpServers` 两块**，别覆盖无关设置。

### 第 5 步 —— 跑测试

```bash
npm test
```

必须全过。有失败先查再往下走。

### 第 6 步 —— 交付说明

全好了之后跟用户说（按他的语言）：

---

搞定，能用了 🚀

怎么用：

1. 在你的项目目录里开 OpenCode：
   ```
   opencode
   ```
2. 模型选 `qwen/qwen3.8-max`（或列表里别的）。
3. 直接派活 —— agent 会自动通过你项目 AGENTS.md 里的说明用你的文件、终端和工具。

OpenCode 里常用的：
- `/new` —— 开新会话
- `/help` —— 命令列表
- 直接用中文派活就行

`memo_recall` 工具（走 MCP `qwen-memo`）：
- 让 agent 回忆任何历史工具的输出（bash、读文件、数据库），不用重跑。
- `max_chars` 传 100 到 3000，越小越快。

---

## OpenCode 的 MCP 配置

只加**一个**条目就够，它把会话工具记忆直接暴露出来。

改 `~/.config/opencode/opencode.json`：

```json
{
  "mcpServers": {
    "qwen-memo": {
      "command": "node",
      "args": ["/path/to/QwenProxy/mcp-server.js"]
    }
  }
}
```

换成真实路径，然后重启 OpenCode。

### 这个 MCP 暴露什么

- **`memo_recall`** —— 取当前会话里过去的工具输出。
- **`memo_sessions`** —— 看内存里有多少会话和结果。

`memo_recall` 参数：

- **`query`** —— 关键词、工具名，或 `"recent"`。
- **`max_chars`** —— 默认 800，**代理硬上限 3000**。
- **`session`** —— 不传就用最近活跃的会话。

---

## 代理行为与限制

### 上下文保留

代理自动压缩并把完整对话历史重新塞进每次 Qwen 请求。模型不会在轮次之间丢掉 agent 身份或工具定义。

### WAF token 预算

阿里云 WAF 会拦超过约 30000 token 的请求。代理强制：

- 历史最长 **45000 字符**（≈ 11000 token）
- 单条消息最长 **8000 字符**
- 系统指令最长 **14000 字符**（放得下完整 AGENTS.md）

### 会话工具记忆（`memo_recall`）

代理把每个工具结果存进每会话的环形缓冲（最近 40 条，每条最多 30000 字符）。模型每轮都能看到 `# Session Tool Memory` 摘要块，可以调虚拟工具 `memo_recall` 取回具体历史结果，不用重跑原查询。

`max_chars` 被代理硬性限制在 **3000**。

### 数据库查询安全

代理给每个请求注入规则，禁止：

- 不带 `LIMIT` 的 `SELECT * FROM table`
- 把大结果集往 stdout 倒；输出必须写本地文件

### 会话-账号绑定

一旦某个 Qwen `chat_id` 建在某个账号上，该会话后续所有轮次都用同一个账号。中途换账号会导致上游 `frames=0`。

### 每日配额（免费档）

- 每个号每个模型每天 **20 次**对话（`QWEN_DAILY_LIMIT` 可调，默认 20）。
- 配额**按模型算**，不是按账号 —— 一个号的 `qwen3.8-max` 打光了，同账号其余模型照样能用。
- 代理**记账**：每次真正被上游接受的请求，会在 `config/accounts/*.json` 的 `daily.counts` 里按模型 +1，`daily.counts._total` 记当天总次数。按北京时间（UTC+8）跨天自动归零。
- 代理**认得出打光**：上游那句「今日对话次数已达上限，请明日再来。」是**正文文案 + HTTP 200**，代理在 SSE 前 48 个字里做配额闸门识别，命中就抛 `DailyQuotaExhausted`，把这个号在 `daily.exhausted[model]` 里标成明天零点解封，然后**自动换号重试**（流式 / 非流式都覆盖，最多换 5 次）。
- 候选号排序 = 当天用量升序 + `lastUsedAt` 升序，**雨露均沾**，不再死磕 `activeId` 那个号；`activeId` 只在还有额度时排首位（保持会话-账号绑定的粘性）。全打光时退回所有有 token 的号，不硬失败。
- 打光的号**不会废**，次日自动恢复。目前没出现过配额导致账号报废的情况。
- `$qwen-api usage`（或 `quota`）看当天各号用量排行；`$qwen-api accounts` 每行也带「今天 N/20 次」。

### 号池看板（网页）

```bash
npm start            # 然后打开 http://localhost:3265/pool.html
```

- 数据源 `GET /api/pool`，页面**每 5 秒自动刷新**（切后台停轮询，回来立刻补一次），纯静态单页，不依赖构建。
- 看四样东西：汇总卡（总数 / 可用号 / 今日已用 / 打光与冷却）、**按模型的配额条**（已用 / 总容量 / 百分比 / 已打光号数）、账号明细表（搜索 + 按「今天用过 / 有异常」过滤，正在用的号置顶高亮，每个号的各模型用量做成小标签，满 20 次的标黄、被显式打光的标红）、底部轮询策略说明。
- 状态判定的优先级：无登录态 `off` > 冷却中 `cooling` > 已打光 `exhausted`（显式 exhausted 标记或自然满 20 次都算）> 正在用 `active` > 待命 `idle`。**可用号 = 有 token 且不在冷却且今天还有额度。**
- 汇总逻辑在 `src/pool-status.js`（纯函数，直接喂 `accountStore.list()` 的输出），路由在 `src/web.js` 的 `/api/pool`，页面三件套在 `public/pool.{html,css,js}`。改看板字段先改 `pool-status.js` 再改页面，顺带补 `tests/pool-status-test.js`。

### 自动注册（号池扩容）

```bash
node scripts/auto-register.js --num=5                  # 默认并发 3 个窗口，间隔 5s 错峰
node scripts/auto-register.js --num=10 --concurrency=5 # 一次开 5 个窗口
node scripts/auto-register.js --num=3 --serial         # 退回老的一船一个
node scripts/auto-register.js --num=10 --delay=8000    # 风控严时加大间隔
node scripts/auto-register.js --num=3 --no-validate    # 跳过注册后 token 验证
```

- 账号 id 是 `reg-N`，**N 从现有号池最大编号 + 1 续**，绝不覆盖已有账号。需要 `.env` 里的 `YYDS_API_KEY` 和 `PLAYWRIGHT_CHANNEL=chrome`。
- 浏览器是 headed 的，弹 Cloudflare 滑块**必须人工过**（行为式人机校验，服务端过不了，没有自动解码）。并发窗口就是为「一次全点完」设计的。
- 并发窗口视口固定 **640×480**（够填邮箱 + 验证码），并按 `slot % 3` / `slot / 3` **平铺错开放**，不会互相压成一个。
- 注册成功后自动打一发 `GET /api/v1/auths/` 验证 token（**不耗每天 20 次对话配额**），坏号当场在 `lastError` 里标记，不会混进可用计数。
- 每次运行落盘到 `logs/auto-register-<时间戳>.log`（控制台同步打印，尾部有 JSON 汇总 + 失败编号）。失败的 `reg-N` 编号已占住，直接重跑 `--num=<失败数>` 补号即可。
- 环境变量：`AUTO_REGISTER_CONCURRENCY`（默认 3）、`AUTO_REGISTER_DELAY_MS`（默认 5000）、`AUTO_REGISTER_VALIDATE=0`（关验证）、`AUTO_REGISTER_SERIAL=1`（切串行）、`PLAYWRIGHT_CHANNEL=chrome`。

### 测试与目录隔离

- 所有会落盘的测试（`test-token.js` / `offline-sse-test.js` / `tests/daily-quota-test.js`）都在 require 之前设 `QWEN_CONFIG_DIR=<临时目录>`，把 `config/accounts/`、session 文件全指去别处。🔴 `config.js` 加载时就快照路径，**晚一步设就晚了**。

---

## 排障

- **`frames=0, choices=0`** —— 撞了 WAF token 上限。检查读文件的大小，别一次读整个大文件。
- **模型忘了工具 / 让你上传文件** —— 老会话没带工具提示。重启 OpenCode 会话（`/new`）。
- **`accountStore.isAvailable is not a function`** —— node_modules 过期，`npm install`。
- **`Failed to create a Qwen chat`** —— token 过期，重跑 `node scripts/capture-login.js`。
- **`WAF_CAPTCHA_CHALLENGE`** —— 触发了阿里云风控验证码。**别高频打请求**，等约 30 分钟冷却（账号退避会自动过期）。实测风控记的是**账号**不是 IP，换出口代理没用。
- **正文回「今日对话次数已达上限，请明日再来。」** —— 上游免费档的每日对话配额刷爆了，等第二天。这是上游文案，不是代理造的。
- **Windows 上起不来 / 找不到浏览器** —— `.env` 里加 `PLAYWRIGHT_CHANNEL=chrome`。
- **`QWEN_WEB_VERSION` 怎么设** —— 🔴 **保持 `0.2.83` 别动。** 线上前端实际是 `0.3.16`，但带 `0.3.16` 会被判 `Unauthorized`，带 `0.2.83` 才放行。

---

## 测试

```bash
npm test                                   # 六组离线测试全跑
node tests/daily-quota-test.js             # 只跑号池记账 / 额度识别
node tests/pool-status-test.js             # 只跑号池看板汇总
node scripts/offline-tool-loop-test.js     # 只跑工具循环
```

全部离线，不发真请求。

---

## 关键文件

- `server.js` —— Express 入口，会话/账号管理
- `mcp-server.js` —— stdio MCP server，暴露 `memo_recall`
- `src/chat-adapter.js` —— OpenAI ↔ Qwen 消息折叠与 SSE 转换
- `src/token-manager.js` —— token 续期（本项目新增，核心）
- `src/qwen-headers.js` —— 上游请求头（抽出来避免循环 require）
- `src/tools.js` —— 工具协议注入（XML `<tool_call>`）
- `src/tool-memo.js` —— 每会话工具结果记忆（`memo_recall`）
- `src/session-store.js` —— 跨轮次的 chatId + accountId 持久化
- `src/account-store.js` —— 多账号轮换与健康跟踪
- `src/pool-status.js` —— 号池看板汇总（纯函数，喂 accountStore.list() 输出）
- `src/web.js` —— 静态页 + REST API（含 `/api/pool`）
- `src/qwen-client.js` —— SSXMOD cookie 生成 + 上游 HTTP
- `src/config.js` —— 所有可调限制（`AGENT_HISTORY_MAX_CHARS` 等）
- `scripts/offline-sse-test.js` —— SSE 适配单元测试
- `scripts/offline-tool-loop-test.js` —— 工具循环集成测试
