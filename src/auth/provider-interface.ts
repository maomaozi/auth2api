import { TokenData } from "./types";

/**
 * Supported provider types.
 */
export type ProviderType = "claude" | "codex" | "gemini";

/**
 * Unified authentication provider interface.
 * Each provider (Claude, Codex, Gemini) implements this to handle
 * its own OAuth flow and token refresh logic.
 */
export interface AuthProvider {
  /** Provider identifier */
  readonly type: ProviderType;

  /** Default callback port for OAuth */
  readonly callbackPort: number;

  /** How far in advance of expiry to trigger refresh (ms) */
  readonly refreshLeadMs: number;

  /** Generate the OAuth authorization URL */
  generateAuthURL(state: string, pkce: { codeVerifier: string; codeChallenge: string }): string;

  /** Exchange the authorization code for tokens */
  exchangeCodeForTokens(
    code: string,
    returnedState: string,
    expectedState: string,
    pkce: { codeVerifier: string; codeChallenge: string },
  ): Promise<TokenData>;

  /** Refresh an existing token */
  refreshTokens(refreshToken: string): Promise<TokenData>;
}

/**
 * Retry wrapper for any provider's refreshTokens method.
 */
export async function refreshTokensWithRetry(
  provider: AuthProvider,
  refreshToken: string,
  maxRetries = 3,
): Promise<TokenData> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await provider.refreshTokens(refreshToken);
    } catch (err: any) {
      if (err.nonRetryable || attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
  throw new Error("Unreachable");
}
