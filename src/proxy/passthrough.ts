import { Request, Response as ExpressResponse } from "express";
import { extractApiKeyInfo } from "../api-key";
import { Config, isDebugLevel } from "../config";
import { AccountManager, TrackingContext, UsageData } from "../accounts/manager";
import { ProviderType } from "../auth/provider-interface";
import { applyCloaking } from "./cloaking";
import { callClaudeAPI, callClaudeCountTokens } from "./claude-api";
import { resolveProvider, resolveModelAlias } from "./model-router";
import {
  claudeRequestToOpenai,
  openaiResponseToClaude,
  openaiStreamChunkToClaudeEvents,
  createReverseStreamState,
} from "./translator";
import {
  chatCompletionsToCodexRequest,
  codexResponseToOpenAI,
  codexSSEToOpenAI,
  createCodexStreamState,
  ToolNameMap,
  claudeToCodexRequest,
  codexResponseToClaudeDirect,
  codexSSEToClaudeEvents,
  createCodexToClaudeStreamState,
} from "./codex-translator";
import {
  openaiToGeminiCLI,
  geminiToOpenAI,
  geminiSSEToOpenAI,
  createGeminiStreamState,
  claudeToGeminiCLI,
  geminiResponseToClaudeDirect,
  geminiSSEToClaudeEvents,
  createGeminiToClaudeStreamState,
} from "./gemini-translator";
import {
  MAX_RETRIES,
  RETRYABLE_STATUSES,
  classifyFailure,
  extractUsage,
  sendUpstreamError,
  callUpstream,
  extractProviderUsage,
  isCodexModelCapacityError,
  parseCodexRetryAfter,
} from "./shared";

// ── Claude passthrough (existing logic, unchanged) ──

async function handleClaudePassthrough(
  req: Request,
  res: ExpressResponse,
  config: Config,
  manager: AccountManager,
  body: any,
  stream: boolean,
  model: string,
  tracking: TrackingContext,
  apiKeyHash: string,
): Promise<void> {
  // When request comes from claude-cli, pass through anthropic-* and session headers
  const userAgent = req.headers["user-agent"] || "";
  let passthroughHeaders: Record<string, string> | undefined;
  let overrideSessionId: string | undefined;
  if (userAgent.startsWith("claude-cli")) {
    passthroughHeaders = { "User-Agent": userAgent };
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.startsWith("anthropic") && typeof value === "string") {
        passthroughHeaders[key] = value;
      }
    }
    const sessionId = req.headers["x-claude-code-session-id"];
    if (typeof sessionId === "string") {
      passthroughHeaders["X-Claude-Code-Session-Id"] = sessionId;
      overrideSessionId = sessionId;
    }
  }

  let lastStatus = 500;
  let lastErrBody = "";
  const refreshedAccounts = new Set<string>();
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { account, total } = manager.getNextAccount("claude");
    if (!account) {
      const status = total === 0 ? 503 : 429;
      const message =
        total === 0
          ? "No available claude account"
          : "Rate limited on the configured claude account";
      res.status(status).json({ error: { message } });
      return;
    }

    manager.recordAttempt(account.token.email, "claude", tracking);

    // Apply per-account cloaking (clone body so each attempt is fresh)
    const claudeBody = applyCloaking(
      structuredClone(body),
      account.deviceId,
      account.accountUuid,
      apiKeyHash,
      config.cloaking,
      overrideSessionId,
    );

    // Debug: log final request body after cloaking
    if (isDebugLevel(config.debug, "verbose")) {
      console.log("[DEBUG] Final /v1/messages body after cloaking:");
      console.log(JSON.stringify(claudeBody, null, 2));
    }

    let upstreamResp: globalThis.Response;
    try {
      upstreamResp = await callClaudeAPI(
        account.token.accessToken,
        claudeBody,
        stream,
        config.timeouts,
        config.cloaking,
        apiKeyHash,
        passthroughHeaders,
      );
    } catch (err: any) {
      manager.recordFailure(account.token.email, "network", err.message, "claude", tracking);
      if (isDebugLevel(config.debug, "errors")) {
        console.error(
          `Messages attempt ${attempt + 1} network failure: ${err.message}`,
        );
      }
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
        continue;
      }
      res.status(502).json({
        error: { message: "Upstream network error" },
      });
      return;
    }

    if (upstreamResp.ok) {
      if (stream) {
        // Pipe SSE directly — no translation needed
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        const reader = upstreamResp.body?.getReader();
        if (!reader) {
          res.end();
          return;
        }

        let clientDisconnected = false;
        const usage: UsageData = {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        };
        let sseBuffer = "";
        let currentEvent = "";
        res.on("close", () => {
          clientDisconnected = true;
          reader.cancel().catch(() => {});
        });

        try {
          while (!clientDisconnected) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            res.write(chunk);

            // Parse SSE to extract usage
            sseBuffer += chunk.toString();
            const lines = sseBuffer.split("\n");
            sseBuffer = lines.pop() ?? "";
            for (const line of lines) {
              if (line.startsWith("event:")) {
                currentEvent = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                const raw = line.slice(5).trim();
                if (!raw || raw === "[DONE]") continue;
                try {
                  const data = JSON.parse(raw);
                  if (currentEvent === "message_start") {
                    const u = data.message?.usage;
                    usage.inputTokens = u?.input_tokens || 0;
                    usage.cacheCreationInputTokens =
                      u?.cache_creation_input_tokens || 0;
                    usage.cacheReadInputTokens =
                      u?.cache_read_input_tokens || 0;
                  } else if (currentEvent === "message_delta") {
                    usage.outputTokens = data.usage?.output_tokens || 0;
                  }
                } catch {
                  /* ignore parse errors */
                }
              }
            }
          }
          if (!clientDisconnected) {
            manager.recordSuccess(account.token.email, "claude", tracking);
            manager.recordUsage(account.token.email, usage, "claude", tracking);
          }
        } catch (err) {
          if (!clientDisconnected) {
            manager.recordFailure(
              account.token.email,
              "network",
              "stream terminated before completion",
              "claude",
              tracking,
            );
          }
          if (!clientDisconnected) console.error("Stream pipe error:", err);
        } finally {
          if (!clientDisconnected) res.end();
        }
      } else {
        // Forward JSON response directly
        const data = await upstreamResp.json();
        manager.recordSuccess(account.token.email, "claude", tracking);
        manager.recordUsage(account.token.email, extractUsage(data), "claude", tracking);
        res.json(data);
      }
      return;
    }

    lastStatus = upstreamResp.status;
    try {
      lastErrBody = await upstreamResp.text();
      if (isDebugLevel(config.debug, "errors")) {
        console.error(
          `Messages attempt ${attempt + 1} failed (${lastStatus}): ${lastErrBody}`,
        );
      }
    } catch {
      /* ignore */
    }

    if (lastStatus === 401) {
      const refreshed = await manager.refreshAccount(account.token.email, "claude");
      if (refreshed && !refreshedAccounts.has(account.token.email)) {
        refreshedAccounts.add(account.token.email);
        attempt--;
        continue;
      }
    } else {
      manager.recordFailure(
        account.token.email,
        classifyFailure(lastStatus),
        undefined,
        "claude",
        tracking,
      );
    }
    if (!RETRYABLE_STATUSES.has(lastStatus)) break;
    if (attempt < MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
    }
  }

  sendUpstreamError(res, lastStatus, lastErrBody);
}

// ── Non-Claude provider routing (Codex / Gemini) ──

function prepareProviderBody(
  provider: ProviderType,
  openaiBody: any,
  model: string,
  projectId: string,
): { body: any; toolNameMap: ToolNameMap } {
  const bodyWithModel = { ...openaiBody, model };
  switch (provider) {
    case "codex": {
      const result = chatCompletionsToCodexRequest(bodyWithModel);
      return { body: result.body, toolNameMap: result.toolNameMap };
    }
    case "gemini":
      return { body: openaiToGeminiCLI(bodyWithModel, projectId), toolNameMap: new Map() };
    default:
      return { body: bodyWithModel, toolNameMap: new Map() };
  }
}

function translateProviderResponse(
  provider: ProviderType,
  respData: any,
  model: string,
  toolNameMap?: ToolNameMap,
): any {
  switch (provider) {
    case "codex":
      return codexResponseToOpenAI(respData, model, toolNameMap);
    case "gemini":
      return geminiToOpenAI(respData, model);
    default:
      return respData;
  }
}

async function handleNonClaudeMessages(
  res: ExpressResponse,
  config: Config,
  manager: AccountManager,
  body: any,
  stream: boolean,
  rawModel: string,
  provider: ProviderType,
  tracking: TrackingContext,
  apiKeyHash: string,
): Promise<void> {
  const model = resolveModelAlias(rawModel);

  if (isDebugLevel(config.debug, "verbose")) {
    console.log(`[DEBUG] /v1/messages routed to provider: ${provider}, model: ${model}`);
  }

  // Prepare request body (direct Claude → provider translation, no intermediate OpenAI)
  let precomputed: { body: any; toolNameMap: ToolNameMap } | null = null;
  if (provider === "codex") {
    precomputed = claudeToCodexRequest({ ...body, model });
  } else if (provider === "gemini") {
    // Gemini: compute base once, patch projectId per account in the loop
    precomputed = { body: claudeToGeminiCLI({ ...body, model }, ""), toolNameMap: new Map() };
  }

  let lastStatus = 500;
  let lastErrBody = "";
  const refreshedAccounts = new Set<string>();
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { account, total } = manager.getNextAccount(provider);
    if (!account) {
      const status = total === 0 ? 503 : 429;
      const message =
        total === 0
          ? `No available ${provider} account`
          : `Rate limited on the configured ${provider} account`;
      res.status(status).json({ error: { message } });
      return;
    }

    manager.recordAttempt(account.token.email, provider, tracking);

    const prepared = precomputed!;
    // Patch per-account projectId for Gemini
    if (provider === "gemini") prepared.body.project = account.projectId;
    const toolNameMap = prepared.toolNameMap;

    if (isDebugLevel(config.debug, "verbose")) {
      console.log("[DEBUG] Final provider body:");
      console.log(JSON.stringify(prepared.body, null, 2));
    }

    let upstreamResp: globalThis.Response;
    try {
      upstreamResp = await callUpstream(
        provider,
        account.token.accessToken,
        prepared.body,
        stream,
        config,
        apiKeyHash,
        account.accountUuid,
      );
    } catch (err: any) {
      manager.recordFailure(account.token.email, "network", err.message, provider, tracking);
      if (isDebugLevel(config.debug, "errors")) {
        console.error(
          `Messages attempt ${attempt + 1} network failure (${provider}): ${err.message}`,
        );
      }
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
        continue;
      }
      res.status(502).json({ error: { message: "Upstream network error" } });
      return;
    }

    if (upstreamResp.ok) {
      if (stream) {
        if (provider === "codex") {
          const codexState = createCodexToClaudeStreamState(model, toolNameMap);
          await handleDirectStream(
            provider, upstreamResp, res, account, manager, tracking,
            codexState, (data) => codexSSEToClaudeEvents(data, codexState),
          );
        } else if (provider === "gemini") {
          const geminiState = createGeminiToClaudeStreamState(model);
          await handleDirectStream(
            provider, upstreamResp, res, account, manager, tracking,
            geminiState, (data) => geminiSSEToClaudeEvents(data, geminiState),
          );
        } else {
          await handleProviderToClaudeStream(
            provider, upstreamResp, res, model, account, manager, tracking, toolNameMap,
          );
        }
      } else {
        const respData = await upstreamResp.json();
        manager.recordSuccess(account.token.email, provider, tracking);
        manager.recordUsage(account.token.email, extractProviderUsage(provider, respData), provider, tracking);
        if (provider === "codex") {
          res.json(codexResponseToClaudeDirect(respData, model, toolNameMap));
        } else if (provider === "gemini") {
          res.json(geminiResponseToClaudeDirect(respData, model));
        } else {
          const openaiResp = translateProviderResponse(provider, respData, model, toolNameMap);
          res.json(openaiResponseToClaude(openaiResp, model));
        }
      }
      return;
    }

    lastStatus = upstreamResp.status;
    try {
      lastErrBody = await upstreamResp.text();
      if (isDebugLevel(config.debug, "errors")) {
        console.error(
          `Messages attempt ${attempt + 1} failed (${provider}, ${lastStatus}): ${lastErrBody}`,
        );
      }
    } catch { /* ignore */ }

    // Codex "model at capacity" → treat as 429
    if (provider === "codex" && isCodexModelCapacityError(lastErrBody)) {
      lastStatus = 429;
    }

    if (lastStatus === 401) {
      const refreshed = await manager.refreshAccount(account.token.email, provider);
      if (refreshed && !refreshedAccounts.has(account.token.email)) {
        refreshedAccounts.add(account.token.email);
        attempt--;
        continue;
      }
    } else {
      const retryAfterMs =
        provider === "codex" && lastStatus === 429
          ? parseCodexRetryAfter(lastErrBody)
          : undefined;
      manager.recordFailure(
        account.token.email,
        classifyFailure(lastStatus),
        undefined,
        provider,
        tracking,
        retryAfterMs,
      );
    }

    if (!RETRYABLE_STATUSES.has(lastStatus)) break;
    if (attempt < MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
    }
  }

  sendUpstreamError(res, lastStatus, lastErrBody);
}

/**
 * Generic handler: stream upstream SSE → Claude Messages SSE via a converter function.
 * Used by both Codex and Gemini direct translation paths.
 */
async function handleDirectStream(
  provider: ProviderType,
  upstreamResp: globalThis.Response,
  res: ExpressResponse,
  account: { token: { email: string }; accountUuid: string; projectId: string },
  manager: AccountManager,
  tracking: TrackingContext,
  state: { inputTokens: number; outputTokens: number },
  convertChunk: (data: any) => string[],
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const reader = upstreamResp.body?.getReader();
  if (!reader) { res.end(); return; }

  let clientDisconnected = false;
  let sseBuffer = "";
  const decoder = new TextDecoder();

  res.on("close", () => {
    clientDisconnected = true;
    reader.cancel().catch(() => {});
  });

  try {
    while (!clientDisconnected) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (clientDisconnected) break;
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;

        try {
          const data = JSON.parse(raw);
          const claudeEvents = convertChunk(data);
          for (const event of claudeEvents) {
            if (!clientDisconnected) res.write(event);
          }
        } catch { /* ignore parse errors */ }
      }
    }

    if (!clientDisconnected) {
      manager.recordSuccess(account.token.email, provider, tracking);
      manager.recordUsage(account.token.email, {
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }, provider, tracking);
    }
  } catch {
    if (!clientDisconnected) {
      manager.recordFailure(
        account.token.email, "network",
        "stream terminated before completion", provider, tracking,
      );
    }
  } finally {
    if (!clientDisconnected) res.end();
  }
}

/**
 * Handle streaming from a non-Claude provider, translating SSE to Claude Messages SSE format.
 * Pipeline: Provider SSE → OpenAI SSE chunks → Claude SSE events
 */
async function handleProviderToClaudeStream(
  provider: ProviderType,
  upstreamResp: globalThis.Response,
  res: ExpressResponse,
  model: string,
  account: { token: { email: string }; accountUuid: string; projectId: string },
  manager: AccountManager,
  tracking: TrackingContext,
  toolNameMap?: ToolNameMap,
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const reader = upstreamResp.body?.getReader();
  if (!reader) { res.end(); return; }

  let clientDisconnected = false;
  let sseBuffer = "";
  const decoder = new TextDecoder();

  const codexState = provider === "codex" ? createCodexStreamState(model, toolNameMap) : null;
  const geminiState = provider === "gemini" ? createGeminiStreamState(model) : null;
  const reverseState = createReverseStreamState(model);

  res.on("close", () => {
    clientDisconnected = true;
    reader.cancel().catch(() => {});
  });

  try {
    while (!clientDisconnected) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (clientDisconnected) break;
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;

        try {
          const data = JSON.parse(raw);
          let openaiChunks: string[] = [];

          if (provider === "codex" && codexState) {
            openaiChunks = codexSSEToOpenAI(data, codexState);
          } else if (provider === "gemini" && geminiState) {
            openaiChunks = geminiSSEToOpenAI(data, geminiState);
          }

          for (const chunkStr of openaiChunks) {
            if (clientDisconnected) break;
            if (chunkStr === "[DONE]") continue; // We'll send our own message_stop

            // Parse the OpenAI chunk and convert to Claude SSE events
            try {
              const openaiChunk = JSON.parse(chunkStr);
              const claudeEvents = openaiStreamChunkToClaudeEvents(openaiChunk, reverseState);
              for (const event of claudeEvents) {
                if (!clientDisconnected) res.write(event);
              }
            } catch { /* ignore parse errors */ }
          }
        } catch { /* ignore parse errors */ }
      }
    }

    if (!clientDisconnected) {
      // Ensure the stream is properly terminated with message_stop
      // (openaiStreamChunkToClaudeEvents handles this when it sees finish_reason)
      manager.recordSuccess(account.token.email, provider, tracking);
      const usage: UsageData = codexState
        ? { inputTokens: codexState.inputTokens, outputTokens: codexState.outputTokens, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
        : geminiState
          ? { inputTokens: geminiState.inputTokens, outputTokens: geminiState.outputTokens, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
          : { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
      manager.recordUsage(account.token.email, usage, provider, tracking);
    }
  } catch {
    if (!clientDisconnected) {
      manager.recordFailure(
        account.token.email, "network",
        "stream terminated before completion", provider, tracking,
      );
    }
  } finally {
    if (!clientDisconnected) res.end();
  }
}

// ── Express handler: POST /v1/messages ──

export function createMessagesHandler(config: Config, manager: AccountManager) {
  return async (req: Request, res: ExpressResponse): Promise<void> => {
    try {
      const body = req.body;
      if (
        !body.messages ||
        !Array.isArray(body.messages) ||
        body.messages.length === 0
      ) {
        res.status(400).json({
          error: {
            message: "messages is required and must be a non-empty array",
          },
        });
        return;
      }

      // Debug: log incoming request body
      if (isDebugLevel(config.debug, "verbose")) {
        console.log("[DEBUG] Incoming /v1/messages body:");
        console.log(JSON.stringify(body, null, 2));
      }

      const stream = !!body.stream;
      const rawModel = body.model || "claude-sonnet-4-6";
      const provider = resolveProvider(rawModel);
      const { apiKeyHash, keyPrefix } = extractApiKeyInfo(req.headers);
      const tracking: TrackingContext = { apiKeyHash, keyPrefix, model: rawModel };

      if (isDebugLevel(config.debug, "verbose")) {
        console.log(`[DEBUG] /v1/messages provider: ${provider}, model: ${rawModel}`);
      }

      if (provider === "claude") {
        // Existing Claude passthrough — no translation needed
        await handleClaudePassthrough(
          req, res, config, manager, body, stream, rawModel, tracking, apiKeyHash,
        );
      } else {
        // Non-Claude provider: translate Claude format → provider format → Claude format
        await handleNonClaudeMessages(
          res, config, manager, body, stream, rawModel, provider, tracking, apiKeyHash,
        );
      }
    } catch (err: any) {
      console.error("Messages handler error:", err.message);
      res.status(500).json({
        error: { message: "Internal server error" },
      });
    }
  };
}

// POST /v1/messages/count_tokens — passthrough (Claude only)
export function createCountTokensHandler(
  config: Config,
  manager: AccountManager,
) {
  return async (req: Request, res: ExpressResponse): Promise<void> => {
    try {
      const { apiKeyHash, keyPrefix } = extractApiKeyInfo(req.headers);
      const tracking: TrackingContext = { apiKeyHash, keyPrefix };

      let lastStatus = 500;
      let lastErrBody = "";
      const refreshedAccounts = new Set<string>();
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const { account, total } = manager.getNextAccount("claude");
        if (!account) {
          const status = total === 0 ? 503 : 429;
          const message =
            total === 0
              ? "No available claude account"
              : "Rate limited on the configured claude account";
          res.status(status).json({ error: { message } });
          return;
        }

        manager.recordAttempt(account.token.email, "claude", tracking);

        let upstreamResp: globalThis.Response;
        try {
          upstreamResp = await callClaudeCountTokens(
            account.token.accessToken,
            req.body,
            config.timeouts,
            config.cloaking,
            apiKeyHash,
          );
        } catch (err: any) {
          manager.recordFailure(account.token.email, "network", err.message, "claude", tracking);
          if (isDebugLevel(config.debug, "errors")) {
            console.error(
              `Count tokens attempt ${attempt + 1} network failure: ${err.message}`,
            );
          }
          if (attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
            continue;
          }
          res.status(502).json({
            error: { message: "Upstream network error" },
          });
          return;
        }

        if (upstreamResp.ok) {
          manager.recordSuccess(account.token.email, "claude", tracking);
          const data = await upstreamResp.json();
          res.json(data);
          return;
        }

        lastStatus = upstreamResp.status;
        lastErrBody = await upstreamResp.text().catch(() => "");
        if (lastStatus === 401) {
          const refreshed = await manager.refreshAccount(account.token.email, "claude");
          if (refreshed && !refreshedAccounts.has(account.token.email)) {
            refreshedAccounts.add(account.token.email);
            attempt--;
            continue;
          }
        } else {
          manager.recordFailure(
            account.token.email,
            classifyFailure(lastStatus),
            undefined,
            "claude",
            tracking,
          );
        }

        if (!RETRYABLE_STATUSES.has(lastStatus)) break;
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
        }
      }

      sendUpstreamError(res, lastStatus, lastErrBody);
    } catch (err: any) {
      console.error("Count tokens error:", err.message);
      res.status(500).json({
        error: { message: "Internal server error" },
      });
    }
  };
}
