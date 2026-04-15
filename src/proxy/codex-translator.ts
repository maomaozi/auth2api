import { v4 as uuidv4 } from "uuid";
import { formatSSEEvent } from "./shared";

// ── Tool name mapping: shortened → original ──

export type ToolNameMap = Map<string, string>;

export interface CodexRequestResult {
  body: any;
  toolNameMap: ToolNameMap;
}

// ── OpenAI Chat Completions request → Codex Responses API request ──

export function chatCompletionsToCodexRequest(body: any): CodexRequestResult {
  const codexBody: any = {
    model: body.model,
    stream: !!body.stream,
  };

  if (body.max_tokens) codexBody.max_output_tokens = body.max_tokens;
  if (body.temperature !== undefined) codexBody.temperature = body.temperature;
  if (body.top_p !== undefined) codexBody.top_p = body.top_p;

  // reasoning_effort → reasoning (with summary)
  if (body.reasoning_effort) {
    codexBody.reasoning = { effort: body.reasoning_effort, summary: "auto" };
  } else {
    codexBody.reasoning = { effort: "medium", summary: "auto" };
  }

  codexBody.include = ["reasoning.encrypted_content"];
  codexBody.parallel_tool_calls = true;

  // Build input[] from messages[]
  const input: any[] = [];
  let instructions = "";

  for (const msg of body.messages || []) {
    if (msg.role === "system" || msg.role === "developer") {
      // System messages become instructions
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content?.map((c: any) => c.text).join("\n") || "";
      instructions += (instructions ? "\n" : "") + text;
      continue;
    }

    if (msg.role === "tool") {
      // Tool results → function_call_output
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output:
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content),
      });
      continue;
    }

    if (msg.role === "assistant" && msg.tool_calls) {
      // Assistant with tool_calls → function_call items
      // First, add any text content
      if (msg.content) {
        input.push({
          type: "message",
          role: "assistant",
          content: typeof msg.content === "string" ? msg.content : "",
        });
      }
      for (const tc of msg.tool_calls) {
        input.push({
          type: "function_call",
          id: tc.id,
          call_id: tc.id,
          name: tc.function?.name || "",
          arguments: tc.function?.arguments || "{}",
          status: "completed",
        });
      }
      continue;
    }

    // Regular user/assistant messages
    input.push({
      type: "message",
      role: msg.role === "user" ? "user" : "assistant",
      content: msg.content,
    });
  }

  // Always include instructions (even if empty) for Codex normalization
  codexBody.instructions = instructions;
  codexBody.input = input;

  // Tools (with name truncation to ≤64 chars + mapping for restoration)
  const toolNameMap: ToolNameMap = new Map();
  if (body.tools) {
    codexBody.tools = body.tools.map((t: any) => {
      if (t.type === "function" && t.function) {
        const originalName = t.function.name || "";
        const shortened = shortenToolName(originalName, toolNameMap);
        return {
          type: "function",
          name: shortened,
          description: t.function.description || "",
          parameters: t.function.parameters || { type: "object", properties: {} },
        };
      }
      return t;
    });
  }

  if (body.tool_choice) {
    codexBody.tool_choice = body.tool_choice;
  }

  return { body: codexBody, toolNameMap };
}

// ── Codex Responses API response → OpenAI Chat Completions response ──

export function codexResponseToOpenAI(respData: any, model: string, toolNameMap?: ToolNameMap): any {
  const output = respData.output || [];
  let textContent = "";
  const toolCalls: any[] = [];

  for (const item of output) {
    if (item.type === "message") {
      // Extract text from content parts
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === "output_text") {
            textContent += part.text || "";
          }
        }
      } else if (typeof item.content === "string") {
        textContent += item.content;
      }
    } else if (item.type === "function_call") {
      const rawName = item.name || "";
      toolCalls.push({
        id: item.call_id || item.id,
        type: "function",
        function: {
          name: toolNameMap?.get(rawName) || rawName,
          arguments: item.arguments || "{}",
        },
      });
    }
  }

  const message: any = {
    role: "assistant",
    content: textContent || null,
  };
  if (toolCalls.length) message.tool_calls = toolCalls;

  const finishReason =
    respData.status === "incomplete"
      ? "length"
      : toolCalls.length
        ? "tool_calls"
        : "stop";

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
      prompt_tokens: respData.usage?.input_tokens || 0,
      completion_tokens: respData.usage?.output_tokens || 0,
      total_tokens: respData.usage?.total_tokens || 0,
    },
  };
}

// ── Codex SSE → OpenAI Chat Completions SSE ──

export interface CodexStreamState {
  chatId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  started: boolean;
  hasToolCalls: boolean;
  toolNameMap: ToolNameMap;
}

export function createCodexStreamState(model: string, toolNameMap?: ToolNameMap): CodexStreamState {
  return {
    chatId: `chatcmpl-${uuidv4()}`,
    model,
    inputTokens: 0,
    outputTokens: 0,
    started: false,
    hasToolCalls: false,
    toolNameMap: toolNameMap || new Map(),
  };
}

function makeOpenAIChunk(
  state: CodexStreamState,
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
 * Convert a Codex Responses API SSE event to OpenAI Chat Completions SSE chunks.
 */
export function codexSSEToOpenAI(
  eventData: any,
  state: CodexStreamState,
): string[] {
  const chunks: string[] = [];
  const type = eventData.type;

  if (type === "response.created" || type === "response.in_progress") {
    if (!state.started) {
      state.started = true;
      chunks.push(makeOpenAIChunk(state, { role: "assistant", content: "" }, null));
    }
    return chunks;
  }

  if (type === "response.output_text.delta") {
    chunks.push(makeOpenAIChunk(state, { content: eventData.delta || "" }, null));
    return chunks;
  }

  if (type === "response.reasoning_summary_text.delta") {
    chunks.push(makeOpenAIChunk(state, { reasoning_content: eventData.delta || "" }, null));
    return chunks;
  }

  if (type === "response.output_item.added") {
    const item = eventData.item;
    if (item?.type === "function_call") {
      state.hasToolCalls = true;
      const rawName = item.name || "";
      chunks.push(
        makeOpenAIChunk(
          state,
          {
            tool_calls: [
              {
                index: eventData.output_index || 0,
                id: item.call_id || item.id,
                type: "function",
                function: { name: state.toolNameMap.get(rawName) || rawName, arguments: "" },
              },
            ],
          },
          null,
        ),
      );
    }
    return chunks;
  }

  if (type === "response.function_call_arguments.delta") {
    chunks.push(
      makeOpenAIChunk(
        state,
        {
          tool_calls: [
            {
              index: eventData.output_index || 0,
              function: { arguments: eventData.delta || "" },
            },
          ],
        },
        null,
      ),
    );
    return chunks;
  }

  if (type === "response.completed") {
    const resp = eventData.response;
    const usage = resp?.usage;
    if (usage) {
      state.inputTokens = usage.input_tokens || 0;
      state.outputTokens = usage.output_tokens || 0;
    }
    const status = resp?.status;
    const finishReason = status === "incomplete"
      ? "length"
      : state.hasToolCalls
        ? "tool_calls"
        : "stop";
    chunks.push(
      makeOpenAIChunk(state, {}, finishReason, usage ? {
        prompt_tokens: usage.input_tokens || 0,
        completion_tokens: usage.output_tokens || 0,
        total_tokens: usage.total_tokens || 0,
      } : undefined),
    );
    chunks.push("[DONE]");
    return chunks;
  }

  return chunks;
}

// ── Tool name truncation ──

const MAX_TOOL_NAME_LENGTH = 64;

/**
 * Shorten tool name to ≤64 characters.
 * Preserves `mcp__` prefix if present, then takes the last segment.
 * Records the mapping (shortened → original) in nameMap for later restoration.
 */
function shortenToolName(name: string, nameMap: ToolNameMap): string {
  if (name.length <= MAX_TOOL_NAME_LENGTH) return name;

  let shortened: string;

  // If it has mcp__ prefix, try to preserve prefix + last segment
  if (name.startsWith("mcp__")) {
    const withoutPrefix = name.slice(5); // remove "mcp__"
    const segments = withoutPrefix.split("_");
    const lastSegment = segments[segments.length - 1];
    shortened = `mcp__${lastSegment}`;
    if (shortened.length > MAX_TOOL_NAME_LENGTH) {
      shortened = shortened.slice(0, MAX_TOOL_NAME_LENGTH);
    }
  } else {
    shortened = name.slice(0, MAX_TOOL_NAME_LENGTH);
  }

  nameMap.set(shortened, name);
  return shortened;
}

// ── Budget → effort mapping for thinking ──

function budgetToEffort(budget: number): string {
  if (budget <= 0) return "none";
  if (budget <= 1024) return "low";
  if (budget <= 8192) return "medium";
  if (budget <= 24576) return "high";
  return "xhigh";
}

// ══════════════════════════════════════════════════════════════════
// Direct Claude Messages API ↔ Codex Responses API translators
// (bypass intermediate OpenAI Chat Completions format)
// ══════════════════════════════════════════════════════════════════

// ── Claude Messages request → Codex Responses API request (direct) ──

export function claudeToCodexRequest(body: any): CodexRequestResult {
  const codexBody: any = {
    model: body.model,
    stream: !!body.stream,
    instructions: "",
  };

  if (body.max_tokens) codexBody.max_output_tokens = body.max_tokens;
  if (body.temperature !== undefined) codexBody.temperature = body.temperature;
  if (body.top_p !== undefined) codexBody.top_p = body.top_p;

  // thinking → reasoning
  if (body.thinking?.type === "enabled" && body.thinking.budget_tokens) {
    codexBody.reasoning = { effort: budgetToEffort(body.thinking.budget_tokens), summary: "auto" };
  } else if (body.thinking?.type === "disabled") {
    codexBody.reasoning = { effort: "none", summary: "auto" };
  } else {
    codexBody.reasoning = { effort: "medium", summary: "auto" };
  }

  codexBody.include = ["reasoning.encrypted_content"];
  codexBody.store = false;

  // Process tools first to build name shortening map
  const toolNameMap: ToolNameMap = new Map(); // shortened → original
  if (body.tools) {
    codexBody.tools = body.tools.map((t: any) => {
      if (t.type === "web_search_20250305") {
        return { type: "web_search" };
      }
      const originalName = t.name || "";
      const shortened = shortenToolName(originalName, toolNameMap);
      return {
        type: "function",
        name: shortened,
        description: t.description || "",
        parameters: t.input_schema || t.parameters || { type: "object", properties: {} },
      };
    });
  }

  // Build reverse map (original → shortened) for function_call items in input
  const originalToShort = new Map<string, string>();
  for (const [short, original] of toolNameMap.entries()) {
    originalToShort.set(original, short);
  }

  const input: any[] = [];

  // system → developer message with input_text content blocks
  if (body.system) {
    const parts = Array.isArray(body.system) ? body.system : [body.system];
    const content: any[] = [];
    for (const p of parts) {
      const text = typeof p === "string" ? p : p.text || "";
      if (text) content.push({ type: "input_text", text });
    }
    if (content.length) {
      input.push({ type: "message", role: "developer", content });
    }
  }

  // Claude messages → Codex input[]
  for (const msg of body.messages || []) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        input.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: msg.content }],
        });
      } else if (Array.isArray(msg.content)) {
        const msgContent: any[] = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            msgContent.push({ type: "input_text", text: block.text });
          } else if (block.type === "image") {
            if (block.source?.type === "base64") {
              const mt = block.source.media_type || "application/octet-stream";
              msgContent.push({ type: "input_image", image_url: `data:${mt};base64,${block.source.data}` });
            } else if (block.source?.type === "url") {
              msgContent.push({ type: "input_image", image_url: block.source.url });
            }
          } else if (block.type === "tool_result") {
            // Flush pending message content
            if (msgContent.length) {
              input.push({ type: "message", role: "user", content: [...msgContent] });
              msgContent.length = 0;
            }
            // tool_result → function_call_output
            let output: any;
            if (typeof block.content === "string") {
              output = block.content;
            } else if (Array.isArray(block.content)) {
              const parts: any[] = [];
              for (const part of block.content) {
                if (part.type === "text") {
                  parts.push({ type: "input_text", text: part.text });
                } else if (part.type === "image" && part.source?.type === "base64") {
                  const mt = part.source.media_type || "application/octet-stream";
                  parts.push({ type: "input_image", image_url: `data:${mt};base64,${part.source.data}` });
                }
              }
              output = parts.length ? parts : JSON.stringify(block.content);
            } else {
              output = block.content === undefined ? "" : JSON.stringify(block.content);
            }
            input.push({ type: "function_call_output", call_id: block.tool_use_id, output });
          }
        }
        if (msgContent.length) {
          input.push({ type: "message", role: "user", content: msgContent });
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: msg.content }],
        });
      } else if (Array.isArray(msg.content)) {
        const msgContent: any[] = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            msgContent.push({ type: "output_text", text: block.text });
          } else if (block.type === "tool_use") {
            // Flush pending message content
            if (msgContent.length) {
              input.push({ type: "message", role: "assistant", content: [...msgContent] });
              msgContent.length = 0;
            }
            const name = originalToShort.get(block.name || "") || block.name || "";
            input.push({
              type: "function_call",
              call_id: block.id,
              name,
              arguments: typeof block.input === "string"
                ? block.input
                : JSON.stringify(block.input || {}),
              status: "completed",
            });
          }
          // thinking, redacted_thinking → skip
        }
        if (msgContent.length) {
          input.push({ type: "message", role: "assistant", content: msgContent });
        }
      }
    }
  }

  codexBody.input = input;

  // parallel_tool_calls
  let parallelToolCalls = true;
  if (body.tool_choice?.disable_parallel_tool_use) parallelToolCalls = false;
  codexBody.parallel_tool_calls = parallelToolCalls;

  // tool_choice (Claude format → Codex format)
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc.type === "auto") codexBody.tool_choice = "auto";
    else if (tc.type === "any") codexBody.tool_choice = "required";
    else if (tc.type === "none") codexBody.tool_choice = "none";
    else if (tc.type === "tool" && tc.name) {
      const name = originalToShort.get(tc.name) || tc.name;
      codexBody.tool_choice = { type: "function", name };
    }
  }

  return { body: codexBody, toolNameMap };
}

// ── Codex Responses API response → Claude Messages response (non-streaming, direct) ──

export function codexResponseToClaudeDirect(
  respData: any,
  model: string,
  toolNameMap?: ToolNameMap,
): any {
  const output = respData.output || [];
  const content: any[] = [];

  for (const item of output) {
    if (item.type === "message") {
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === "output_text") {
            content.push({ type: "text", text: part.text || "" });
          }
        }
      } else if (typeof item.content === "string") {
        content.push({ type: "text", text: item.content });
      }
    } else if (item.type === "function_call") {
      const rawName = item.name || "";
      const originalName = toolNameMap?.get(rawName) || rawName;
      let input = {};
      try {
        input = typeof item.arguments === "string"
          ? JSON.parse(item.arguments)
          : item.arguments || {};
      } catch { /* ignore */ }
      content.push({
        type: "tool_use",
        id: item.call_id || item.id,
        name: originalName,
        input,
      });
    }
  }

  const hasToolUse = content.some((c: any) => c.type === "tool_use");
  const stopReason = respData.status === "incomplete"
    ? "max_tokens"
    : hasToolUse ? "tool_use" : "end_turn";

  const usage: any = {
    input_tokens: respData.usage?.input_tokens || 0,
    output_tokens: respData.usage?.output_tokens || 0,
  };
  const cached = respData.usage?.input_tokens_details?.cached_tokens;
  if (cached) usage.cache_read_input_tokens = cached;

  return {
    id: respData.id || `msg_${uuidv4()}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

// ── Codex SSE → Claude SSE (streaming, direct) ──

export interface CodexToClaudeStreamState {
  model: string;
  blockIndex: number;
  hasToolCall: boolean;
  hasTextDelta: boolean;
  textBlockOpen: boolean;
  thinkingBlockOpen: boolean;
  thinkingStopPending: boolean;
  thinkingSignature: string;
  hasReceivedArgumentsDelta: boolean;
  toolNameMap: ToolNameMap;
  inputTokens: number;
  outputTokens: number;
}

export function createCodexToClaudeStreamState(
  model: string,
  toolNameMap?: ToolNameMap,
): CodexToClaudeStreamState {
  return {
    model,
    blockIndex: 0,
    hasToolCall: false,
    hasTextDelta: false,
    textBlockOpen: false,
    thinkingBlockOpen: false,
    thinkingStopPending: false,
    thinkingSignature: "",
    hasReceivedArgumentsDelta: false,
    toolNameMap: toolNameMap || new Map(),
    inputTokens: 0,
    outputTokens: 0,
  };
}

function finalizeThinkingBlock(state: CodexToClaudeStreamState): string[] {
  if (!state.thinkingBlockOpen) return [];
  const events: string[] = [];

  if (state.thinkingSignature) {
    events.push(formatSSEEvent("content_block_delta", {
      type: "content_block_delta",
      index: state.blockIndex,
      delta: { type: "signature_delta", signature: state.thinkingSignature },
    }));
  }

  events.push(formatSSEEvent("content_block_stop", {
    type: "content_block_stop",
    index: state.blockIndex,
  }));

  state.blockIndex++;
  state.thinkingBlockOpen = false;
  state.thinkingStopPending = false;
  return events;
}

/**
 * Convert a Codex Responses API SSE event directly to Claude Messages SSE events.
 * No intermediate OpenAI format — direct translation.
 */
export function codexSSEToClaudeEvents(
  eventData: any,
  state: CodexToClaudeStreamState,
): string[] {
  const events: string[] = [];
  const type = eventData.type;

  // Finalize pending thinking block before certain events
  if (state.thinkingBlockOpen && state.thinkingStopPending) {
    if (
      type === "response.content_part.added" ||
      type === "response.completed" ||
      type === "response.output_item.added"
    ) {
      events.push(...finalizeThinkingBlock(state));
    }
  }

  // ── response.created → message_start ──
  if (type === "response.created" || type === "response.in_progress") {
    events.push(formatSSEEvent("message_start", {
      type: "message_start",
      message: {
        id: eventData.response?.id || `msg_${uuidv4()}`,
        type: "message",
        role: "assistant",
        content: [],
        model: state.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }));
    return events;
  }

  // ── Thinking/reasoning summary ──
  if (type === "response.reasoning_summary_part.added") {
    if (state.thinkingBlockOpen && state.thinkingStopPending) {
      events.push(...finalizeThinkingBlock(state));
    }
    events.push(formatSSEEvent("content_block_start", {
      type: "content_block_start",
      index: state.blockIndex,
      content_block: { type: "thinking", thinking: "" },
    }));
    state.thinkingBlockOpen = true;
    state.thinkingStopPending = false;
    return events;
  }

  if (type === "response.reasoning_summary_text.delta") {
    events.push(formatSSEEvent("content_block_delta", {
      type: "content_block_delta",
      index: state.blockIndex,
      delta: { type: "thinking_delta", thinking: eventData.delta || "" },
    }));
    return events;
  }

  if (type === "response.reasoning_summary_part.done") {
    state.thinkingStopPending = true;
    if (state.thinkingSignature) {
      events.push(...finalizeThinkingBlock(state));
    }
    return events;
  }

  // ── Text content part lifecycle ──
  if (type === "response.content_part.added") {
    events.push(formatSSEEvent("content_block_start", {
      type: "content_block_start",
      index: state.blockIndex,
      content_block: { type: "text", text: "" },
    }));
    state.textBlockOpen = true;
    return events;
  }

  if (type === "response.output_text.delta") {
    state.hasTextDelta = true;
    events.push(formatSSEEvent("content_block_delta", {
      type: "content_block_delta",
      index: state.blockIndex,
      delta: { type: "text_delta", text: eventData.delta || "" },
    }));
    return events;
  }

  if (type === "response.content_part.done") {
    events.push(formatSSEEvent("content_block_stop", {
      type: "content_block_stop",
      index: state.blockIndex,
    }));
    state.textBlockOpen = false;
    state.blockIndex++;
    return events;
  }

  // ── Output item added (function_call or reasoning) ──
  if (type === "response.output_item.added") {
    const item = eventData.item;
    if (item?.type === "function_call") {
      events.push(...finalizeThinkingBlock(state));
      state.hasToolCall = true;
      state.hasReceivedArgumentsDelta = false;
      const rawName = item.name || "";
      const originalName = state.toolNameMap.get(rawName) || rawName;
      events.push(formatSSEEvent("content_block_start", {
        type: "content_block_start",
        index: state.blockIndex,
        content_block: {
          type: "tool_use",
          id: item.call_id || item.id,
          name: originalName,
        },
      }));
      // Initialize with empty input_json_delta
      events.push(formatSSEEvent("content_block_delta", {
        type: "content_block_delta",
        index: state.blockIndex,
        delta: { type: "input_json_delta", partial_json: "" },
      }));
    } else if (item?.type === "reasoning") {
      state.thinkingSignature = item.encrypted_content || "";
      if (state.thinkingStopPending) {
        events.push(...finalizeThinkingBlock(state));
      }
    }
    return events;
  }

  // ── Function call arguments ──
  if (type === "response.function_call_arguments.delta") {
    state.hasReceivedArgumentsDelta = true;
    events.push(formatSSEEvent("content_block_delta", {
      type: "content_block_delta",
      index: state.blockIndex,
      delta: { type: "input_json_delta", partial_json: eventData.delta || "" },
    }));
    return events;
  }

  if (type === "response.function_call_arguments.done") {
    if (!state.hasReceivedArgumentsDelta) {
      const args = eventData.arguments || "";
      if (args) {
        events.push(formatSSEEvent("content_block_delta", {
          type: "content_block_delta",
          index: state.blockIndex,
          delta: { type: "input_json_delta", partial_json: args },
        }));
      }
    }
    return events;
  }

  // ── Output item done ──
  if (type === "response.output_item.done") {
    const item = eventData.item;
    if (item?.type === "message") {
      // Fallback: if no text deltas were received, extract from completed item
      if (!state.hasTextDelta && Array.isArray(item.content)) {
        let text = "";
        for (const part of item.content) {
          if (part.type === "output_text" && part.text) text += part.text;
        }
        if (text) {
          events.push(...finalizeThinkingBlock(state));
          if (!state.textBlockOpen) {
            events.push(formatSSEEvent("content_block_start", {
              type: "content_block_start",
              index: state.blockIndex,
              content_block: { type: "text", text: "" },
            }));
            state.textBlockOpen = true;
          }
          events.push(formatSSEEvent("content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: { type: "text_delta", text },
          }));
          events.push(formatSSEEvent("content_block_stop", {
            type: "content_block_stop",
            index: state.blockIndex,
          }));
          state.textBlockOpen = false;
          state.blockIndex++;
          state.hasTextDelta = true;
        }
      }
    } else if (item?.type === "function_call") {
      events.push(formatSSEEvent("content_block_stop", {
        type: "content_block_stop",
        index: state.blockIndex,
      }));
      state.blockIndex++;
    } else if (item?.type === "reasoning") {
      if (item.encrypted_content) {
        state.thinkingSignature = item.encrypted_content;
      }
      events.push(...finalizeThinkingBlock(state));
      state.thinkingSignature = "";
    }
    return events;
  }

  // ── response.completed → message_delta + message_stop ──
  if (type === "response.completed") {
    const resp = eventData.response;
    const usage = resp?.usage;

    if (usage) {
      state.inputTokens = usage.input_tokens || 0;
      state.outputTokens = usage.output_tokens || 0;
    }

    const stopReasonRaw = resp?.stop_reason;
    let stopReason: string;
    if (state.hasToolCall) {
      stopReason = "tool_use";
    } else if (stopReasonRaw === "max_tokens" || resp?.status === "incomplete") {
      stopReason = "max_tokens";
    } else {
      stopReason = "end_turn";
    }

    const usageData: any = { output_tokens: usage?.output_tokens || 0 };
    if (usage?.input_tokens) usageData.input_tokens = usage.input_tokens;
    const cached = usage?.input_tokens_details?.cached_tokens;
    if (cached) usageData.cache_read_input_tokens = cached;

    events.push(formatSSEEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: usageData,
    }));
    events.push(formatSSEEvent("message_stop", { type: "message_stop" }));
    return events;
  }

  return events;
}
