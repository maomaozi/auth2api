import { ProviderType } from "./provider-interface";

export interface PKCECodes {
  codeVerifier: string;
  codeChallenge: string;
}

export interface TokenData {
  accessToken: string;
  refreshToken: string;
  email: string;
  expiresAt: string; // ISO 8601
  accountUuid: string; // from OAuth token response: data.account.uuid
  provider: ProviderType;
  projectId?: string; // GCP project ID (Gemini only)
}

export interface TokenStorage {
  access_token: string;
  refresh_token: string;
  last_refresh: string;
  email: string;
  type: ProviderType;
  expired: string; // ISO 8601
  account_uuid?: string;
  project_id?: string; // GCP project ID (Gemini only)
}
