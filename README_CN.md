# auth2api

[English](./README.md)

一个轻量级的 Claude OAuth 转 API 代理，适合 Claude Code 和 OpenAI 兼容客户端。

auth2api 的定位很克制，也很明确：

- 一个或多个 Claude OAuth 账号，自动轮询
- 一个本地或自托管代理
- 一个目标：把 Claude OAuth 登录态变成可调用的 API

它并不试图做成多 provider 网关，也不是大型路由平台。如果你想要的是一个体积小、容易理解、方便自己改的代理，auth2api 就是为这个场景准备的。

## 功能特性

- **轻量优先**：代码量小，依赖和运行逻辑都尽量简单
- **Claude OAuth 转 API**：把一个或多个 Claude OAuth 登录账号作为 API 代理账号使用
- **账号池自动轮询**：支持多账号粘性轮询（sticky round-robin），上游错误时按类型进入指数退避 cooldown
- **连续失败自动屏蔽**：账号在连续失败达到阈值后会被自动禁用并输出 warning，可通过 admin 接口一键恢复
- **OpenAI 兼容 API**：支持 `/v1/chat/completions`、`/v1/responses`、`/v1/models`
- **Claude 原生透传**：支持 `/v1/messages` 与 `/v1/messages/count_tokens`
- **适配 Claude Code**：兼容 `Authorization: Bearer` 和 `x-api-key`
- **覆盖核心能力**：支持流式、工具调用、图片与 reasoning，而不引入大型框架
- **使用 key 与管理 key 隔离**：`api-keys` 仅能访问模型接口，管理账号池必须使用独立的 `admin-keys`
- **默认安全设置**：timing-safe key 校验、每 IP 限流、仅允许 localhost 浏览器 CORS

## 运行要求

- Node.js 20+
- 一个 Claude 账号（推荐 Claude Max）

## 安装

```bash
git clone https://github.com/AmazingAng/auth2api
cd auth2api
npm install
npm run build
```

## 登录

### 自动模式（需要本地浏览器）

```bash
node dist/index.js --login
```

程序会输出一个浏览器 URL。完成授权后，回调会自动处理。

### 手动模式（适合远程服务器）

```bash
node dist/index.js --login --manual
```

在浏览器中打开输出的链接。授权完成后，浏览器会跳转到一个 `localhost` 地址，这个页面可能无法打开；请把地址栏中的完整 URL 复制回终端。

## 启动服务

```bash
node dist/index.js
```

默认监听地址为 `http://127.0.0.1:8317`。首次启动时，如果 `config.yaml` 中没有配置 API key，会自动生成并写入该文件。

如果账号池中所有账号都因为限流临时进入 cooldown，auth2api 会返回 `429 Rate limited on the configured account`，而不是通用的 `503`。

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

cloaking:
  mode: "auto"            # auto | always | never
  strict-mode: false
  sensitive-words: []
  cache-user-id: false

debug: "off"            # off | errors | verbose
```

如果你要跑较长的 Claude Code 任务，也可以单独配置上游超时：

```yaml
timeouts:
  messages-ms: 120000
  stream-messages-ms: 600000
  count-tokens-ms: 30000
```

默认情况下，流式上游请求会允许持续 10 分钟后才会被 auth2api 主动中断。

默认请求体大小限制现在是 `200mb`，比之前固定的 `20mb` 更适合 Claude Code 的大上下文使用场景。

`debug` 现在支持三级日志：
- `off`：不输出额外调试日志
- `errors`：记录上游/网络失败信息和上游错误响应正文
- `verbose`：在 `errors` 基础上，再输出每个请求的方法、路径、状态码和耗时

## 使用方法

将任意 OpenAI 兼容客户端指向 `http://127.0.0.1:8317`：

```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 1024
  }'
```

### 支持的模型

| 模型 ID | 说明 |
|--------|------|
| `claude-opus-4-6` | Claude Opus 4.6 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 |
| `claude-haiku-4-5` | Claude Haiku 4.5 的别名 |

auth2api 额外支持以下便捷别名：

- `opus` -> `claude-opus-4-6`
- `sonnet` -> `claude-sonnet-4-6`
- `haiku` -> `claude-haiku-4-5-20251001`

### 接口列表

| Endpoint | 鉴权 | 说明 |
|----------|------|------|
| `POST /v1/chat/completions` | `api-keys` | OpenAI 兼容聊天接口 |
| `POST /v1/responses` | `api-keys` | OpenAI Responses API 兼容接口 |
| `POST /v1/messages` | `api-keys` | Claude 原生消息透传 |
| `POST /v1/messages/count_tokens` | `api-keys` | Claude token 计数 |
| `GET /v1/models` | `api-keys` | 列出可用模型 |
| `GET /admin/accounts` | `admin-keys` | 查看账号池状态 |
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

auth2api 开箱即支持一个或多个 Claude OAuth 账号。

- 为每个账号各执行一次 `--login`。相同邮箱会刷新已保存的 token，新邮箱会追加到账号池。
- 启动时会自动加载 `auth-dir` 目录下所有 `claude-<email>.json` 文件。
- 请求走粘性轮询（sticky round-robin）：同一账号会被连续使用 20–60 分钟再切换；当账号进入 cooldown 时会立即切到下一个可用账号。
- 上游错误（`429`、`401`、`403`、`5xx`、网络错误）按类型分类，触发指数退避 cooldown，账号池继续用剩余账号服务请求。
- 连续失败达到阈值的账号会被**自动禁用**并跳过，同时输出 `[WARNING]` 日志。恢复方式：通过下方 admin 接口一键恢复，或对该邮箱重新执行 `--login`。

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

## Smoke 测试

仓库内置了一套最小自动化 smoke test，并使用 mocked upstream response，因此不会调用真实 Claude 服务：

```bash
npm run test:smoke
```

## 致谢

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [sub2api](https://github.com/Wei-Shaw/sub2api)

## License

MIT
