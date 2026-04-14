import crypto from "crypto";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

/**
 * Cloaking configuration for request fingerprinting.
 * Controls how auth2api mimics Claude Code CLI's request signature.
 */
export interface CloakingConfig {
  /** CLI version to impersonate in User-Agent and fingerprint (default: 2.1.88) */
  "cli-version"?: string;
  /** Entrypoint value for billing header (default: cli) */
  entrypoint?: string;
}

export interface TimeoutConfig {
  "messages-ms": number;
  "stream-messages-ms": number;
  "count-tokens-ms": number;
}

export type DebugMode = "off" | "errors" | "verbose";

export interface ModelAliasEntry {
  provider: string;
  model: string;
}

export interface Config {
  host: string;
  port: number;
  "auth-dir": string;
  "api-keys": string[];
  "admin-keys": string[];
  "body-limit": string;
  cloaking: CloakingConfig;
  timeouts: TimeoutConfig;
  debug: DebugMode;
  "model-alias"?: Record<string, string | ModelAliasEntry>;
}

const DEFAULT_CONFIG: Config = {
  host: "",
  port: 8317,
  "auth-dir": "~/.auth2api",
  "api-keys": [],
  "admin-keys": [],
  "body-limit": "200mb",
  cloaking: {
    "cli-version": "2.1.88",
    entrypoint: "cli",
  },
  timeouts: {
    "messages-ms": 120000,
    "stream-messages-ms": 600000,
    "count-tokens-ms": 30000,
  },
  debug: "off",
};

function normalizeDebugMode(value: unknown): DebugMode {
  if (value === true) return "errors";
  if (value === false || value == null) return "off";
  if (value === "off" || value === "errors" || value === "verbose")
    return value;
  return "off";
}

export function isDebugLevel(
  debug: DebugMode,
  level: Exclude<DebugMode, "off">,
): boolean {
  if (debug === "verbose") return true;
  return debug === level;
}

export function resolveAuthDir(dir: string): string {
  if (dir.startsWith("~")) {
    return path.join(process.env.HOME || "/root", dir.slice(1));
  }
  return path.resolve(dir);
}

export function generateApiKey(): string {
  return "sk-" + crypto.randomBytes(32).toString("hex");
}

export function loadConfig(configPath?: string): Config {
  const filePath = configPath || "config.yaml";
  let config: Config;

  if (!fs.existsSync(filePath)) {
    console.log(`Config file not found at ${filePath}, using defaults`);
    config = { ...DEFAULT_CONFIG };
  } else {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = yaml.load(raw) as Partial<Config>;
    config = {
      ...DEFAULT_CONFIG,
      ...parsed,
      // Merge cloaking config with defaults
      cloaking: { ...DEFAULT_CONFIG.cloaking, ...(parsed.cloaking || {}) },
      timeouts: { ...DEFAULT_CONFIG.timeouts, ...(parsed.timeouts || {}) },
    };
  }

  config.debug = normalizeDebugMode(
    (config as Config & { debug?: unknown }).debug,
  );

  // Normalize key lists to arrays so a malformed YAML scalar (e.g.
  // `api-keys: "sk-foo"`) cannot crash middleware later.
  if (!Array.isArray(config["api-keys"])) config["api-keys"] = [];
  if (!Array.isArray(config["admin-keys"])) config["admin-keys"] = [];

  // Auto-generate API key if none configured
  if (config["api-keys"].length === 0) {
    const key = generateApiKey();
    config["api-keys"] = [key];
    // Write config with generated key
    fs.writeFileSync(filePath, yaml.dump(config, { lineWidth: -1 }), {
      mode: 0o600,
    });
    console.log(`\nGenerated API key (saved to ${filePath}):\n\n  ${key}\n`);
  }

  return config;
}
