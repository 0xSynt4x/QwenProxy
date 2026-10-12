# QwenProxy

把 **chat.qwen.ai 网页端**的内部 web API 反代成 **OpenAI 兼容端点**的本地代理，自带 token 自动续期。

用途：让 OpenCode / Cline / 任何 OpenAI 兼容客户端，不花钱用上 `qwen3.8-max`（1M 上下文）。

> ⚠️ 这是**非官方**的浏览器端逆向工具，仅供个人本地使用。Qwen / 阿里会改内部 API、改模型列表、改响应格式 —— 那时需要更新本代理。使用需遵守 Qwen 服务条款。

---

## 能做什么

- **OpenAI 兼容**：`GET /v1/models`、`POST /v1/chat/completions`（流式 / 非流式都支持）。
- **网页聊天界面**：带历史、流式输出、Markdown 渲染。
- **Agent 工具**：`bash`、读写文件、联网搜索（走 tool_call 协议）。
- **多账号池 + 自动路由**：某个账号挂了自动换下一个，失败按指数退避。
- **token 自动续期**：不用每天重新登录（见下方「token 机制」）。
- **纯 JS 生成 SSXMOD 指纹 cookie**：不需要真浏览器就能过 WAF 指纹校验。

---

## 环境要求

- **Node.js >= 18**（实测 v24.11.1 正常）。
- 一个 Qwen Chat 账号（chat.qwen.ai，免费注册）。
- 想用自动抓登录态的话需要 Playwright + 本机 Chrome。

### Windows 用户注意

本项目原版是给 Linux 写的（文档和安装脚本里有 systemd 那套）。**Windows 上不要用 `npm run install:setup` 的 systemd 部分**，直接：

```powershell
npm install
copy .env.example .env
node scripts/capture-login.js     # 抓登录态
node server.js                    # 起服务
```

要开机自启，用「任务计划程序」或 `nssm`，别指望 systemd。

---

## 安装

```bash
git clone https://github.com/0xSynt4x/QwenProxy.git
cd QwenProxy
npm install
cp .env.example .env
```

`npm install` 时如果不想下浏览器内核（本机已有 Chrome 的话）：

```bash
PUPPETEER_SKIP_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
```

---

## 登录（抓账号）

**推荐用 `capture-login.js`**，不要用原版 `login.js`：

```bash
node scripts/capture-login.js
# 或指定账号 id
node scripts/capture-login.js --account main
```

它会开一个真 Chrome 窗口，你登录 Qwen，脚本自动抓 token + cookie 落盘。窗口里登录完不用管，脚本每 2.5 秒轮询一次，抓到就自己关。

> 🔴 **Windows 上必须让脚本借用本机 Chrome**：`.env` 里设 `PLAYWRIGHT_CHANNEL=chrome`。项目默认不带 Chromium 内核，不设这个会报找不到浏览器。

### 为什么不用原版 `login.js`

原版在页面上下文里用 `page.waitForFunction` 读 localStorage。Qwen 现在会跳转到受限文档（WAF / OAuth 中转页），一读就抛：

```
SecurityError: Failed to read the 'localStorage' property from 'Window': Access is denied for this document.
```

`capture-login.js` 改成「Node 侧轮询 + 每次 evaluate 都 try/catch + persistent profile」，绕开了这个坑。

### 手动填 token（不想开浏览器）

```bash
npm run login -- --manual
```

脚本会要你从浏览器 DevTools 的 `Application` → `Local Storage` → `chat.qwen.ai` → `token` 里复制 JWT。

登录态存在 `config/accounts/<id>.json`，已被 `.gitignore` 排除，**别提交上去**。

---

## 自动注册账号（号池扩容）

免费档**每个号每天只有 20 次对话**（`qwen3.8-max`），想多跑就得攒号。`scripts/auto-register.js` 全自动干这事：

```bash
node scripts/auto-register.js            # 注册 1 个号
node scripts/auto-register.js --num=5    # 串行注册 5 个号
```

流程：申请 215.im 临时邮箱 → 开 Chrome 填邮箱 → 轮询收验证码 → 填 6 格 OTP → 抓 token + cookie → 落进 `config/accounts/reg-N.json`。

**前置条件：**

- `.env` 里要有 `YYDS_API_KEY`（`AC-` 开头的 215.im key）。
- `PLAYWRIGHT_CHANNEL=chrome`（借用本机 Chrome）。
- 浏览器是 **headed** 的，跑的时候别关窗口 —— 弹出 Cloudflare 滑块要你手动过，脚本会响喇叭提醒。

### 🔴 账号 id 不会覆盖

账号 id 永远是 `reg-N`，**N 从现有号池里最大的 `reg-N` + 1 开始续**。池子里已有 `reg-1..reg-5` 时，再跑 `--num=3` 会得到 `reg-6/7/8`，不会覆盖旧号。某个号注册失败也会占掉那个编号，下次接着往下走。

---

## 启动

```bash
npm start
```

- 网页聊天：http://localhost:3265/
- OpenAI API：http://localhost:3265/v1
- 健康检查：http://localhost:3265/health

---

## token 机制（本项目的核心改动）

原版**一行续期代码都没有**，而 Qwen 的 access token 只有 **15 分钟**寿命 —— 意味着原版每 15 分钟就必然 500。本项目补上了自动续期。

**两种 token 的寿命：**

- **access token** —— `exp - iat = 900 秒 = 15 分钟`。用来发对话。
- **refresh_token** —— 存在 cookie 里，**30 天**。用来换 access token。

**续期怎么走：**

- 换发接口：`GET https://chat.qwen.ai/api/v1/auths/`，带 `Authorization: Bearer <refresh_token>`。
- 响应体里回新 token，同时 `set-cookie: token=<同一个>`。
- 🔴 **`refresh_token` 本身可以直接当 Bearer 用**，能直接发对话，不换发也行。所以最省事的做法是直接把账号 token 换成 refresh_token 值，一次管 30 天。

**代码里的行为：**

- `src/token-manager.js` 在每次发请求前检查 token 剩余寿命，**不足 1 天才去续**（`isTokenExpiring`），同一账号 60 秒内不重复换。
- 续期失败返回原 token，不会死循环。
- `src/qwen-client.js` 遇到 401/403 会先换 token 再重试一次，仍失败才把账号标记为不可用。
- 启动时自动从 cookie 数组里把 `refresh_token` 补进 `account.refreshToken` 字段（`backfillRefreshToken`），不用重新登录。

**鉴权结论（实测）：** 上游 100% 只看 `token`，**cookie 不参与鉴权**。但完整浏览器头（`sec-ch-ua` / `sec-fetch-*` / `origin` / `host`）必须带全，少一个就被 WAF 拦成 `FAIL_SYS_USER_VALIDATE`。

---

## 配置项（`.env`）

- **`PORT`** —— 默认 `3265`。HTTP 服务端口。
- **`QWEN_WORKSPACE`** —— 默认 `~/qwen-workspace`。agent 的 bash / 文件工具的沙箱目录。
- **`QWEN_WEB_VERSION`** —— 默认 `0.2.83`。上游 SPA 版本号，作为请求头发出去。
- **`DEFAULT_MODEL`** —— 默认 `qwen3.8-max`。客户端没传 model 时用这个。
- **`MAX_PAYLOAD_BYTES`** —— 默认 `16777216`。入口 JSON 体大小上限（技术限制，不是模型 token 限制）。
- **`STREAM_IDLE_TIMEOUT_MS`** —— 默认 `180000`。SSE 多久没新数据就判超时。
- **`LOG_LEVEL`** —— `debug` / `info` / `warn` / `error`。
- **`PLAYWRIGHT_CHANNEL`** —— 设成 `chrome` 就用本机 Chrome，不用下 Chromium。

### 🔴 `QWEN_WEB_VERSION` 的铁律

**别改成线上真实版本号。** 实测（2026-10-12）：

- 线上前端实际是 **`0.3.16`**（`assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.3.16/js/main.js`）。
- 但发请求时头里带 `version: 0.3.16` 会被判 `Unauthorized`。
- 带 **`0.2.83`** 才放行。

所以 `.env` 里保持 `0.2.83`。真遇到 WAF 报错时，去 DevTools → Network → 任意 `chat.qwen.ai` 请求 → Request Headers → `version` 看当前值，再试着换。

---

## 模型

代理对外暴露 **7 个**模型（实测账号可见清单）：

- `qwen3.8-max` —— 1M 上下文 / 131072 输出。默认模型。
- `qwen3.7-max`
- `qwen3.7-plus`
- `qwen3.6-plus`
- `qwen3.5-plus`
- `qwen3.8-omni-flash`
- `qwen3.5-omni-plus`

用 `npm run models` 拉线上清单刷新缓存（会连每个模型的 `max_context_length` 一起存进 `config/models-cache.json`，`/v1/models` 就报真实限制）。

> 注：原版硬编码的 `qwen3-coder-plus` 在当前账号下**不可见**，已从清单移除。

---

## 用 OpenAI 兼容 API

Base URL `http://localhost:3265/v1`，API key 随便填（比如 `local`）。

```bash
curl http://localhost:3265/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local' \
  -d '{
    "model": "qwen3.8-max",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

### OpenCode 配置

```jsonc
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
  }
}
```

```bash
opencode run --model qwen/qwen3.8-max "解释这段代码"
```

---

## API 端点

- `GET /` —— 网页聊天界面
- `GET /health` —— 账号与 SSXMOD 状态
- `GET /healthz` —— 服务诊断
- `GET /v1/models` —— OpenAI 模型列表
- `POST /v1/chat/completions` —— OpenAI 兼容对话
- `GET /api/models` —— 网页端用的模型列表
- `GET /api/chats` —— 会话列表
- `POST /api/chats` —— 新建会话
- `GET/PATCH/DELETE /api/chats/:id` —— 查 / 改 / 删会话
- `POST /api/chats/:id/messages` —— 发消息（SSE）
- `POST /api/chats/:id/clear` —— 清空会话历史
- `GET/POST /api/workspace` —— 读 / 改沙箱目录

---

## 命令

```bash
npm start                     # 起服务
node scripts/capture-login.js # 抓登录态（推荐）
node scripts/auto-register.js --num=5  # 自动注册新号进池（不覆盖旧号）
npm run login                 # 原版登录（易踩 localStorage 坑）
npm run login -- --manual     # 手动贴 JWT
npm run accounts              # 多账号管理面板
npm run models                # 刷新模型清单
npm test                      # 全套离线测试
```

---

## 测试

```bash
npm test
```

跑四组，全离线、不打网络：

- `scripts/test-cookies.js` —— SSXMOD 指纹 cookie 生成。
- `scripts/test-token.js` —— token 续期逻辑（JWT 解码 / 过期判定 / 换发解析 / 双写一致性）。
- `scripts/offline-sse-test.js` —— Qwen SSE → OpenAI 格式转换，含思维链换行、model 字段透传的回归用例。
- `scripts/offline-tool-loop-test.js` —— agent 工具循环端到端。

改代码前先跑一遍。

---

## 排障

**`401` 或 `session expired`**

自动路由会暂时跳过这个账号。`npm run accounts` 里按 `r` 重新登录，或跑 `capture-login.js`。

**`504` / 返回 HTML 而不是 JSON / WAF 滑块**

上游版本号变了或触发了风控。试着调 `QWEN_WEB_VERSION`，在浏览器里过掉滑块，再重新登录。

**`WAF_CAPTCHA_CHALLENGE`**

阿里云风控要验证码了。**别高频打请求** —— 短时间连打很容易触发，之后所有请求都会 500。等 30 分钟冷却（账号退避自动过期）再试。

实测（2026-10-12）：一旦触发，`chats/new` 和 `/api/models` 还是 200，但 `chat/completions` 会持续回 `RGV587_ERROR`，**换出口 IP 也没用** —— 风控记的是账号。

**返回正文是「今日对话次数已达上限，请明日再来。」**

这是**上游自己发的配额文案**，不是代理造的。免费档有每日对话次数上限，刷爆了当天就没得用，等第二天。

实测（2026-10-12）：

- 每个免费号每个模型每天 **20 次**对话（`qwen3.8-max`）。
- 配额是**按模型算的**，不是按账号 —— 同一账号的 `qwen3.8-max` 打光了，其余 6 个模型还能正常用。
- 这个文案是**正文内容**，HTTP 状态还是 200，所以代理不会自动切换到下一个账号（它看起来就像一次成功的回答）。
- 打光的号**不会废**，第二天照常能用 —— 目前没出现过配额耗尽导致账号报废的情况。
- 想多跑就攒号：`node scripts/auto-register.js --num=5`。

**`frames=0, choices=0`**

上游一帧都不给。常见原因：WAF token 预算超了（一次读的文件太大）、或者账号被风控了。

**模型列表拉不下来**

`npm run models`，检查账号是否可用。缓存在 `config/models-cache.json`。

**`Failed to create a Qwen chat`**

token 过期或 WAF。先 `capture-login.js` 重登。

**Windows 上报找不到浏览器**

`.env` 里加 `PLAYWRIGHT_CHANNEL=chrome`。

---

## 探针脚本

`scripts/probes/` 下有几个排查用的工具，不进主流程：

- `probe-raw-sse.js` —— 直连上游，逐帧打印原始 SSE。用来判断某个现象是上游给的还是代理改的。
  `node scripts/probes/probe-raw-sse.js "你的问题"`
- `probe-local.js` —— 打本地代理，看 OpenAI 格式返回。`node scripts/probes/probe-local.js [stream|nonstream]`
- `probe-content.js` —— 专查 content / reasoning_content 里有没有凭空多出换行。
- `probe-models.js` —— 逐个模型发一句话，看哪些能用、哪些被限流。
- `probe-all-models.js` —— 一账号 × 7 模型各打一发，验证配额是按模型还是按账号算。
- `probe-quota.js` —— 受控实验，区分「WAF 风控」和「每日配额」这两种不同的失败。
- `probe-renew.js` —— 用 cookie 里的 refresh_token 单独验证换发链路。
- `probe-credits.js` / `probe-credits2.js` —— 探积分 / 会员额度接口（未打通，留档）。
- `monitor-account.js` —— 定时探测账号状态，只在状态变化时打印，用来观察 WAF 冷却与配额恢复时点。

⚠️ 这些会真发请求。**别连着刷**，会触发 WAF 验证码。

---

## 项目结构

```text
server.js                    # Express 入口 + OpenAI 兼容 API
public/                      # 网页聊天的 HTML / CSS / JS
src/config.js                # 端口、模型清单、上游地址等配置
src/qwen-headers.js          # 上游请求头（必须与线上 SPA 一致，否则吃 WAF）
src/qwen-client.js           # Qwen Chat v2 HTTP 客户端
src/token-manager.js         # token 续期（本项目新增）
src/chat-adapter.js          # Qwen ↔ OpenAI 格式互转
src/tools.js                 # tool calling 协议
src/tool-executor.js         # bash / 文件 / 联网搜索的沙箱执行
src/agent.js                 # agent 循环与 SSE 事件
src/chat-store.js            # 本地会话存储
src/web.js                   # 网页端 REST API
src/account-store.js         # 账号 token / cookie 管理
src/ssxmod-manager.js        # SSXMOD cookie 生成与轮换
scripts/capture-login.js     # 稳健版登录抓取（推荐）
scripts/auto-register.js     # 自动注册新号进池（reg-N 续号，不覆盖）
scripts/login.js             # 原版登录
scripts/list-models.js       # 刷新模型清单
scripts/test-token.js        # token 续期测试
scripts/offline-sse-test.js  # SSE 转换测试
scripts/probes/              # 排查用探针脚本
```

---

## 安全

- 别把 `config/accounts/*.json`、`.env`、`config/chats/` 提交或公开。
- 别把沙箱目录指到有重要文件的地方。
- 服务默认没有鉴权，**别直接暴露到公网**，要上就套反代加认证。
- `bash` 工具是以当前用户身份在本机真跑的。
- 只在遵守 Qwen 服务条款的前提下自用。

---

## 免责

非官方浏览器端工具，仅供个人本地使用。Qwen / 阿里随时可能改内部 API、模型清单和响应格式，届时需要更新本代理。

## 许可

上游 angyedz/QwenFreeApi **没有附任何 license 文件**，本仓库 fork 自它，因此同样未声明许可。自己用没问题，**别拿去做商业分发**。
