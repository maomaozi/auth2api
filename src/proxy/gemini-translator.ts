import { v4 as uuidv4 } from "uuid";

// ── Default safety settings (match CLIProxyAPI reference) ──

const DEFAULT_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
];

// ── OpenAI Chat Completions → Gemini CLI native format ──

export function openaiToGeminiCLI(body: any, projectId: string): any {
  const model = body.model || "gemini-2.5-pro";

  const request: any = {
    contents: [],
    generationConfig: {},
  };

  // System messages → systemInstruction
  const systemParts: any[] = [];
  const contents: any[] = [];

  for (const msg of body.messages || []) {
    if (msg.role === "system" || msg.role === "developer") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content?.map((c: any) => c.text).join("\n") || "";
      systemParts.push({ text });
      continue;
    }

    if (msg.role === "user") {
      const parts = convertMessageToParts(msg);
      contents.push({ role: "user", parts });
      continue;
    }

    if (msg.role === "assistant") {
      const parts: any[] = [];

      // Text content
      if (typeof msg.content === "string" && msg.content) {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text") parts.push({ text: part.text });
        }
      }

      // Tool calls → functionCall parts (with thoughtSignature)
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let args: any = {};
          try {
            args = JSON.parse(tc.function?.arguments || "{}");
          } catch { /* ignore */ }
          parts.push({
            functionCall: {
              name: tc.function?.name || "",
              args,
            },
            thoughtSignature: "skip_thought_signature_validator",
          });
        }
      }

      if (parts.length) contents.push({ role: "model", parts });
      continue;
    }

    if (msg.role === "tool") {
      // Tool results → functionResponse parts
      let response: any;
      try {
        response = typeof msg.content === "string"
          ? JSON.parse(msg.content)
          : msg.content;
      } catch {
        response = { result: msg.content };
      }
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: msg.name || "",
              response: response,
            },
          },
        ],
      });
      continue;
    }
  }

  if (systemParts.length) {
    request.systemInstruction = {
      role: "user",
      parts: systemParts,
    };
  }

  // Backfill empty functionResponse names from preceding model functionCall names
  backfillFunctionResponseNames(contents);

  // Enforce role alternation: merge consecutive same-role messages
  request.contents = enforceRoleAlternation(contents);

  // Safety settings
  request.safetySettings = DEFAULT_SAFETY_SETTINGS;

  // Generation config
  const genConfig: any = {};
  if (body.max_tokens) genConfig.maxOutputTokens = body.max_tokens;
  if (body.temperature !== undefined) genConfig.temperature = body.temperature;
  if (body.top_p !== undefined) genConfig.topP = body.top_p;
  if (body.stop) {
    genConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }
  if (Object.keys(genConfig).length) request.generationConfig = genConfig;

  // Thinking/reasoning
  if (body.reasoning_effort) {
    const effort = body.reasoning_effort;
    if (effort === "none") {
      request.generationConfig.thinkingConfig = { thinkingLevel: "none" };
    } else {
      request.generationConfig.thinkingConfig = {
        thinkingLevel: effort,
        includeThoughts: true,
      };
    }
  }

  // Tools
  if (body.tools) {
    const functionDeclarations = body.tools
      .filter((t: any) => t.type === "function" && t.function)
      .map((t: any) => {
        const params = { ...(t.function.parameters || { type: "object", properties: {} }) };
        // Remove $schema which Gemini doesn't accept
        delete params.$schema;
        // Enforce strict object validation
        if (params.type === "object") {
          params.additionalProperties = false;
        }
        return {
          name: t.function.name,
          description: t.function.description || "",
          parametersJsonSchema: params,
        };
      });
    if (functionDeclarations.length) {
      request.tools = [{ functionDeclarations }];
    }
  }

  // Wrap in Gemini CLI envelope
  return {
    project: projectId,
    model,
    request,
  };
}

function convertMessageToParts(msg: any): any[] {
  const parts: any[] = [];

  if (typeof msg.content === "string") {
    parts.push({ text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === "text") {
        parts.push({ text: part.text });
      } else if (part.type === "image_url" && part.image_url?.url) {
        const url: string = part.image_url.url;
        if (url.startsWith("data:")) {
          const match = url.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            parts.push({
              inlineData: {
                mimeType: match[1],
                data: match[2],
              },
            });
          }
        } else {
          parts.push({
            fileData: {
              fileUri: url,
              mimeType: "image/jpeg",
            },
          });
        }
      }
    }
  }

  return parts.length ? parts : [{ text: "" }];
}

// ── Gemini native response → OpenAI Chat Completions response ──

export function geminiToOpenAI(respData: any, model: string): any {
  // Unwrap Gemini CLI envelope if present
  const data = respData.response || respData;
  const candidate = data.candidates?.[0];
  const content = candidate?.content;
  const parts = content?.parts || [];

  let textContent = "";
  let reasoning = "";
  const toolCalls: any[] = [];

  for (const part of parts) {
    if (part.thought === true && part.text !== undefined) {
      // Thinking part: thought is a boolean flag, actual content is in text
      reasoning += part.text;
    } else if (part.text !== undefined) {
      textContent += part.text;
    } else if (part.functionCall) {
      toolCalls.push({
        id: `call_${uuidv4().replace(/-/g, "").slice(0, 24)}`,
        type: "function",
        function: {
          name: part.functionCall.name || "",
          arguments: JSON.stringify(part.functionCall.args || {}),
        },
      });
    }
  }

  const message: any = {
    role: "assistant",
    content: textContent || null,
  };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;

  // Map finish reason
  const finishReason = mapFinishReason(candidate?.finishReason);

  // Usage
  const usage = data.usageMetadata;

  return {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: usage?.promptTokenCount || 0,
      completion_tokens: usage?.candidatesTokenCount || 0,
      total_tokens: usage?.totalTokenCount || 0,
    },
  };
}

function mapFinishReason(reason: string | undefined): string {
  switch (reason) {
    case "STOP": return "stop";
    case "MAX_TOKENS": return "length";
    case "SAFETY": return "content_filter";
    case "RECITATION": return "content_filter";
    default: return "stop";
  }
}

// ── Gemini SSE → OpenAI Chat Completions SSE ──

export interface GeminiStreamState {
  chatId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  started: boolean;
  finishSent: boolean;
}

export function createGeminiStreamState(model: string): GeminiStreamState {
  return {
    chatId: `chatcmpl-${uuidv4()}`,
    model,
    inputTokens: 0,
    outputTokens: 0,
    started: false,
    finishSent: false,
  };
}

function makeChunk(
  state: GeminiStreamState,
  delta: any,
  finishReason: string | null,
  usage?: any,
): string {
  const chunk: any = {
    id: state.chatId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) chunk.usage = usage;
  return JSON.stringify(chunk);
}

/**
 * Convert a Gemini SSE data chunk to OpenAI SSE chunks.
 */
export function geminiSSEToOpenAI(
  data: any,
  state: GeminiStreamState,
): string[] {
  const chunks: string[] = [];

  // Unwrap Gemini CLI envelope
  const respData = data.response || data;

  if (!state.started) {
    state.started = true;
    chunks.push(makeChunk(state, { role: "assistant", content: "" }, null));
  }

  const candidate = respData.candidates?.[0];
  const parts = candidate?.content?.parts || [];

  for (const part of parts) {
    if (part.thought === true && part.text !== undefined) {
      chunks.push(makeChunk(state, { reasoning_content: part.text }, null));
    } else if (part.text !== undefined) {
      chunks.push(makeChunk(state, { content: part.text }, null));
    } else if (part.functionCall) {
      const tcId = `call_${uuidv4().replace(/-/g, "").slice(0, 24)}`;
      chunks.push(
        makeChunk(
          state,
          {
            tool_calls: [
              {
                index: 0,
                id: tcId,
                type: "function",
                function: {
                  name: part.functionCall.name || "",
                  arguments: JSON.stringify(part.functionCall.args || {}),
                },
              },
            ],
          },
          null,
        ),
      );
    }
  }

  // Usage metadata
  const usage = respData.usageMetadata;
  if (usage) {
    state.inputTokens = usage.promptTokenCount || 0;
    state.outputTokens = usage.candidatesTokenCount || 0;
  }

  // Finish reason — emit for all finish reasons including STOP
  const finishReason = candidate?.finishReason;
  if (finishReason) {
    state.finishSent = true;
    chunks.push(
      makeChunk(state, {}, mapFinishReason(finishReason), usage ? {
        prompt_tokens: usage.promptTokenCount || 0,
        completion_tokens: usage.candidatesTokenCount || 0,
        total_tokens: usage.totalTokenCount || 0,
      } : undefined),
    );
  }

  return chunks;
}

// ── Helpers for role alternation and functionResponse name backfill ──

/**
 * Enforce Gemini's strict role alternation requirement.
 * - Ensures first message is "user" role
 * - Merges consecutive same-role messages by combining their parts
 */
function enforceRoleAlternation(contents: any[]): any[] {
  if (contents.length === 0) return contents;

  // Ensure first content is user role
  if (contents[0].role !== "user") {
    contents.unshift({ role: "user", parts: [{ text: "" }] });
  }

  // Merge consecutive same-role messages
  const merged: any[] = [contents[0]];
  for (let i = 1; i < contents.length; i++) {
    const prev = merged[merged.length - 1];
    if (contents[i].role === prev.role) {
      prev.parts = prev.parts.concat(contents[i].parts);
    } else {
      merged.push(contents[i]);
    }
  }

  return merged;
}

/**
 * Backfill empty functionResponse names from preceding model functionCall names.
 * Walks contents and tracks functionCall names from model turns.
 * For user turns with functionResponse parts that have empty names,
 * fills from the tracked names queue in order.
 */
function backfillFunctionResponseNames(contents: any[]): void {
  const pendingCallNames: string[] = [];

  for (const content of contents) {
    if (content.role === "model") {
      for (const part of content.parts || []) {
        if (part.functionCall?.name) {
          pendingCallNames.push(part.functionCall.name);
        }
      }
    } else if (content.role === "user") {
      for (const part of content.parts || []) {
        if (part.functionResponse && !part.functionResponse.name) {
          const name = pendingCallNames.shift();
          if (name) {
            part.functionResponse.name = name;
          }
        }
      }
    }
  }
}
