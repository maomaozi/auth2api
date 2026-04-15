import { v4 as uuidv4 } from "uuid";
import { formatSSEEvent } from "./shared";

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
      .map((t: any) => ({
        name: t.function.name,
        description: t.function.description || "",
        parametersJsonSchema: cleanSchemaForGemini(t.function.parameters),
      }));
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

// ══════════════════════════════════════════════════════════════════
// Direct Claude Messages API ↔ Gemini translators
// (bypass intermediate OpenAI Chat Completions format)
// ══════════════════════════════════════════════════════════════════

// ── Helper: convert Claude image source to Gemini part ──

function claudeImageToGeminiPart(block: any): any | null {
  if (block.source?.type === "base64") {
    return {
      inlineData: {
        mimeType: block.source.media_type || "application/octet-stream",
        data: block.source.data,
      },
    };
  }
  if (block.source?.type === "url") {
    return {
      fileData: {
        fileUri: block.source.url,
        mimeType: "image/jpeg",
      },
    };
  }
  return null;
}

// ── Helper: clean schema for Gemini ──

function cleanSchemaForGemini(schema: any): any {
  if (!schema) return { type: "object", properties: {} };
  const params = { ...schema };
  delete params.$schema;
  if (params.type === "object") {
    params.additionalProperties = false;
  }
  return params;
}

// ── Claude Messages request → Gemini CLI native format (direct) ──

export function claudeToGeminiCLI(body: any, projectId: string): any {
  const model = body.model || "gemini-2.5-pro";

  const request: any = {
    contents: [],
    generationConfig: {},
  };

  // system → systemInstruction
  if (body.system) {
    const parts = Array.isArray(body.system) ? body.system : [body.system];
    const systemParts: any[] = [];
    for (const p of parts) {
      const text = typeof p === "string" ? p : p.text || "";
      if (text) systemParts.push({ text });
    }
    if (systemParts.length) {
      request.systemInstruction = { role: "user", parts: systemParts };
    }
  }

  // Claude messages → Gemini contents
  const contents: any[] = [];
  // Track tool_use names from assistant for backfilling functionResponse
  const pendingToolNames: string[] = [];

  for (const msg of body.messages || []) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        contents.push({ role: "user", parts: [{ text: msg.content }] });
      } else if (Array.isArray(msg.content)) {
        const userParts: any[] = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            userParts.push({ text: block.text });
          } else if (block.type === "image") {
            const gp = claudeImageToGeminiPart(block);
            if (gp) userParts.push(gp);
          } else if (block.type === "tool_result") {
            // tool_result → functionResponse (user role)
            let response: any;
            if (typeof block.content === "string") {
              try { response = JSON.parse(block.content); }
              catch { response = { result: block.content }; }
            } else if (Array.isArray(block.content)) {
              const texts = block.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("\n");
              response = texts ? { result: texts } : { result: JSON.stringify(block.content) };
            } else {
              response = block.content || { result: "" };
            }
            // Get function name from pending queue
            const name = pendingToolNames.shift() || "";
            userParts.push({
              functionResponse: { name, response },
            });
          }
        }
        if (userParts.length) contents.push({ role: "user", parts: userParts });
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        if (msg.content) contents.push({ role: "model", parts: [{ text: msg.content }] });
      } else if (Array.isArray(msg.content)) {
        const modelParts: any[] = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            modelParts.push({ text: block.text });
          } else if (block.type === "tool_use") {
            // Track name for backfill
            pendingToolNames.push(block.name || "");
            let args: any = {};
            if (typeof block.input === "string") {
              try { args = JSON.parse(block.input); } catch { /* ignore */ }
            } else {
              args = block.input || {};
            }
            modelParts.push({
              functionCall: { name: block.name || "", args },
              thoughtSignature: "skip_thought_signature_validator",
            });
          }
          // thinking, redacted_thinking → skip
        }
        if (modelParts.length) contents.push({ role: "model", parts: modelParts });
      }
    }
  }

  // Enforce role alternation
  request.contents = enforceRoleAlternation(contents);

  // Safety settings
  request.safetySettings = DEFAULT_SAFETY_SETTINGS;

  // Generation config
  const genConfig: any = {};
  if (body.max_tokens) genConfig.maxOutputTokens = body.max_tokens;
  if (body.temperature !== undefined) genConfig.temperature = body.temperature;
  if (body.top_p !== undefined) genConfig.topP = body.top_p;
  if (body.stop_sequences) {
    genConfig.stopSequences = body.stop_sequences;
  }
  if (Object.keys(genConfig).length) request.generationConfig = genConfig;

  // thinking → thinkingConfig
  if (body.thinking?.type === "enabled" && body.thinking.budget_tokens) {
    request.generationConfig.thinkingConfig = {
      thinkingBudget: body.thinking.budget_tokens,
      includeThoughts: true,
    };
  } else if (body.thinking?.type === "disabled") {
    request.generationConfig.thinkingConfig = { thinkingLevel: "none" };
  }

  // Tools (Claude format: name/description/input_schema)
  if (body.tools) {
    const functionDeclarations = body.tools
      .filter((t: any) => t.name) // Claude tools have name at top level
      .map((t: any) => ({
        name: t.name,
        description: t.description || "",
        parametersJsonSchema: cleanSchemaForGemini(t.input_schema || t.parameters),
      }));
    if (functionDeclarations.length) {
      request.tools = [{ functionDeclarations }];
    }
  }

  // tool_choice → toolConfig
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc.type === "auto") {
      request.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    } else if (tc.type === "none") {
      request.toolConfig = { functionCallingConfig: { mode: "NONE" } };
    } else if (tc.type === "any") {
      request.toolConfig = { functionCallingConfig: { mode: "ANY" } };
    } else if (tc.type === "tool" && tc.name) {
      request.toolConfig = {
        functionCallingConfig: {
          mode: "ANY",
          allowedFunctionNames: [tc.name],
        },
      };
    }
  }

  return { project: projectId, model, request };
}

// ── Gemini response → Claude Messages response (non-streaming, direct) ──

export function geminiResponseToClaudeDirect(respData: any, model: string): any {
  const data = respData.response || respData;
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const content: any[] = [];
  let hasToolUse = false;

  for (const part of parts) {
    if (part.thought === true && part.text !== undefined) {
      content.push({ type: "thinking", thinking: part.text });
    } else if (part.text !== undefined) {
      content.push({ type: "text", text: part.text });
    } else if (part.functionCall) {
      hasToolUse = true;
      content.push({
        type: "tool_use",
        id: `toolu_${uuidv4().replace(/-/g, "").slice(0, 24)}`,
        name: part.functionCall.name || "",
        input: part.functionCall.args || {},
      });
    }
  }

  const finishReason = candidate?.finishReason;
  let stopReason: string;
  if (hasToolUse) {
    stopReason = "tool_use";
  } else if (finishReason === "MAX_TOKENS") {
    stopReason = "max_tokens";
  } else {
    stopReason = "end_turn";
  }

  const usage = data.usageMetadata;
  return {
    id: `msg_${uuidv4()}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage?.promptTokenCount || 0,
      output_tokens: (usage?.candidatesTokenCount || 0) + (usage?.thoughtsTokenCount || 0),
    },
  };
}

// ── Gemini SSE → Claude SSE (streaming, direct) ──

const RESP_NONE = 0;
const RESP_TEXT = 1;
const RESP_THINKING = 2;
const RESP_TOOL = 3;

export interface GeminiToClaudeStreamState {
  model: string;
  blockIndex: number;
  responseType: number;
  started: boolean;
  hasToolCall: boolean;
  hasContent: boolean;
  inputTokens: number;
  outputTokens: number;
}

export function createGeminiToClaudeStreamState(model: string): GeminiToClaudeStreamState {
  return {
    model,
    blockIndex: 0,
    responseType: RESP_NONE,
    started: false,
    hasToolCall: false,
    hasContent: false,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function closeBlock(events: string[], state: GeminiToClaudeStreamState): void {
  if (state.responseType !== RESP_NONE) {
    events.push(formatSSEEvent("content_block_stop", {
      type: "content_block_stop",
      index: state.blockIndex,
    }));
    state.blockIndex++;
    state.responseType = RESP_NONE;
  }
}

/**
 * Convert a Gemini SSE data chunk directly to Claude Messages SSE events.
 * No intermediate OpenAI format — direct translation.
 */
export function geminiSSEToClaudeEvents(
  data: any,
  state: GeminiToClaudeStreamState,
): string[] {
  const events: string[] = [];

  // Unwrap Gemini CLI envelope
  const respData = data.response || data;

  // First chunk: emit message_start
  if (!state.started) {
    state.started = true;
    events.push(formatSSEEvent("message_start", {
      type: "message_start",
      message: {
        id: `msg_${uuidv4()}`,
        type: "message",
        role: "assistant",
        content: [],
        model: state.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }));
  }

  const candidate = respData.candidates?.[0];
  const parts = candidate?.content?.parts || [];

  for (const part of parts) {
    if (part.thought === true && part.text !== undefined) {
      // Thinking part
      if (state.responseType !== RESP_THINKING) {
        closeBlock(events, state);
        events.push(formatSSEEvent("content_block_start", {
          type: "content_block_start",
          index: state.blockIndex,
          content_block: { type: "thinking", thinking: "" },
        }));
        state.responseType = RESP_THINKING;
      }
      events.push(formatSSEEvent("content_block_delta", {
        type: "content_block_delta",
        index: state.blockIndex,
        delta: { type: "thinking_delta", thinking: part.text },
      }));
      state.hasContent = true;
    } else if (part.text !== undefined) {
      // Text part
      if (state.responseType !== RESP_TEXT) {
        closeBlock(events, state);
        events.push(formatSSEEvent("content_block_start", {
          type: "content_block_start",
          index: state.blockIndex,
          content_block: { type: "text", text: "" },
        }));
        state.responseType = RESP_TEXT;
      }
      events.push(formatSSEEvent("content_block_delta", {
        type: "content_block_delta",
        index: state.blockIndex,
        delta: { type: "text_delta", text: part.text },
      }));
      state.hasContent = true;
    } else if (part.functionCall) {
      // Function call — each is a separate tool_use block
      closeBlock(events, state);
      state.hasToolCall = true;
      const toolId = `toolu_${uuidv4().replace(/-/g, "").slice(0, 24)}`;
      events.push(formatSSEEvent("content_block_start", {
        type: "content_block_start",
        index: state.blockIndex,
        content_block: {
          type: "tool_use",
          id: toolId,
          name: part.functionCall.name || "",
        },
      }));
      // Emit full args as single input_json_delta
      const argsStr = JSON.stringify(part.functionCall.args || {});
      events.push(formatSSEEvent("content_block_delta", {
        type: "content_block_delta",
        index: state.blockIndex,
        delta: { type: "input_json_delta", partial_json: argsStr },
      }));
      state.responseType = RESP_TOOL;
      state.hasContent = true;
    }
  }

  // Usage metadata
  const usage = respData.usageMetadata;
  if (usage) {
    state.inputTokens = usage.promptTokenCount || 0;
    state.outputTokens = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
  }

  // Finish reason
  const finishReason = candidate?.finishReason;
  if (finishReason && state.hasContent) {
    closeBlock(events, state);

    let stopReason: string;
    if (state.hasToolCall) {
      stopReason = "tool_use";
    } else if (finishReason === "MAX_TOKENS") {
      stopReason = "max_tokens";
    } else {
      stopReason = "end_turn";
    }

    events.push(formatSSEEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        input_tokens: state.inputTokens,
        output_tokens: state.outputTokens,
      },
    }));
    events.push(formatSSEEvent("message_stop", { type: "message_stop" }));
  }

  return events;
}
