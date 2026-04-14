import crypto from "crypto";
import express from "express";
import { Config, isDebugLevel } from "./config";
import { AccountManager } from "./accounts/manager";
import { extractApiKey } from "./api-key";
import { createChatCompletionsHandler } from "./proxy/handler";
import {
  createMessagesHandler,
  createCountTokensHandler,
} from "./proxy/passthrough";
import { createResponsesHandler } from "./proxy/responses";
import { ProviderType } from "./auth/provider-interface";

/** Models per provider for the /v1/models endpoint */
const PROVIDER_MODELS: Record<ProviderType, { id: string; owned_by: string }[]> = {
  claude: [
    { id: "claude-opus-4-6", owned_by: "anthropic" },
    { id: "claude-sonnet-4-6", owned_by: "anthropic" },
    { id: "claude-haiku-4-5-20251001", owned_by: "anthropic" },
    { id: "claude-haiku-4-5", owned_by: "anthropic" },
    { id: "opus", owned_by: "anthropic" },
    { id: "sonnet", owned_by: "anthropic" },
    { id: "haiku", owned_by: "anthropic" },
  ],
  codex: [
    { id: "gpt-4o", owned_by: "openai" },
    { id: "gpt-4o-mini", owned_by: "openai" },
    { id: "gpt-4.1", owned_by: "openai" },
    { id: "gpt-4.1-mini", owned_by: "openai" },
    { id: "gpt-4.1-nano", owned_by: "openai" },
    { id: "o3", owned_by: "openai" },
    { id: "o3-mini", owned_by: "openai" },
    { id: "o4-mini", owned_by: "openai" },
  ],
  gemini: [
    { id: "gemini-2.5-pro", owned_by: "google" },
    { id: "gemini-2.5-flash", owned_by: "google" },
    { id: "gemini-2.0-flash", owned_by: "google" },
  ],
};

// Timing-safe API key comparison
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare dummy against itself to consume constant time
    const dummy = Buffer.alloc(bufB.length);
    crypto.timingSafeEqual(dummy, dummy);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Simple in-memory rate limiter per IP
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// Cleanup stale entries every 5 minutes
const cleanupTimer = setInterval(
  () => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
      if (now > entry.resetAt) rateLimitMap.delete(ip);
    }
  },
  5 * 60 * 1000,
);
cleanupTimer.unref();

export function createServer(
  config: Config,
  manager: AccountManager,
): express.Application {
  const app = express();

  app.use(express.json({ limit: config["body-limit"] }));

  if (isDebugLevel(config.debug, "verbose")) {
    app.use((req, res, next) => {
      const startedAt = Date.now();
      console.error(`[debug] ${req.method} ${req.originalUrl} started`);
      res.on("finish", () => {
        console.error(
          `[debug] ${req.method} ${req.originalUrl} -> ${res.statusCode} in ${Date.now() - startedAt}ms`,
        );
      });
      next();
    });
  }

  // CORS - restrict to localhost origins only
  const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  app.use((_req, res, next) => {
    const origin = _req.headers.origin;
    if (origin && LOCALHOST_RE.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, x-api-key",
    );
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Rate limiting middleware
  app.use("/v1", (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (!rateLimit(ip)) {
      res.status(429).json({ error: { message: "Too many requests" } });
      return;
    }
    next();
  });

  // Key auth middleware factory — accepts both OpenAI style (Authorization:
  // Bearer) and Anthropic style (x-api-key) so Claude Code and OpenAI clients
  // both work.
  const makeKeyAuth = (
    keys: string[],
    label: string,
  ): express.RequestHandler => {
    return (req, res, next) => {
      const key = extractApiKey(req.headers);
      if (!key) {
        res.status(401).json({ error: { message: `Missing ${label}` } });
        return;
      }
      const valid = keys.some((k) => safeCompare(key, k));
      if (!valid) {
        res.status(403).json({ error: { message: `Invalid ${label}` } });
        return;
      }
      next();
    };
  };

  app.use("/v1", makeKeyAuth(config["api-keys"], "API key"));

  // Admin routes are registered only when admin-keys is configured. This
  // keeps /admin/* completely invisible (natural Express 404) when disabled,
  // so usage keys cannot reach the account pool management surface.
  const adminEnabled = config["admin-keys"].length > 0;
  if (adminEnabled) {
    app.use("/admin", makeKeyAuth(config["admin-keys"], "admin key"));
  }

  // Routes — OpenAI compatible (supports all providers via model routing)
  app.post(
    "/v1/chat/completions",
    createChatCompletionsHandler(config, manager),
  );
  app.post("/v1/responses", createResponsesHandler(config, manager));

  // Routes — Claude native passthrough (Claude only)
  app.post(
    "/v1/messages/count_tokens",
    createCountTokensHandler(config, manager),
  );
  app.post("/v1/messages", createMessagesHandler(config, manager));

  // Models endpoint — returns models for all active providers
  app.get("/v1/models", (_req, res) => {
    const activeProviders = manager.getActiveProviders();
    const now = Math.floor(Date.now() / 1000);
    const models: any[] = [];
    for (const provider of activeProviders) {
      const providerModels = PROVIDER_MODELS[provider] || [];
      for (const m of providerModels) {
        models.push({
          id: m.id,
          object: "model",
          created: now,
          owned_by: m.owned_by,
        });
      }
    }
    res.json({ object: "list", data: models });
  });

  // Health check (no account count to avoid info leak)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  if (adminEnabled) {
    app.get("/admin/accounts", (_req, res) => {
      res.json({
        accounts: manager.getSnapshots(),
        account_count: manager.accountCount,
        generated_at: new Date().toISOString(),
      });
    });

    app.post("/admin/accounts/:email/enable", (req, res) => {
      const email = req.params.email;
      const provider = req.query.provider as ProviderType | undefined;
      if (manager.enableAccount(email, provider)) {
        const label = provider ? `${email} (${provider})` : email;
        res.json({ message: `Account ${label} re-enabled` });
      } else {
        res
          .status(404)
          .json({ error: { message: `Account ${email} not found` } });
      }
    });
  }

  return app;
}
