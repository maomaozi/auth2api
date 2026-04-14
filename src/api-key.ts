import crypto from "crypto";

export interface ApiKeyInfo {
  apiKey: string;
  apiKeyHash: string;
  keyPrefix: string;
}

export function extractApiKey(headers: {
  authorization?: string;
  "x-api-key"?: string | string[];
}): string {
  const auth = headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }

  const xApiKey = headers["x-api-key"];
  if (typeof xApiKey === "string") {
    return xApiKey;
  }
  if (Array.isArray(xApiKey) && xApiKey.length > 0) {
    return xApiKey[0];
  }

  return "";
}

export function extractApiKeyInfo(headers: {
  authorization?: string;
  "x-api-key"?: string | string[];
}): ApiKeyInfo {
  const apiKey = extractApiKey(headers);
  const apiKeyHash = crypto
    .createHash("sha256")
    .update(apiKey)
    .digest("hex");
  const keyPrefix = apiKey.slice(0, 8);
  return { apiKey, apiKeyHash, keyPrefix };
}
