import { Response as ExpressResponse } from "express";
import { AccountFailureKind, UsageData } from "../accounts/manager";
import { ProviderType } from "../auth/provider-interface";
import { Config } from "../config";
import { callClaudeAPI } from "./claude-api";
import { callCodexAPI } from "./codex-api";
import { callGeminiAPI } from "./gemini-api";

export const EFFORT_TO_BUDGET: Record<string, number> = {
  none: 0,
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 32768,
};

export const MAX_RETRIES = 3;
export const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export function classifyFailure(status: number): AccountFailureKind {
  if (status === 429) return "rate_limit";
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  return "server";
}

export function extractUsage(resp: any): UsageData {
  return {
    inputTokens: resp.usage?.input_tokens || resp.usage?.prompt_tokens || 0,
    outputTokens: resp.usage?.output_tokens || resp.usage?.completion_tokens || 0,
    cacheCreationInputTokens: resp.usage?.cache_creation_input_tokens || 0,
    cacheReadInputTokens: resp.usage?.cache_read_input_tokens || 0,
  };
}

/**
 * Call the appropriate upstream API based on provider type.
 */
export async function callUpstream(
  provider: ProviderType,
  accessToken: string,
  body: any,
  stream: boolean,
  config: Config,
  apiKeyHash: string,
  accountUuid?: string,
): Promise<globalThis.Response> {
  switch (provider) {
    case "codex":
      return callCodexAPI(accessToken, body, stream, config.timeouts, accountUuid);
    case "gemini":
      return callGeminiAPI(accessToken, body, stream, config.timeouts);
    case "claude":
      return callClaudeAPI(
        accessToken,
        body,
        stream,
        config.timeouts,
        config.cloaking,
        apiKeyHash,
      );
  }
}

/**
 * Send the upstream error body back to the client.
 * Tries to parse raw body as JSON; falls back to a generic message.
 */
export function sendUpstreamError(
  res: ExpressResponse,
  status: number,
  rawBody: string,
): void {
  try {
    const parsed = rawBody ? JSON.parse(rawBody) : null;
    if (parsed && typeof parsed === "object") {
      res.status(status).json(parsed);
    } else {
      res.status(status).json({ error: { message: "Upstream request failed" } });
    }
  } catch {
    res.status(status).json({ error: { message: "Upstream request failed" } });
  }
}
