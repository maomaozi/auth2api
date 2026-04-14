import crypto from "crypto";
import { Request, Response as ExpressResponse } from "express";
import { extractApiKey } from "../api-key";
import { Config, isDebugLevel } from "../config";
import { AccountManager, UsageData } from "../accounts/manager";
import { openaiToClaude, claudeToOpenai, resolveModel } from "./translator";
import { applyCloaking } from "./cloaking";
import { handleStreamingResponse } from "./streaming";
import { resolveProvider, resolveModelAlias } from "./model-router";
import { ProviderType } from "../auth/provider-interface";
import {
  chatCompletionsToCodexRequest,
  codexResponseToOpenAI,
  codexSSEToOpenAI,
  createCodexStreamState,
} from "./codex-translator";
import {
  openaiToGeminiCLI,
  geminiToOpenAI,
  geminiSSEToOpenAI,
  createGeminiStreamState,
} from "./gemini-translator";
import {
  MAX_RETRIES,
  RETRYABLE_STATUSES,
  classifyFailure,
  extractUsage,
  sendUpstreamError,
  callUpstream,
} from "./shared";

/**
 * Prepare the request body for the target provider.
 */
function prepareBody(
  provider: ProviderType,
  body: any,
  model: string,
  projectId: string,
): any {
  // Apply resolved model name (aliases, Claude short names) to the body
  // so translators send the correct model to upstream APIs
  const bodyWithModel = { ...body, model };
  switch (provider) {
    case "claude":
      return openaiToClaude(bodyWithModel);
    case "codex":
      return chatCompletionsToCodexRequest(bodyWithModel);
    case "gemini":
      return openaiToGeminiCLI(bodyWithModel, projectId);
  }
}

export function createChatCompletionsHandler(
  config: Config,
  manager: AccountManager,
) {
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

      const stream = !!body.stream;
      const rawModel = body.model || "claude-sonnet-4-6";
      const provider = resolveProvider(rawModel);
      const aliasedModel = resolveModelAlias(rawModel);
      const model = provider === "claude" ? resolveModel(aliasedModel) : aliasedModel;
      const apiKey = extractApiKey(req.headers);
      const apiKeyHash = crypto
        .createHash("sha256")
        .update(apiKey)
        .digest("hex");

      // Debug
      if (isDebugLevel(config.debug, "verbose")) {
        console.log(`[DEBUG] Provider: ${provider}, Model: ${model}`);
      }

      // Pre-compute body for providers that don't need per-account data
      // Gemini needs per-account projectId, so it's prepared inside the loop
      const precomputedBody =
        provider !== "gemini"
          ? prepareBody(provider, body, model, "")
          : null;

      // Retry with account switching
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

        manager.recordAttempt(account.token.email, provider);

        // Gemini needs per-account projectId; others use precomputed body
        const preparedBody =
          precomputedBody || prepareBody(provider, body, model, account.projectId);

        // For Claude, apply cloaking
        let finalBody: any;
        if (provider === "claude") {
          finalBody = applyCloaking(
            structuredClone(preparedBody),
            account.deviceId,
            account.accountUuid,
            apiKeyHash,
            config.cloaking,
          );
        } else {
          finalBody = preparedBody;
        }

        if (isDebugLevel(config.debug, "verbose")) {
          console.log("[DEBUG] Final body:");
          console.log(JSON.stringify(finalBody, null, 2));
        }

        let upstreamResp: globalThis.Response;
        try {
          upstreamResp = await callUpstream(
            provider,
            account.token.accessToken,
            finalBody,
            stream,
            config,
            apiKeyHash,
            account.accountUuid,
          );
        } catch (err: any) {
          manager.recordFailure(account.token.email, "network", err.message, provider);
          if (isDebugLevel(config.debug, "errors")) {
            console.error(
              `Attempt ${attempt + 1} network failure (${provider}): ${err.message}`,
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
            await handleProviderStream(
              provider, upstreamResp, res, model, account, manager,
            );
          } else {
            const respData = await upstreamResp.json();
            manager.recordSuccess(account.token.email, provider);
            manager.recordUsage(account.token.email, extractProviderUsage(provider, respData), provider);
            res.json(translateResponse(provider, respData, model));
          }
          return;
        }

        lastStatus = upstreamResp.status;
        try {
          lastErrBody = await upstreamResp.text();
          if (isDebugLevel(config.debug, "errors")) {
            console.error(
              `Attempt ${attempt + 1} failed (${provider}, ${lastStatus}): ${lastErrBody}`,
            );
          }
        } catch {
          /* ignore */
        }

        if (lastStatus === 401) {
          const refreshed = await manager.refreshAccount(account.token.email, provider);
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
            provider,
          );
        }

        if (!RETRYABLE_STATUSES.has(lastStatus)) break;
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
        }
      }

      sendUpstreamError(res, lastStatus, lastErrBody);
    } catch (err: any) {
      console.error("Handler error:", err.message);
      res.status(500).json({ error: { message: "Internal server error" } });
    }
  };
}

/**
 * Translate a non-streaming response to OpenAI chat completions format.
 */
function translateResponse(provider: ProviderType, respData: any, model: string): any {
  switch (provider) {
    case "claude":
      return claudeToOpenai(respData, model);
    case "codex":
      return codexResponseToOpenAI(respData, model);
    case "gemini":
      return geminiToOpenAI(respData, model);
  }
}

/**
 * Extract usage data from a provider-specific response.
 */
function extractProviderUsage(provider: ProviderType, respData: any): UsageData {
  if (provider === "gemini") {
    const data = respData.response || respData;
    const u = data.usageMetadata;
    return {
      inputTokens: u?.promptTokenCount || 0,
      outputTokens: u?.candidatesTokenCount || 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: u?.cachedContentTokenCount || 0,
    };
  }
  return extractUsage(respData);
}

/**
 * Handle streaming response for each provider, translating SSE to OpenAI format.
 */
async function handleProviderStream(
  provider: ProviderType,
  upstreamResp: globalThis.Response,
  res: ExpressResponse,
  model: string,
  account: { token: { email: string }; accountUuid: string },
  manager: AccountManager,
): Promise<void> {
  if (provider === "claude") {
    const streamResult = await handleStreamingResponse(upstreamResp, res, model);
    if (streamResult.completed) {
      manager.recordSuccess(account.token.email, provider);
      manager.recordUsage(account.token.email, streamResult.usage, provider);
    } else if (!streamResult.clientDisconnected) {
      manager.recordFailure(
        account.token.email, "network",
        "stream terminated before completion", provider,
      );
    }
    return;
  }

  // Codex / Gemini SSE → OpenAI SSE translation
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const reader = upstreamResp.body?.getReader();
  if (!reader) { res.end(); return; }

  let clientDisconnected = false;
  let sseBuffer = "";
  let doneSent = false;
  const decoder = new TextDecoder();

  const codexState = provider === "codex" ? createCodexStreamState(model) : null;
  const geminiState = provider === "gemini" ? createGeminiStreamState(model) : null;

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
        if (!raw || raw === "[DONE]") {
          if (raw === "[DONE]" && !doneSent) {
            // For Gemini, send final completion chunk
            if (geminiState) {
              const usage = {
                prompt_tokens: geminiState.inputTokens,
                completion_tokens: geminiState.outputTokens,
                total_tokens: geminiState.inputTokens + geminiState.outputTokens,
              };
              const finalChunk = JSON.stringify({
                id: geminiState.chatId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage,
              });
              res.write(`data: ${finalChunk}\n\n`);
            }
            doneSent = true;
            res.write("data: [DONE]\n\n");
          }
          continue;
        }

        try {
          const data = JSON.parse(raw);
          let chunks: string[] = [];

          if (provider === "codex" && codexState) {
            chunks = codexSSEToOpenAI(data, codexState);
          } else if (provider === "gemini" && geminiState) {
            chunks = geminiSSEToOpenAI(data, geminiState);
          }

          for (const chunk of chunks) {
            if (clientDisconnected) break;
            if (chunk === "[DONE]") {
              doneSent = true;
              res.write("data: [DONE]\n\n");
            } else {
              res.write(`data: ${chunk}\n\n`);
            }
          }
        } catch { /* ignore parse errors */ }
      }
    }

    if (!clientDisconnected) {
      if (!doneSent) res.write("data: [DONE]\n\n");
      manager.recordSuccess(account.token.email, provider);
      // Record usage from stream state
      const usage: UsageData = codexState
        ? { inputTokens: codexState.inputTokens, outputTokens: codexState.outputTokens, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
        : geminiState
          ? { inputTokens: geminiState.inputTokens, outputTokens: geminiState.outputTokens, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
          : { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
      manager.recordUsage(account.token.email, usage, provider);
    }
  } catch {
    if (!clientDisconnected) {
      manager.recordFailure(
        account.token.email, "network",
        "stream terminated before completion", provider,
      );
    }
  } finally {
    if (!clientDisconnected) res.end();
  }
}
