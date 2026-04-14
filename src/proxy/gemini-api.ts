import { TimeoutConfig } from "../config";

const GEMINI_CLI_BASE_URL = "https://cloudcode-pa.googleapis.com";
const GEMINI_CLI_VERSION = "v1internal";
const GEMINI_CLI_APP_VERSION = "0.31.0";
const GEMINI_SDK_CLIENT = "google-genai-sdk/1.41.0 gl-node/v22.19.0";

function getOS(): string {
  const platform = process.platform;
  if (platform === "darwin") return "darwin";
  if (platform === "win32") return "win32";
  return "linux";
}

function getArch(): string {
  const arch = process.arch;
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x64";
  return "x86";
}

function buildUserAgent(model: string): string {
  return `GeminiCLI/${GEMINI_CLI_APP_VERSION}/${model} (${getOS()}; ${getArch()})`;
}

/**
 * Call the Gemini CLI backend endpoint (Cloud Code Assist).
 *
 * Uses cloudcode-pa.googleapis.com/v1internal (the real Gemini CLI endpoint).
 * Request format: Gemini native with project/model envelope.
 */
export async function callGeminiAPI(
  accessToken: string,
  body: any,
  stream: boolean,
  timeouts: TimeoutConfig,
): Promise<Response> {
  const action = stream ? "streamGenerateContent" : "generateContent";
  const query = stream ? "?alt=sse" : "";
  const url = `${GEMINI_CLI_BASE_URL}/${GEMINI_CLI_VERSION}:${action}${query}`;
  const timeoutMs = stream
    ? timeouts["stream-messages-ms"]
    : timeouts["messages-ms"];

  const model = body.model || "gemini-2.5-pro";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": buildUserAgent(model),
    "X-Goog-Api-Client": GEMINI_SDK_CLIENT,
    Accept: stream ? "text/event-stream" : "application/json",
  };

  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}
