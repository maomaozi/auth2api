# auth2api

[English](./README.md)

一个轻量级的多 provider OAuth 转 API 代理，支持 Claude、Codex (OpenAI/ChatGPT) 和 Gemini (Google)。

auth2api 将 OAuth 登录态转化为可调用的 API，提供统一的 OpenAI 兼容接口：

- 每个 provider 支持一个或多个账号，自动轮询
- 一个本地或自托管代理
- 自动模型路由 — 发送 `claude-sonnet-4-6`、`gpt-4o` 或 `gemini-2.5-pro`，auth2api 自动路由到对应 provider

## 功能特性

- **多 provider 支持** — Claude、Codex (OpenAI GPT/o 系列) 和 Gemini 统一在一个代理后面
- **自动模型路由** — 根据模型名前缀自动路由到对应 provider
- **自定义模型别名** — 在配置文件中为常用模型定义短名
- **账号池自动轮询** — 每个 provider 独立的粘性轮询（sticky round-robin），上游错误时按类型进入指数退避 cooldown
- **连续失败自动屏蔽** — 账号在连续失败达到阈值后自动禁用，可通过 admin 接口一键恢复
- **自动 token 刷新** — 在 token 过期前主动刷新（Codex 提前 5 分钟，Gemini 提前 30 分钟）
- **OpenAI 兼容 API** — 所有 provider 统一通过 `/v1/chat/completions` 和 `/v1/models` 提供服务
- **Claude 原生透传** — 支持 `/v1/messages` 与 `/v1/messages/count_tokens`
- **流式、工具调用、图片与推理** — 每个 provider 完整的请求/响应翻译，包括 SSE 流式传输
- **Per-API-key 用量追踪** — 按 API key 和模型追踪请求数和 token 用量
- **使用 key 与管理 key 隔离** — `api-keys` 仅能访问模型接口，管理账号池必须使用独立的 `admin-keys`
- **默认安全设置** — timing-safe key 校验、每 IP 限流、仅允许 localhost 浏览器 CORS

## 运行要求

- Node.js 20+
- 至少一个受支持 provider 的账号：
  - **Claude** — 推荐 Claude Max 订阅
  - **Codex** — 有 Codex 访问权限的 OpenAI 账号（ChatGPT Plus/Pro）
  - **Gemini** — 有 Gemini CLI 访问权限的 Google 账号

## 安装

```bash
git clone https://github.com/AmazingAng/auth2api
cd auth2api
npm install
npm run build
```

## 登录

每个 provider 有独立的登录命令，每个要添加的账号执行一次。

| Provider | 命令 |
|----------|------|
| Claude | `node dist/index.js --login`（或 `--claude-login`）|
| Codex (OpenAI) | `node dist/index.js --codex-login` |
| Gemini (Google) | `node dist/index.js --gemini-login` |

### 自动模式（需要本地浏览器）

```bash
node dist/index.js --login          # Claude
node dist/index.js --codex-login    # Codex
node dist/index.js --gemini-login   # Gemini
```

程序会输出一个浏览器 URL。完成授权后，回调会自动处理。

### 手动模式（适合远程服务器）

在任意登录命令后附加 `--manual`：

```bash
node dist/index.js --codex-login --manual
```

在浏览器中打开输出的链接。授权完成后，浏览器会跳转到一个 `localhost` 地址，这个页面可能无法打开；请把地址栏中的完整 URL 复制回终端。

## 启动服务

```bash
node dist/index.js
```

默认监听地址为 `http://127.0.0.1:8317`。首次启动时，如果 `config.yaml` 中没有配置 API key，会自动生成并写入该文件。

如果某个 provider 的所有账号都因为限流临时进入 cooldown，auth2api 会返回 `429 Rate limited on the configured <provider> account`，而不是通用的 `503`。

## 配置

复制 `config.example.yaml` 为 `config.yaml`，然后按需修改：

```yaml
host: ""          # 绑定地址，空字符串表示 127.0.0.1
port: 8317

auth-dir: "~/.auth2api"   # OAuth token 存储目录

api-keys:
  - "your-api-key-here"   # 客户端访问 /v1/* 的 key（仅能调模型）

# 管理账号池的独立 key，和 api-keys 完全隔离，普通用户 key 无法访问 /admin/*。
# 留空则 /admin/* 完全不注册，返回 404（与不存在的路径无法区分）。
admin-keys: []
  # - "your-admin-key-here"

body-limit: "200mb"       # 最大 JSON 请求体大小，适合大上下文场景

cloaking:                 # 仅对 Claude provider 生效
  mode: "auto"            # auto | always | never
  strict-mode: false
  sensitive-words: []
  cache-user-id: false

debug: "off"            # off | errors | verbose

# 自定义模型别名（可选）
# model-alias:
#   "smart": "claude-sonnet-4-6"
#   "fast": "gemini-2.5-flash"
#   "my-gpt": { provider: "codex", model: "gpt-4o" }
```

上游超时也可以单独配置：

```yaml
timeouts:
  messages-ms: 120000         # 非流式请求超时
  stream-messages-ms: 600000  # 流式请求超时（10 分钟）
  count-tokens-ms: 30000      # token 计数超时（仅 Claude）
```

`debug` 支持三级日志：
- `off`：不输出额外调试日志
- `errors`：记录上游/网络失败信息和上游错误响应正文
- `verbose`：在 `errors` 基础上，再输出每个请求的方法、路径、状态码和耗时

## 使用方法

将任意 OpenAI 兼容客户端指向 `http://127.0.0.1:8317`。模型名称决定由哪个 provider 处理请求：

```bash
# Claude
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4-6", "messages": [{"role": "user", "content": "Hello!"}]}'

# Codex (OpenAI)
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"model": "o4-mini", "messages": [{"role": "user", "content": "Hello!"}]}'

# Gemini
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"model": "gemini-2.5-pro", "messages": [{"role": "user", "content": "Hello!"}]}'
```

### 模型路由

请求根据模型名前缀自动路由到对应 provider：

| 前缀 | Provider |
|------|----------|
| `claude-`, `opus`, `sonnet`, `haiku` | Claude |
| `gpt-`, `o1`, `o3`, `o4`, `codex-`, `chatgpt-` | Codex (OpenAI) |
| `gemini-` | Gemini (Google) |

也可以在 `config.yaml` 中定义自定义别名：

```yaml
model-alias:
  "smart": "claude-sonnet-4-6"
  "fast": "gemini-2.5-flash"
  "my-gpt": { provider: "codex", model: "gpt-4o" }
```

### 支持的模型

**Claude**（需要 Claude OAuth 登录）：

| 模型 ID | 说明 |
|--------|------|
| `claude-opus-4-6` | Claude Opus 4.6 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 |

便捷别名：`opus`、`sonnet`、`haiku`

**Codex**（需要 OpenAI OAuth 登录）：

Codex CLI 后端支持的所有模型，包括 `gpt-4o`、`o4-mini`、`o3`、`codex-mini` 等。

**Gemini**（需要 Google OAuth 登录）：

Gemini CLI 后端支持的所有模型，包括 `gemini-2.5-pro`、`gemini-2.5-flash` 等。

### 接口列表

| Endpoint | 鉴权 | 说明 |
|----------|------|------|
| `POST /v1/chat/completions` | `api-keys` | OpenAI 兼容聊天接口（所有 provider）|
| `POST /v1/responses` | `api-keys` | OpenAI Responses API 兼容接口 |
| `POST /v1/messages` | `api-keys` | Claude 原生消息透传 |
| `POST /v1/messages/count_tokens` | `api-keys` | Claude token 计数 |
| `GET /v1/models` | `api-keys` | 列出可用模型 |
| `GET /admin/accounts` | `admin-keys` | 查看账号池状态 |
| `GET /admin/api-keys` | `admin-keys` | 按 API key 的用量统计 |
| `POST /admin/accounts/:email/enable` | `admin-keys` | 手动恢复被禁用的账号 |
| `GET /health` | 无 | 健康检查 |

未配置 `admin-keys` 时，所有 `/admin/*` 路由不会注册，访问会返回普通的 `404`。

## Docker

```bash
# 构建
docker build -t auth2api .

# 运行（挂载配置文件与 token 目录）
docker run -d \
  -p 8317:8317 \
  -v ~/.auth2api:/data \
  -v ./config.yaml:/config/config.yaml \
  auth2api
```

或者使用 docker-compose：

```bash
docker-compose up -d
```

## 与 Claude Code 配合使用

将 `ANTHROPIC_BASE_URL` 指向 auth2api：

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8317 \
ANTHROPIC_API_KEY=<your-api-key> \
claude
```

Claude Code 使用的是原生 `/v1/messages` 接口，auth2api 会直接透传。`Authorization: Bearer` 与 `x-api-key` 两种认证头都支持。

## 账号池

auth2api 按 provider 维护独立的账号池，每个池独立运行各自的轮询和 cooldown 跟踪。

- 为每个账号执行对应的登录命令（`--login`、`--codex-login` 或 `--gemini-login`）。相同邮箱会刷新已保存的 token，新邮箱会追加到账号池。
- 启动时会自动加载 `auth-dir` 目录下所有 `{provider}-{email}.json` 文件（如 `claude-user@example.com.json`、`codex-user@example.com.json`、`gemini-user@gmail.com.json`）。
- 请求走 **per-provider 粘性轮询**（sticky round-robin）：同一账号会被连续使用 20-60 分钟再切换；当账号进入 cooldown 时会立即切到下一个可用账号。
- 上游错误（`429`、`401`、`403`、`5xx`、网络错误）按类型分类，触发指数退避 cooldown，账号池继续用剩余账号服务请求。
- 遇到 `401` 时，auth2api 会自动尝试刷新 token 后重试。
- Codex 特有：正确处理 "model at capacity" 错误和 `usage_limit_reached` 响应，从 `resets_at`/`resets_in_seconds` 字段精确解析 cooldown 时长。
- 连续失败 10 次以上的账号会被**自动禁用**，同时输出 `[WARNING]` 日志。恢复方式：通过 admin 接口一键恢复，或重新执行登录命令。
- Token 刷新在后台主动运行（每 60 秒检查）：Codex 在过期前 5 分钟刷新，Gemini 在过期前 30 分钟刷新。

## 管理接口

在 `config.yaml` 中配置 `admin-keys` 后才能使用管理 API。未配置时，`/admin/*` 完全不可达，返回 `404`，与不存在的路径无法区分。

查看账号池状态：

```bash
curl http://127.0.0.1:8317/admin/accounts \
  -H "Authorization: Bearer <your-admin-key>"
```

返回内容包含每个账号是否可用、`disabled` 标志、cooldown 截止时间、失败计数、最近刷新时间以及基础请求 / token 统计。

无需重启即可恢复被禁用的账号：

```bash
curl -X POST http://127.0.0.1:8317/admin/accounts/<email>/enable \
  -H "Authorization: Bearer <your-admin-key>"
```

`api-keys` 中的 key **无法**访问任何 `/admin/*` 接口，会返回 `403 Invalid admin key`。

## 架构

```
客户端 (OpenAI 兼容)
  │
  ▼
/v1/chat/completions
  │
  ├── 模型前缀路由 ──▶ Provider 选择
  │
  ├── Claude  ──▶ Claude Messages API  (api.anthropic.com)
  ├── Codex   ──▶ Codex Responses API  (chatgpt.com/backend-api/codex)
  └── Gemini  ──▶ Gemini CLI API       (cloudcode-pa.googleapis.com)
  │
  ▼
响应翻译回 OpenAI 格式
```

每个 provider 有专门的翻译层：
- **请求**：OpenAI chat completions 格式 → provider 原生格式
- **响应**：provider 原生格式 → OpenAI chat completions 格式
- **SSE 流式**：provider SSE 事件 → OpenAI SSE chunks

## Smoke 测试

仓库内置了一套最小自动化 smoke test，使用 mocked upstream response，不会调用任何真实服务：

```bash
npm run test:smoke
```

## 致谢

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [sub2api](https://github.com/Wei-Shaw/sub2api)

## License

MIT
