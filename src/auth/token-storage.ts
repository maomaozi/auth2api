import fs from "fs";
import path from "path";
import { TokenData, TokenStorage } from "./types";
import { ProviderType } from "./provider-interface";

export function tokenToStorage(data: TokenData): TokenStorage {
  return {
    access_token: data.accessToken,
    refresh_token: data.refreshToken,
    last_refresh: new Date().toISOString(),
    email: data.email,
    type: data.provider,
    expired: data.expiresAt,
    account_uuid: data.accountUuid,
    project_id: data.projectId,
  };
}

export function storageToToken(storage: TokenStorage): TokenData {
  return {
    accessToken: storage.access_token,
    refreshToken: storage.refresh_token,
    email: storage.email,
    expiresAt: storage.expired,
    accountUuid: storage.account_uuid || "",
    provider: storage.type,
    projectId: storage.project_id,
  };
}

function sanitizeEmail(email: string): string {
  return email
    .replace(/[^a-zA-Z0-9@._-]/g, "_")
    .replace(/\.\./g, "_");
}

/**
 * Save a token file using the naming convention: {provider}-{email}.json
 * All providers share the same auth directory.
 */
export function saveToken(authDir: string, data: TokenData): void {
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const sanitized = sanitizeEmail(data.email);
  const filename = `${data.provider}-${sanitized}.json`;
  const filePath = path.join(authDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(tokenToStorage(data), null, 2), {
    mode: 0o600,
  });
}

/**
 * Known provider types and their pre-computed file prefixes.
 */
const PROVIDER_TYPES: ProviderType[] = ["claude", "codex", "gemini"];
const ALL_FILE_PREFIXES = PROVIDER_TYPES.map((p) => `${p}-`);

/**
 * Load all tokens from the auth directory.
 * Matches files named {provider}-{email}.json for all known providers.
 * Optionally filter by a specific provider.
 */
export function loadAllTokens(
  authDir: string,
  filterProvider?: ProviderType,
): TokenData[] {
  let fileList: string[];
  try {
    fileList = fs.readdirSync(authDir);
  } catch {
    return []; // directory does not exist
  }

  const prefixes = filterProvider
    ? [`${filterProvider}-`]
    : ALL_FILE_PREFIXES;

  const files = fileList
    .filter((f) => {
      if (!f.endsWith(".json")) return false;
      return prefixes.some((p) => f.startsWith(p));
    });

  const tokens: TokenData[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(authDir, file), "utf-8");
      const storage = JSON.parse(raw) as TokenStorage;

      // Backward compatibility: files without a "type" field are assumed to be Claude
      if (!storage.type) {
        (storage as any).type = "claude";
      }

      // Validate that the provider type is known
      if (!PROVIDER_TYPES.includes(storage.type)) {
        console.error(`Unknown provider type in ${file}: ${storage.type}`);
        continue;
      }

      tokens.push(storageToToken(storage));
    } catch {
      console.error(`Failed to load token file: ${file}`);
    }
  }
  return tokens;
}
