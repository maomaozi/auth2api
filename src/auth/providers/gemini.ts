import { AuthProvider } from "../provider-interface";
import { PKCECodes, TokenData } from "../types";

const AUTH_URL = "https://accounts.google.com/o/oauth2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLIENT_ID =
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const REDIRECT_URI = "http://localhost:8085/oauth2callback";
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";

const GEMINI_CLI_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const LOAD_CODE_ASSIST_URL = `${GEMINI_CLI_ENDPOINT}/v1internal:loadCodeAssist`;
const ONBOARD_USER_URL = `${GEMINI_CLI_ENDPOINT}/v1internal:onboardUser`;

const REFRESH_LEAD_MS = 30 * 60 * 1000; // 30 minutes before expiry (Google tokens are short-lived, ~1h)

const ONBOARD_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
};

export class GeminiAuthProvider implements AuthProvider {
  readonly type = "gemini" as const;
  readonly callbackPort = 8085;
  readonly refreshLeadMs = REFRESH_LEAD_MS;

  /**
   * Gemini uses standard Google OAuth2 without PKCE.
   * The pkce parameter is ignored but kept for interface compatibility.
   */
  generateAuthURL(state: string, _pkce: PKCECodes): string {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCodeForTokens(
    code: string,
    returnedState: string,
    expectedState: string,
    _pkce: PKCECodes,
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
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
      }).toString(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Token exchange failed (${resp.status}): ${text}`);
    }

    const data: any = await resp.json();
    const expiresAt = new Date(
      Date.now() + (data.expires_in || 3600) * 1000,
    ).toISOString();

    // Fetch user email and project ID in parallel
    const [email, projectId] = await Promise.all([
      this.fetchUserEmail(data.access_token),
      this.fetchProjectId(data.access_token),
    ]);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      email,
      expiresAt,
      accountUuid: "",
      provider: "gemini",
      projectId,
    };
  }

  async refreshTokens(refreshToken: string): Promise<TokenData> {
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Token refresh failed (${resp.status}): ${text}`);
    }

    const data: any = await resp.json();
    const expiresAt = new Date(
      Date.now() + (data.expires_in || 3600) * 1000,
    ).toISOString();

    // Email is already known from initial login and preserved by the manager.
    // Skip the extra fetchUserEmail network call during refresh.
    return {
      accessToken: data.access_token,
      // Google may not return a new refresh_token on refresh; keep the old one
      refreshToken: data.refresh_token || refreshToken,
      email: "unknown", // manager overwrites with the existing email
      expiresAt,
      accountUuid: "",
      provider: "gemini",
    };
  }

  /**
   * Fetch the GCP project ID via loadCodeAssist + onboardUser flow.
   * 1. loadCodeAssist → get tiers and auto-discovered project
   * 2. onboardUser → activate project (with polling for long-running operations)
   */
  private async fetchProjectId(accessToken: string): Promise<string> {
    try {
      // Step 1: loadCodeAssist
      const loadResp = await fetch(LOAD_CODE_ASSIST_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ metadata: ONBOARD_METADATA }),
      });
      if (!loadResp.ok) return "";
      const loadData: any = await loadResp.json();

      // Extract project from loadCodeAssist response
      let projectId = this.extractProjectId(loadData);

      // Extract default tier ID for onboarding
      const tierId = this.extractDefaultTierId(loadData);

      // Step 2: onboardUser to activate the project
      if (tierId) {
        const onboardedProject = await this.onboardUser(accessToken, tierId, projectId);
        if (onboardedProject) {
          projectId = onboardedProject;
        }
      }

      return projectId;
    } catch {
      // Project ID fetch failure is non-fatal at login time
    }
    return "";
  }

  /**
   * Call onboardUser endpoint and poll until done.
   */
  private async onboardUser(
    accessToken: string,
    tierId: string,
    existingProjectId?: string,
  ): Promise<string> {
    try {
      const body: any = {
        tierId,
        metadata: ONBOARD_METADATA,
      };
      if (existingProjectId) {
        body.cloudaicompanionProject = existingProjectId;
      }

      const resp = await fetch(ONBOARD_USER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) return "";

      let data: any = await resp.json();

      // Poll if the operation is not yet done (up to 30s)
      const deadline = Date.now() + 30_000;
      while (!data.done && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        // Re-call to check status
        const pollResp = await fetch(ONBOARD_USER_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        if (!pollResp.ok) break;
        data = await pollResp.json();
      }

      // Extract project from the response
      const response = data.response || data;
      return this.extractProjectId(response);
    } catch {
      return "";
    }
  }

  private extractProjectId(data: any): string {
    if (typeof data.cloudaicompanionProject === "string") {
      return data.cloudaicompanionProject.trim();
    }
    if (typeof data.cloudaicompanionProject?.id === "string") {
      return data.cloudaicompanionProject.id.trim();
    }
    return "";
  }

  private extractDefaultTierId(data: any): string {
    const tiers = data.allowedTiers;
    if (!Array.isArray(tiers) || tiers.length === 0) return "";
    // Find the default tier
    const defaultTier = tiers.find((t: any) => t.isDefault === true);
    return defaultTier?.tierId || tiers[0]?.tierId || "";
  }

  private async fetchUserEmail(accessToken: string): Promise<string> {
    try {
      const resp = await fetch(USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (resp.ok) {
        const info: any = await resp.json();
        return info.email || "unknown";
      }
    } catch {
      // Ignore userinfo failures
    }
    return "unknown";
  }
}
