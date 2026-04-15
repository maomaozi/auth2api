import { TokenData } from "../auth/types";
import { ProviderType, refreshTokensWithRetry } from "../auth/provider-interface";
import { getAuthProvider } from "../auth/providers";
import { saveToken, loadAllTokens } from "../auth/token-storage";
import { getDeviceId } from "../proxy/cloak-utils";

const REFRESH_CHECK_INTERVAL_MS = 60 * 1000; // check every 60s

// Disable an account after this many consecutive failures
const DISABLE_THRESHOLD = 10;

export type AccountFailureKind =
  | "rate_limit"
  | "auth"
  | "forbidden"
  | "server"
  | "network";

const FAILURE_BACKOFF: Record<
  AccountFailureKind,
  { baseMs: number; maxMs: number }
> = {
  rate_limit: { baseMs: 60 * 1000, maxMs: 15 * 60 * 1000 },
  auth: { baseMs: 10 * 60 * 1000, maxMs: 60 * 60 * 1000 },
  forbidden: { baseMs: 10 * 60 * 1000, maxMs: 60 * 60 * 1000 },
  server: { baseMs: 5 * 1000, maxMs: 5 * 60 * 1000 },
  network: { baseMs: 5 * 1000, maxMs: 5 * 60 * 1000 },
};

export interface UsageData {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface TrackingContext {
  apiKeyHash: string;
  keyPrefix: string;
  model?: string;
}

interface ModelUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

function createModelUsage(): ModelUsage {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
}

interface ApiKeyUsage {
  keyPrefix: string;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  lastUsedAt: string | null;
  perModel: Map<string, ModelUsage>;
}

interface ModelUsageSnapshot {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface ApiKeyUsageSnapshot {
  key_hash: string;
  key_prefix: string;
  total_requests: number;
  total_successes: number;
  total_failures: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_input_tokens: number;
  total_cache_read_input_tokens: number;
  last_used_at: string | null;
  per_model: Record<string, ModelUsageSnapshot>;
}

interface AccountState {
  token: TokenData;
  cooldownUntil: number;
  failureCount: number;
  disabled: boolean;
  lastError: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastRefreshAt: string | null;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  refreshing: boolean;
  refreshPromise: Promise<boolean> | null;
}

export interface AccountSnapshot {
  email: string;
  provider: ProviderType;
  available: boolean;
  disabled: boolean;
  cooldownUntil: number;
  failureCount: number;
  lastError: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastRefreshAt: string | null;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  expiresAt: string;
  refreshing: boolean;
}

export interface AccountResult {
  account: {
    token: TokenData;
    deviceId: string;
    accountUuid: string;
    projectId: string;
  } | null;
  total: number;
}

const STICKY_MIN_MS = 20 * 60 * 1000; // 20 minutes
const STICKY_MAX_MS = 60 * 60 * 1000; // 60 minutes

function randomStickyDuration(): number {
  return STICKY_MIN_MS + Math.random() * (STICKY_MAX_MS - STICKY_MIN_MS);
}

/**
 * Unique key for an account. Uses provider + email since the same email
 * could have accounts on multiple providers.
 */
function accountKey(provider: ProviderType, email: string): string {
  return `${provider}:${email}`;
}

/**
 * Per-provider round-robin state.
 */
interface ProviderPoolState {
  accountOrder: string[]; // account keys in insertion order
  lastUsedIndex: number;
  stickyUntil: number;
}

export class AccountManager {
  private accounts: Map<string, AccountState> = new Map();
  private providerPools: Map<ProviderType, ProviderPoolState> = new Map();
  private apiKeyUsage: Map<string, ApiKeyUsage> = new Map();
  private authDir: string;
  private refreshTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private refreshing = false;

  constructor(authDir: string) {
    this.authDir = authDir;
  }

  private getOrCreatePool(provider: ProviderType): ProviderPoolState {
    let pool = this.providerPools.get(provider);
    if (!pool) {
      pool = { accountOrder: [], lastUsedIndex: -1, stickyUntil: 0 };
      this.providerPools.set(provider, pool);
    }
    return pool;
  }

  load(): void {
    const tokens = loadAllTokens(this.authDir);
    for (const token of tokens) {
      const key = accountKey(token.provider, token.email);
      this.accounts.set(key, this.createAccountState(token));
      const pool = this.getOrCreatePool(token.provider);
      if (!pool.accountOrder.includes(key)) {
        pool.accountOrder.push(key);
      }
    }
    // Log counts per provider
    for (const [provider, pool] of this.providerPools) {
      console.log(`Loaded ${pool.accountOrder.length} ${provider} account(s)`);
    }
    console.log(`Total: ${this.accounts.size} account(s)`);
  }

  addAccount(token: TokenData): void {
    const key = accountKey(token.provider, token.email);
    const existing = this.accounts.get(key);
    if (existing) {
      existing.token = token;
      existing.cooldownUntil = 0;
      existing.failureCount = 0;
      existing.disabled = false;
      existing.lastError = null;
      existing.lastFailureAt = null;
      existing.lastSuccessAt = new Date().toISOString();
      existing.lastRefreshAt = new Date().toISOString();
    } else {
      const state = this.createAccountState(token);
      state.lastSuccessAt = new Date().toISOString();
      state.lastRefreshAt = new Date().toISOString();
      this.accounts.set(key, state);
      const pool = this.getOrCreatePool(token.provider);
      pool.accountOrder.push(key);
    }

    saveToken(this.authDir, token);
  }

  enableAccount(email: string, provider?: ProviderType): boolean {
    // If provider is specified, enable only that provider's account
    if (provider) {
      const key = accountKey(provider, email);
      const acct = this.accounts.get(key);
      if (!acct) return false;
      acct.disabled = false;
      acct.cooldownUntil = 0;
      acct.failureCount = 0;
      acct.lastError = null;
      acct.lastFailureAt = null;
      console.log(`Account ${email} (${provider}) has been re-enabled`);
      return true;
    }
    // Otherwise try all providers for this email and enable all matches
    let found = false;
    for (const p of this.providerPools.keys()) {
      const key = accountKey(p, email);
      const acct = this.accounts.get(key);
      if (acct) {
        acct.disabled = false;
        acct.cooldownUntil = 0;
        acct.failureCount = 0;
        acct.lastError = null;
        acct.lastFailureAt = null;
        console.log(`Account ${email} (${p}) has been re-enabled`);
        found = true;
      }
    }
    return found;
  }

  /**
   * Sticky account selection per provider. Keeps using the same account for
   * STICKY_DURATION_MS before rotating to the next one. Rotates early only
   * when the current account enters cooldown.
   *
   * @param provider - Which provider's account pool to select from.
   *                   If not specified, falls back to "claude" for backward compatibility.
   */
  getNextAccount(provider: ProviderType = "claude"): AccountResult {
    const pool = this.providerPools.get(provider);
    if (!pool) return { account: null, total: 0 };

    const count = pool.accountOrder.length;
    if (count === 0) return { account: null, total: 0 };

    const now = Date.now();

    // Try to keep using the current sticky account
    if (pool.lastUsedIndex >= 0 && now < pool.stickyUntil) {
      const key = pool.accountOrder[pool.lastUsedIndex];
      const acct = this.accounts.get(key)!;
      if (acct.cooldownUntil <= now && !acct.disabled) {
        return {
          account: {
            token: acct.token,
            deviceId: getDeviceId(this.authDir, acct.token.email),
            accountUuid: acct.token.accountUuid,
            projectId: acct.token.projectId || "",
          },
          total: count,
        };
      }
    }

    // Pick the next available account
    const startIdx = pool.lastUsedIndex >= 0 ? pool.lastUsedIndex + 1 : 0;
    for (let i = 0; i < count; i++) {
      const idx = (startIdx + i) % count;
      const key = pool.accountOrder[idx];
      const acct = this.accounts.get(key)!;
      if (acct.cooldownUntil <= now && !acct.disabled) {
        pool.lastUsedIndex = idx;
        pool.stickyUntil = now + randomStickyDuration();
        return {
          account: {
            token: acct.token,
            deviceId: getDeviceId(this.authDir, acct.token.email),
            accountUuid: acct.token.accountUuid,
            projectId: acct.token.projectId || "",
          },
          total: count,
        };
      }
    }
    return { account: null, total: count };
  }

  private getOrCreateKeyUsage(ctx: TrackingContext): ApiKeyUsage {
    let usage = this.apiKeyUsage.get(ctx.apiKeyHash);
    if (!usage) {
      usage = {
        keyPrefix: ctx.keyPrefix,
        totalRequests: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreationInputTokens: 0,
        totalCacheReadInputTokens: 0,
        lastUsedAt: null,
        perModel: new Map(),
      };
      this.apiKeyUsage.set(ctx.apiKeyHash, usage);
    }
    return usage;
  }

  private getOrCreateModelUsage(ku: ApiKeyUsage, model: string): ModelUsage {
    let mu = ku.perModel.get(model);
    if (!mu) {
      mu = createModelUsage();
      ku.perModel.set(model, mu);
    }
    return mu;
  }

  recordAttempt(email: string, provider: ProviderType = "claude", tracking?: TrackingContext): void {
    const acct = this.accounts.get(accountKey(provider, email));
    if (acct) {
      acct.totalRequests++;
    }
    if (tracking) {
      const ku = this.getOrCreateKeyUsage(tracking);
      ku.totalRequests++;
      ku.lastUsedAt = new Date().toISOString();
      if (tracking.model) {
        this.getOrCreateModelUsage(ku, tracking.model).requests++;
      }
    }
  }

  recordSuccess(email: string, provider: ProviderType = "claude", tracking?: TrackingContext): void {
    const acct = this.accounts.get(accountKey(provider, email));
    if (!acct) return;

    acct.cooldownUntil = 0;
    acct.failureCount = 0;
    acct.disabled = false;
    acct.lastError = null;
    acct.lastFailureAt = null;
    acct.lastSuccessAt = new Date().toISOString();
    acct.totalSuccesses++;

    if (tracking) {
      const ku = this.apiKeyUsage.get(tracking.apiKeyHash);
      if (ku) ku.totalSuccesses++;
    }
  }

  recordUsage(email: string, usage: UsageData, provider: ProviderType = "claude", tracking?: TrackingContext): void {
    const acct = this.accounts.get(accountKey(provider, email));
    if (!acct) return;
    acct.totalInputTokens += usage.inputTokens;
    acct.totalOutputTokens += usage.outputTokens;
    acct.totalCacheCreationInputTokens += usage.cacheCreationInputTokens;
    acct.totalCacheReadInputTokens += usage.cacheReadInputTokens;

    if (tracking) {
      const ku = this.apiKeyUsage.get(tracking.apiKeyHash);
      if (ku) {
        ku.totalInputTokens += usage.inputTokens;
        ku.totalOutputTokens += usage.outputTokens;
        ku.totalCacheCreationInputTokens += usage.cacheCreationInputTokens;
        ku.totalCacheReadInputTokens += usage.cacheReadInputTokens;
        if (tracking.model) {
          const mu = this.getOrCreateModelUsage(ku, tracking.model);
          mu.inputTokens += usage.inputTokens;
          mu.outputTokens += usage.outputTokens;
          mu.cacheCreationInputTokens += usage.cacheCreationInputTokens;
          mu.cacheReadInputTokens += usage.cacheReadInputTokens;
        }
      }
    }
  }

  recordFailure(
    email: string,
    kind: AccountFailureKind,
    detail?: string,
    provider: ProviderType = "claude",
    tracking?: TrackingContext,
    cooldownOverrideMs?: number,
  ): void {
    const acct = this.accounts.get(accountKey(provider, email));
    if (!acct) return;

    acct.failureCount++;
    acct.totalFailures++;
    acct.lastFailureAt = new Date().toISOString();
    acct.lastError = detail ? `${kind}: ${detail}` : kind;

    if (tracking) {
      const ku = this.apiKeyUsage.get(tracking.apiKeyHash);
      if (ku) ku.totalFailures++;
    }

    // Already disabled: skip cooldown math and log spam.
    if (acct.disabled) return;

    let cooldownMs: number;
    if (cooldownOverrideMs !== undefined) {
      cooldownMs = cooldownOverrideMs;
    } else {
      const { baseMs, maxMs } = FAILURE_BACKOFF[kind];
      cooldownMs = Math.min(
        baseMs * 2 ** Math.max(0, acct.failureCount - 1),
        maxMs,
      );
    }
    acct.cooldownUntil = Date.now() + cooldownMs;
    console.log(
      `Account ${email} (${provider}) cooled down for ${Math.round(cooldownMs / 1000)}s (${kind})`,
    );

    // Auto-disable after too many consecutive failures
    if (acct.failureCount >= DISABLE_THRESHOLD) {
      acct.disabled = true;
      console.warn(
        `[WARNING] Account ${email} (${provider}) has been DISABLED after ${acct.failureCount} ` +
          `consecutive failures. Last error: ${acct.lastError}. ` +
          `Use POST /admin/accounts/${encodeURIComponent(email)}/enable to re-enable.`,
      );
    }
  }

  async refreshAccount(email: string, provider: ProviderType = "claude"): Promise<boolean> {
    const key = accountKey(provider, email);
    const acct = this.accounts.get(key);
    if (!acct) return false;
    if (acct.refreshPromise) {
      return acct.refreshPromise;
    }

    acct.refreshPromise = this.performRefresh(acct);
    return acct.refreshPromise;
  }

  getApiKeySnapshots(): ApiKeyUsageSnapshot[] {
    const snapshots: ApiKeyUsageSnapshot[] = [];
    for (const [hash, ku] of this.apiKeyUsage) {
      const perModel: ApiKeyUsageSnapshot["per_model"] = {};
      for (const [model, mu] of ku.perModel) {
        perModel[model] = {
          requests: mu.requests,
          input_tokens: mu.inputTokens,
          output_tokens: mu.outputTokens,
          cache_creation_input_tokens: mu.cacheCreationInputTokens,
          cache_read_input_tokens: mu.cacheReadInputTokens,
        };
      }
      snapshots.push({
        key_hash: hash,
        key_prefix: ku.keyPrefix,
        total_requests: ku.totalRequests,
        total_successes: ku.totalSuccesses,
        total_failures: ku.totalFailures,
        total_input_tokens: ku.totalInputTokens,
        total_output_tokens: ku.totalOutputTokens,
        total_cache_creation_input_tokens: ku.totalCacheCreationInputTokens,
        total_cache_read_input_tokens: ku.totalCacheReadInputTokens,
        last_used_at: ku.lastUsedAt,
        per_model: perModel,
      });
    }
    return snapshots;
  }

  getSnapshots(): AccountSnapshot[] {
    const now = Date.now();
    const snapshots: AccountSnapshot[] = [];
    for (const acct of this.accounts.values()) {
      snapshots.push({
        email: acct.token.email,
        provider: acct.token.provider,
        available: acct.cooldownUntil <= now && !acct.disabled,
        disabled: acct.disabled,
        cooldownUntil: acct.cooldownUntil,
        failureCount: acct.failureCount,
        lastError: acct.lastError,
        lastFailureAt: acct.lastFailureAt,
        lastSuccessAt: acct.lastSuccessAt,
        lastRefreshAt: acct.lastRefreshAt,
        totalRequests: acct.totalRequests,
        totalSuccesses: acct.totalSuccesses,
        totalFailures: acct.totalFailures,
        totalInputTokens: acct.totalInputTokens,
        totalOutputTokens: acct.totalOutputTokens,
        totalCacheCreationInputTokens: acct.totalCacheCreationInputTokens,
        totalCacheReadInputTokens: acct.totalCacheReadInputTokens,
        expiresAt: acct.token.expiresAt,
        refreshing: acct.refreshing,
      });
    }
    return snapshots;
  }

  startAutoRefresh(): void {
    const timer = setInterval(
      () =>
        this.refreshAll().catch((err) =>
          console.error("Refresh cycle failed:", err.message),
        ),
      REFRESH_CHECK_INTERVAL_MS,
    );
    timer.unref();
    this.refreshTimer = timer;
    this.refreshAll().catch((err) =>
      console.error("Initial refresh failed:", err.message),
    );
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  startStatsLogger(): void {
    const timer = setInterval(() => this.logStats(), 5 * 60 * 1000);
    timer.unref();
    this.statsTimer = timer;
  }

  stopStatsLogger(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  private logStats(): void {
    if (this.accounts.size === 0) return;
    console.log(`\n===== Account Stats (${new Date().toISOString()}) =====`);
    const now = Date.now();
    for (const acct of this.accounts.values()) {
      const available = acct.cooldownUntil <= now && !acct.disabled;
      console.log(
        `  [${acct.token.provider}] ${acct.token.email}: ` +
          `available=${available}, ` +
          `disabled=${acct.disabled}, ` +
          `requests=${acct.totalRequests}, ` +
          `successes=${acct.totalSuccesses}, ` +
          `failures=${acct.totalFailures}, ` +
          `input_tokens=${acct.totalInputTokens}, ` +
          `output_tokens=${acct.totalOutputTokens}, ` +
          `cache_creation=${acct.totalCacheCreationInputTokens}, ` +
          `cache_read=${acct.totalCacheReadInputTokens}, ` +
          `total_tokens=${acct.totalInputTokens + acct.totalOutputTokens + acct.totalCacheCreationInputTokens + acct.totalCacheReadInputTokens}`,
      );
    }
    if (this.apiKeyUsage.size > 0) {
      console.log(`  --- Per API Key ---`);
      for (const [hash, ku] of this.apiKeyUsage) {
        console.log(
          `  [${ku.keyPrefix}] (${hash.slice(0, 12)}...): ` +
            `requests=${ku.totalRequests}, ` +
            `successes=${ku.totalSuccesses}, ` +
            `failures=${ku.totalFailures}, ` +
            `input_tokens=${ku.totalInputTokens}, ` +
            `output_tokens=${ku.totalOutputTokens}, ` +
            `total_tokens=${ku.totalInputTokens + ku.totalOutputTokens + ku.totalCacheCreationInputTokens + ku.totalCacheReadInputTokens}`,
        );
      }
    }
    console.log(`====================================================\n`);
  }

  get accountCount(): number {
    return this.accounts.size;
  }

  /**
   * Get number of accounts for a specific provider.
   */
  getProviderAccountCount(provider: ProviderType): number {
    return this.providerPools.get(provider)?.accountOrder.length ?? 0;
  }

  /**
   * Get list of providers that have at least one account loaded.
   */
  getActiveProviders(): ProviderType[] {
    const providers: ProviderType[] = [];
    for (const [provider, pool] of this.providerPools) {
      if (pool.accountOrder.length > 0) {
        providers.push(provider);
      }
    }
    return providers;
  }

  private async refreshAll(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const now = Date.now();
      for (const acct of this.accounts.values()) {
        const provider = getAuthProvider(acct.token.provider);
        const expiresAt = new Date(acct.token.expiresAt).getTime();
        if (expiresAt - now <= provider.refreshLeadMs) {
          await this.refreshAccount(acct.token.email, acct.token.provider);
        }
      }
    } finally {
      this.refreshing = false;
    }
  }

  private async performRefresh(acct: AccountState): Promise<boolean> {
    if (acct.refreshing) return false;

    acct.refreshing = true;
    try {
      const provider = getAuthProvider(acct.token.provider);
      console.log(`Refreshing token for ${acct.token.email} (${acct.token.provider})...`);
      const newToken = await refreshTokensWithRetry(provider, acct.token.refreshToken);
      newToken.email = newToken.email || acct.token.email;
      newToken.provider = acct.token.provider;
      // Preserve fields that the refresh response may not include
      newToken.accountUuid = newToken.accountUuid || acct.token.accountUuid;
      newToken.projectId = newToken.projectId || acct.token.projectId;
      acct.token = newToken;
      acct.cooldownUntil = 0;
      acct.failureCount = 0;
      acct.lastError = null;
      acct.lastFailureAt = null;
      acct.lastSuccessAt = new Date().toISOString();
      acct.lastRefreshAt = new Date().toISOString();
      saveToken(this.authDir, newToken);
      console.log(`Token refreshed for ${acct.token.email} (${acct.token.provider}), expires ${newToken.expiresAt}`);
      return true;
    } catch (err: any) {
      this.recordFailure(acct.token.email, "auth", err.message, acct.token.provider);
      console.error(
        `Token refresh failed for ${acct.token.email} (${acct.token.provider}): ${err.message}`,
      );
      return false;
    } finally {
      acct.refreshing = false;
      acct.refreshPromise = null;
    }
  }

  private createAccountState(token: TokenData): AccountState {
    return {
      token,
      cooldownUntil: 0,
      failureCount: 0,
      disabled: false,
      lastError: null,
      lastFailureAt: null,
      lastSuccessAt: null,
      lastRefreshAt: null,
      totalRequests: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationInputTokens: 0,
      totalCacheReadInputTokens: 0,
      refreshing: false,
      refreshPromise: null,
    };
  }
}
