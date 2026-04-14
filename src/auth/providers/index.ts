import { AuthProvider, ProviderType } from "../provider-interface";
import { ClaudeAuthProvider } from "./claude";
import { CodexAuthProvider } from "./codex";
import { GeminiAuthProvider } from "./gemini";

const providers = new Map<ProviderType, AuthProvider>([
  ["claude", new ClaudeAuthProvider()],
  ["codex", new CodexAuthProvider()],
  ["gemini", new GeminiAuthProvider()],
]);

export function getAuthProvider(type: ProviderType): AuthProvider {
  const provider = providers.get(type);
  if (!provider) throw new Error(`Unknown provider: ${type}`);
  return provider;
}

export { ClaudeAuthProvider, CodexAuthProvider, GeminiAuthProvider };
