# auth2api

[中文](./README_CN.md)

A lightweight Claude OAuth to API proxy for Claude Code and OpenAI-compatible clients.

auth2api is intentionally small and focused:

- one or more Claude OAuth accounts, automatically rotated
- one local or self-hosted proxy
- one simple goal: turn Claude OAuth access into a usable API endpoint

It is not trying to be a multi-provider gateway or a large routing platform. If you want a compact, understandable proxy that is easy to run and modify, auth2api is built for that use case.

## Features

- **Lightweight by design** — small codebase, minimal moving parts
- **Claude OAuth to API** — use one or more Claude OAuth logins as API-backed proxy accounts
- **Account pool with auto-rotation** — sticky round-robin across multiple accounts, with exponential-backoff cooldowns on upstream errors
- **Auto-disable on repeated failures** — a failing account is automatically disabled after consecutive errors and can be re-enabled via an admin endpoint
- **OpenAI-compatible API** — supports `/v1/chat/completions`, `/v1/responses`, and `/v1/models`
- **Claude native passthrough** — supports `/v1/messages` and `/v1/messages/count_tokens`
- **Claude Code friendly** — works with both `Authorization: Bearer` and `x-api-key`
- **Streaming, tools, images, and reasoning** — covers the main Claude usage patterns without a large framework
- **Separate usage and admin keys** — `api-keys` grant model access only; `admin-keys` are required to manage the account pool
- **Basic safety defaults** — timing-safe key validation, per-IP rate limiting, localhost-only browser CORS

## Requirements

- Node.js 20+
- A Claude account (Claude Max subscription recommended)

## Installation

```bash
git clone https://github.com/AmazingAng/auth2api
cd auth2api
npm install
npm run build
```

## Login

### Auto mode (requires local browser)

```bash
node dist/index.js --login
```

Opens a browser URL. After authorizing, the callback is handled automatically.

### Manual mode (for remote servers)

```bash
node dist/index.js --login --manual
```

Open the printed URL in your browser. After authorizing, your browser will redirect to a `localhost` URL that fails to load — copy the full URL from the address bar and paste it back into the terminal.

## Starting the server

```bash
node dist/index.js
```

The server starts on `http://127.0.0.1:8317` by default. On first run, an API key is auto-generated and saved to `config.yaml`.

If every configured Claude account is temporarily cooled down after upstream rate limiting, auth2api returns `429 Rate limited on the configured account` instead of a generic `503`.

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

cloaking:
  mode: "auto"            # auto | always | never
  strict-mode: false
  sensitive-words: []
  cache-user-id: false

debug: "off"            # off | errors | verbose
```

Timeouts can also be configured if you run long Claude Code tasks:

```yaml
timeouts:
  messages-ms: 120000
  stream-messages-ms: 600000
  count-tokens-ms: 30000
```

By default, streaming upstream requests are allowed to run for 10 minutes before auth2api aborts them.

The default request body limit is `200mb`, which is more suitable for large Claude Code contexts than the previous fixed `20mb`.

`debug` now supports three levels:
- `off`: no extra logs
- `errors`: log upstream/network failures and upstream error bodies
- `verbose`: include `errors` logs plus per-request method, path, status, and duration

## Usage

Use any OpenAI-compatible client pointed at `http://127.0.0.1:8317`:

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

### Available models

| Model ID | Description |
|----------|-------------|
| `claude-opus-4-6` | Claude Opus 4.6 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 |
| `claude-haiku-4-5` | Alias for Claude Haiku 4.5 |

Short convenience aliases accepted by auth2api:

- `opus` -> `claude-opus-4-6`
- `sonnet` -> `claude-sonnet-4-6`
- `haiku` -> `claude-haiku-4-5-20251001`

### Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /v1/chat/completions` | `api-keys` | OpenAI-compatible chat |
| `POST /v1/responses` | `api-keys` | OpenAI Responses API compatibility |
| `POST /v1/messages` | `api-keys` | Claude native passthrough |
| `POST /v1/messages/count_tokens` | `api-keys` | Claude token counting |
| `GET /v1/models` | `api-keys` | List available models |
| `GET /admin/accounts` | `admin-keys` | Account pool snapshot |
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

auth2api supports one or more Claude OAuth accounts out of the box.

- Run `--login` once per account. Logging in with an email that is already stored refreshes that account's token; logging in with a new email appends it to the pool.
- At startup, every `claude-<email>.json` file in the auth directory is loaded into the pool.
- Requests are routed via sticky round-robin: the current account is reused for 20–60 minutes before rotating, or earlier if the account enters cooldown due to an upstream error.
- Upstream errors (`429`, `401`, `403`, `5xx`, network failures) are classified and put the affected account on an exponential-backoff cooldown so the pool keeps serving traffic via the remaining accounts.
- An account that accumulates enough consecutive failures is automatically **disabled** and skipped by the router, with a `[WARNING]` log. A disabled account can be re-enabled via the admin endpoint below or by re-running `--login` for that email.

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

## Smoke tests

A minimal automated smoke test suite is included and uses mocked upstream responses, so it does not call the real Claude service:

```bash
npm run test:smoke
```

## Inspired by

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [sub2api](https://github.com/Wei-Shaw/sub2api)

## License

MIT
