import crypto from "crypto";
import { TimeoutConfig } from "../config";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_USER_AGENT =
  "codex-tui/0.118.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9 (codex-tui; 0.118.0)";

// Persistent session IDs per account for prompt caching
const sessionIdCache = new Map<string, string>();

function getSessionId(accountUuid: string | undefined): string {
  const key = accountUuid || "__default__";
  let id = sessionIdCache.get(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionIdCache.set(key, id);
  }
  return id;
}

/**
 * Call the Codex CLI backend endpoint.
 *
 * Uses chatgpt.com/backend-api/codex/responses (the real Codex CLI endpoint),
 * NOT api.openai.com (which requires an API key, not an OAuth token).
 *
 * Request format: OpenAI Responses API.
 * Response format: SSE with Responses API events.
 */
export async function callCodexAPI(
  accessToken: string,
  body: any,
  stream: boolean,
  timeouts: TimeoutConfig,
  accountUuid?: string,
): Promise<Response> {
  const path = stream ? "/responses" : "/responses/compact";
  const url = `${CODEX_BASE_URL}${path}`;
  const timeoutMs = stream
    ? timeouts["stream-messages-ms"]
    : timeouts["messages-ms"];

  // Build clean body — avoid mutating the caller's object
  const {
    previous_response_id,
    stream_options,
    prompt_cache_retention,
    safety_identifier,
    ...cleanBody
  } = body;
  cleanBody.stream = stream;

  const sessionId = getSessionId(accountUuid);
  cleanBody.prompt_cache_key = sessionId;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": CODEX_USER_AGENT,
    Accept: stream ? "text/event-stream" : "application/json",
    Connection: "Keep-Alive",
    Originator: "codex-tui",
    Session_id: sessionId,
  };

  // Set account ID if available (required for OAuth-based access)
  if (accountUuid) {
    headers["Chatgpt-Account-Id"] = accountUuid;
  }

  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(cleanBody),
    signal: AbortSignal.timeout(timeoutMs),
  });
}
