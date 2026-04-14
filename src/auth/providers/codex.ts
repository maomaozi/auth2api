import { AuthProvider } from "../provider-interface";
import { PKCECodes, TokenData } from "../types";

const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const AUTH_SCOPE = "openid email profile offline_access";

const REFRESH_LEAD_MS = 5 * 24 * 60 * 60 * 1000; // 5 days before expiry

/**
 * Parse a JWT token without verifying its signature.
 * Extracts the payload claims (email, sub/account_id).
 */
function parseJWT(token: string): Record<string, any> {
  const parts = token.split(".");
  if (parts.length < 2) return {};
  const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
  return JSON.parse(payload);
}

export class CodexAuthProvider implements AuthProvider {
  readonly type = "codex" as const;
  readonly callbackPort = 1455;
  readonly refreshLeadMs = REFRESH_LEAD_MS;

  generateAuthURL(state: string, pkce: PKCECodes): string {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: "S256",
      state,
      scope: AUTH_SCOPE,
      prompt: "login",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCodeForTokens(
    code: string,
    returnedState: string,
    expectedState: string,
    pkce: PKCECodes,
  ): Promise<TokenData> {
    if (returnedState !== expectedState) {
      throw new Error("OAuth state mismatch — possible CSRF attack");
    }

    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_verifier: pkce.codeVerifier,
      }).toString(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Token exchange failed (${resp.status}): ${text}`);
    }

    const data: any = await resp.json();
    return this.parseTokenResponse(data);
  }

  async refreshTokens(refreshToken: string): Promise<TokenData> {
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: AUTH_SCOPE,
      }).toString(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Token refresh failed (${resp.status}): ${text}`);
    }

    const data: any = await resp.json();
    return this.parseTokenResponse(data);
  }

  private parseTokenResponse(data: any): TokenData {
    const expiresAt = new Date(
      Date.now() + (data.expires_in || 3600) * 1000,
    ).toISOString();

    // Extract email and account ID from the id_token JWT
    let email = "unknown";
    let accountUuid = "";
    if (data.id_token) {
      try {
        const claims = parseJWT(data.id_token);
        email = claims.email || "unknown";
        accountUuid = claims.sub || "";
      } catch {
        // JWT parse failure, use defaults
      }
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      email,
      expiresAt,
      accountUuid,
      provider: "codex",
    };
  }
}
