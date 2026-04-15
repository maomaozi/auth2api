# auth2api

[中文](./README_CN.md)

A lightweight multi-provider OAuth to API proxy supporting Claude, Codex (OpenAI/ChatGPT), and Gemini (Google).

auth2api turns OAuth login sessions into usable API endpoints, with a unified OpenAI-compatible interface:

- one or more accounts per provider, automatically rotated
- one local or self-hosted proxy
- automatic model routing — send `claude-sonnet-4-6`, `gpt-4o`, or `gemini-2.5-pro` and auth2api routes to the right provider

## Features

- **Multi-provider support** — Claude, Codex (OpenAI GPT/o-series), and Gemini behind a single proxy
- **Automatic model routing** — requests are routed to the correct provider based on model name prefix
- **Custom model aliases** — define short names for frequently used models in config
- **Account pool with auto-rotation** — per-provider sticky round-robin across multiple accounts, with exponential-backoff cooldowns on upstream errors
- **Auto-disable on repeated failures** — a failing account is automatically disabled after consecutive errors and can be re-enabled via an admin endpoint
- **Automatic token refresh** — proactive token refresh before expiry (5 min lead for Codex, 30 min for Gemini)
- **OpenAI-compatible API** — all providers served through `/v1/chat/completions` and `/v1/models`
- **Claude native passthrough** — supports `/v1/messages` and `/v1/messages/count_tokens`
- **Streaming, tools, images, and reasoning** — full request/response translation per provider, including SSE streaming
- **Per-API-key usage tracking** — request counts and token usage tracked per API key and per model
- **Separate usage and admin keys** — `api-keys` grant model access only; `admin-keys` are required to manage the account pool
- **Basic safety defaults** — timing-safe key validation, per-IP rate limiting, localhost-only browser CORS

## Requirements

- Node.js 20+
- At least one account from a supported provider:
  - **Claude** — Claude Max subscription recommended
  - **Codex** — OpenAI account with Codex access (ChatGPT Plus/Pro)
  - **Gemini** — Google account with Gemini CLI access

## Installation

```bash
git clone https://github.com/AmazingAng/auth2api
cd auth2api
npm install
npm run build
```

## Login

Each provider has its own login command. Run once per account you want to add.

| Provider | Command |
|----------|---------|
| Claude | `node dist/index.js --login` (or `--claude-login`) |
| Codex (OpenAI) | `node dist/index.js --codex-login` |
| Gemini (Google) | `node dist/index.js --gemini-login` |

### Auto mode (requires local browser)

```bash
node dist/index.js --login          # Claude
node dist/index.js --codex-login    # Codex
node dist/index.js --gemini-login   # Gemini
```

Opens a browser URL. After authorizing, the callback is handled automatically.

### Manual mode (for remote servers)

Append `--manual` to any login command:

```bash
node dist/index.js --codex-login --manual
```

Open the printed URL in your browser. After authorizing, your browser will redirect to a `localhost` URL that fails to load — copy the full URL from the address bar and paste it back into the terminal.

## Starting the server

```bash
node dist/index.js
```

The server starts on `http://127.0.0.1:8317` by default. On first run, an API key is auto-generated and saved to `config.yaml`.

If every account for a provider is temporarily cooled down after upstream rate limiting, auth2api returns `429 Rate limited on the configured <provider> account` instead of a generic `503`.

## Configuration

Copy `config.example.yaml` to `config.yaml` and edit as needed:

```yaml
host: ""          # bind address, empty = 127.0.0.1
port: 8317

auth-dir: "~/.auth2api"   # where OAuth tokens are stored

api-keys:
  - "your-api-key-here"   # clients use these to call /v1/* (model access only)

# Separate admin keys for /admin/*. Usage keys cannot manage the account pool.
# Leave empty to disable /admin/* entirely (returns 404, indistinguishable
# from a non-existent route).
admin-keys: []
  # - "your-admin-key-here"

body-limit: "200mb"       # maximum JSON request body size, useful for large-context usage

cloaking:                 # only applies to Claude provider
  mode: "auto"            # auto | always | never
  strict-mode: false
  sensitive-words: []
  cache-user-id: false

debug: "off"            # off | errors | verbose

# Custom model aliases (optional)
# model-alias:
#   "smart": "claude-sonnet-4-6"
#   "fast": "gemini-2.5-flash"
#   "my-gpt": { provider: "codex", model: "gpt-4o" }
```

Timeouts can also be configured if you run long tasks:

```yaml
timeouts:
  messages-ms: 120000         # non-streaming request timeout
  stream-messages-ms: 600000  # streaming request timeout (10 min)
  count-tokens-ms: 30000      # token counting timeout (Claude only)
```

`debug` supports three levels:
- `off`: no extra logs
- `errors`: log upstream/network failures and upstream error bodies
- `verbose`: include `errors` logs plus per-request method, path, status, and duration

## Usage

Use any OpenAI-compatible client pointed at `http://127.0.0.1:8317`. The model name determines which provider handles the request:

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

### Model routing

Requests are automatically routed by model name prefix:

| Prefix | Provider |
|--------|----------|
| `claude-`, `opus`, `sonnet`, `haiku` | Claude |
| `gpt-`, `o1`, `o3`, `o4`, `codex-`, `chatgpt-` | Codex (OpenAI) |
| `gemini-` | Gemini (Google) |

You can also define custom aliases in `config.yaml`:

```yaml
model-alias:
  "smart": "claude-sonnet-4-6"
  "fast": "gemini-2.5-flash"
  "my-gpt": { provider: "codex", model: "gpt-4o" }
```

### Supported models

**Claude** (requires Claude OAuth login):

| Model ID | Description |
|----------|-------------|
| `claude-opus-4-6` | Claude Opus 4.6 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 |

Short aliases: `opus`, `sonnet`, `haiku`

**Codex** (requires OpenAI OAuth login):

Any model available through the Codex CLI backend, including `gpt-4o`, `o4-mini`, `o3`, `codex-mini`, etc.

**Gemini** (requires Google OAuth login):

Any model available through the Gemini CLI backend, including `gemini-2.5-pro`, `gemini-2.5-flash`, etc.

### Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /v1/chat/completions` | `api-keys` | OpenAI-compatible chat (all providers) |
| `POST /v1/responses` | `api-keys` | OpenAI Responses API compatibility |
| `POST /v1/messages` | `api-keys` | Claude native passthrough |
| `POST /v1/messages/count_tokens` | `api-keys` | Claude token counting |
| `GET /v1/models` | `api-keys` | List available models |
| `GET /admin/accounts` | `admin-keys` | Account pool snapshot |
| `GET /admin/api-keys` | `admin-keys` | Per-API-key usage statistics |
| `POST /admin/accounts/:email/enable` | `admin-keys` | Re-enable a disabled account |
| `GET /health` | none | Health check |

When `admin-keys` is empty, the `/admin/*` routes are unregistered and return a plain `404`.

## Docker

```bash
# Build
docker build -t auth2api .

# Run (mount your config and token directory)
docker run -d \
  -p 8317:8317 \
  -v ~/.auth2api:/data \
  -v ./config.yaml:/config/config.yaml \
  auth2api
```

Or with docker-compose:

```bash
docker-compose up -d
```

## Use with Claude Code

Set `ANTHROPIC_BASE_URL` to point Claude Code at auth2api:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8317 \
ANTHROPIC_API_KEY=<your-api-key> \
claude
```

Claude Code uses the native `/v1/messages` endpoint which auth2api passes through directly. Both `Authorization: Bearer` and `x-api-key` authentication headers are supported.

## Account pool

auth2api maintains separate account pools per provider. Each pool operates independently with its own rotation and cooldown tracking.

- Run the appropriate login command once per account (`--login`, `--codex-login`, or `--gemini-login`). Logging in with an existing email refreshes that account's token; a new email appends to the pool.
- At startup, all `{provider}-{email}.json` files in the auth directory are loaded (e.g. `claude-user@example.com.json`, `codex-user@example.com.json`, `gemini-user@gmail.com.json`).
- Requests are routed via **per-provider sticky round-robin**: the current account is reused for 20-60 minutes before rotating, or earlier if the account enters cooldown.
- Upstream errors (`429`, `401`, `403`, `5xx`, network failures) are classified and put the affected account on an exponential-backoff cooldown so the pool keeps serving traffic via remaining accounts.
- On `401`, auth2api attempts an automatic token refresh before retrying.
- Codex-specific: "model at capacity" errors and `usage_limit_reached` responses are handled with precise cooldown parsing from the `resets_at`/`resets_in_seconds` fields.
- An account with 10+ consecutive failures is automatically **disabled** with a `[WARNING]` log. Re-enable via the admin endpoint or by re-running the login command.
- Token refresh runs proactively in the background (checked every 60s): 5 minutes before expiry for Codex, 30 minutes for Gemini.

## Admin endpoints

Configure `admin-keys` in `config.yaml` to enable the management API. When `admin-keys` is empty, `/admin/*` is unreachable (returns `404`, identical to a non-existent path).

Inspect the account pool:

```bash
curl http://127.0.0.1:8317/admin/accounts \
  -H "Authorization: Bearer <your-admin-key>"
```

The response includes per-account availability, `disabled` flag, cooldown, failure counters, last refresh time, and basic request/token statistics.

Re-enable a disabled account without restarting:

```bash
curl -X POST http://127.0.0.1:8317/admin/accounts/<email>/enable \
  -H "Authorization: Bearer <your-admin-key>"
```

Usage keys from `api-keys` **cannot** access any `/admin/*` endpoint — they receive `403 Invalid admin key`.

## Architecture

```
Client (OpenAI-compatible)
  │
  ▼
/v1/chat/completions
  │
  ├── model prefix routing ──▶ Provider selection
  │
  ├── Claude  ──▶ Claude Messages API  (api.anthropic.com)
  ├── Codex   ──▶ Codex Responses API  (chatgpt.com/backend-api/codex)
  └── Gemini  ──▶ Gemini CLI API       (cloudcode-pa.googleapis.com)
  │
  ▼
Response translated back to OpenAI format
```

Each provider has dedicated translation layers:
- **Request**: OpenAI chat completions format → provider-native format
- **Response**: provider-native format → OpenAI chat completions format
- **SSE streaming**: provider SSE events → OpenAI SSE chunks

## Smoke tests

A minimal automated smoke test suite is included and uses mocked upstream responses, so it does not call any real service:

```bash
npm run test:smoke
```

## Inspired by

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [sub2api](https://github.com/Wei-Shaw/sub2api)

## License

MIT
