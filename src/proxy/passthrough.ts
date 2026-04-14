import { Request, Response as ExpressResponse } from "express";
import { extractApiKeyInfo } from "../api-key";
import { Config, isDebugLevel } from "../config";
import { AccountManager, TrackingContext, UsageData } from "../accounts/manager";
import { applyCloaking } from "./cloaking";
import { callClaudeAPI, callClaudeCountTokens } from "./claude-api";
import {
  MAX_RETRIES,
  RETRYABLE_STATUSES,
  classifyFailure,
  extractUsage,
  sendUpstreamError,
} from "./shared";

// POST /v1/messages — Claude native format passthrough (always uses Claude provider)
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
      const model = body.model || "unknown";
      const { apiKey, apiKeyHash, keyPrefix } = extractApiKeyInfo(req.headers);
      const tracking: TrackingContext = { apiKeyHash, keyPrefix, model };

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
