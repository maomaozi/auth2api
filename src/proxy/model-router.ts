import { ProviderType } from "../auth/provider-interface";
import { ModelAliasEntry } from "../config";

/**
 * Default model-to-provider routing rules.
 * Models are matched by prefix; first match wins.
 */
const DEFAULT_ROUTES: { prefix: string; provider: ProviderType }[] = [
  // Claude models
  { prefix: "claude-", provider: "claude" },
  { prefix: "opus", provider: "claude" },
  { prefix: "sonnet", provider: "claude" },
  { prefix: "haiku", provider: "claude" },
  // Codex / OpenAI models
  { prefix: "gpt-", provider: "codex" },
  { prefix: "o1", provider: "codex" },
  { prefix: "o3", provider: "codex" },
  { prefix: "o4", provider: "codex" },
  { prefix: "codex-", provider: "codex" },
  { prefix: "chatgpt-", provider: "codex" },
  // Gemini models
  { prefix: "gemini-", provider: "gemini" },
];

/**
 * Model alias map: input model name → { provider, model }.
 * Loaded from config at startup.
 */
const aliases = new Map<string, { provider: ProviderType; model: string }>();

/**
 * Load model aliases from config.
 * Supports two formats:
 *   "alias": "target-model"         (provider inferred from target model name)
 *   "alias": { provider: "codex", model: "gpt-4o" }
 */
export function loadModelAliases(
  aliasConfig: Record<string, string | ModelAliasEntry> | undefined,
): void {
  aliases.clear();
  if (!aliasConfig) return;
  for (const [alias, value] of Object.entries(aliasConfig)) {
    if (typeof value === "string") {
      // Simple string: "my-model" → "gpt-4o" (infer provider from target)
      const provider = resolveProviderByPrefix(value);
      aliases.set(alias, { provider, model: value });
    } else if (value && typeof value === "object") {
      // Object: { provider: "codex", model: "gpt-4o" }
      aliases.set(alias, {
        provider: value.provider as ProviderType,
        model: value.model,
      });
    }
  }
  if (aliases.size > 0) {
    console.log(`Loaded ${aliases.size} model alias(es)`);
  }
}

/**
 * Resolve which provider should handle a given model name.
 * Priority: aliases > default prefix matching > fallback to claude.
 */
export function resolveProvider(model: string): ProviderType {
  const alias = aliases.get(model);
  if (alias) return alias.provider;
  return resolveProviderByPrefix(model);
}

/**
 * Resolve the actual model name (applying aliases if any).
 */
export function resolveModelAlias(model: string): string {
  const alias = aliases.get(model);
  return alias ? alias.model : model;
}

function resolveProviderByPrefix(model: string): ProviderType {
  const lower = model.toLowerCase();
  for (const route of DEFAULT_ROUTES) {
    if (lower.startsWith(route.prefix)) {
      return route.provider;
    }
  }
  return "claude";
}
