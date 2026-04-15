import { v4 as uuidv4 } from "uuid";
import { EFFORT_TO_BUDGET, formatSSEEvent } from "./shared";

// ── Model alias resolution ──

const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
};

export function resolveModel(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

// ── Reasoning effort → Claude thinking config ──

function applyThinking(claudeBody: any, reasoningEffort: string): void {
  if (reasoningEffort === "none") {
    claudeBody.thinking = { type: "disabled" };
    return;
  }
  const budget = EFFORT_TO_BUDGET[reasoningEffort];
  if (budget) {
    claudeBody.thinking = { type: "enabled", budget_tokens: budget };
    // budget must be < max_tokens
    if (claudeBody.max_tokens <= budget) {
      claudeBody.max_tokens = budget + 4096;
    }
  } else {
    // "auto" or unknown → adaptive
    claudeBody.thinking = { type: "enabled", budget_tokens: 8192 };
  }
}

function disableThinkingIfToolChoiceForced(claudeBody: any): void {
  const tcType = claudeBody.tool_choice?.type;
  if (tcType === "any" || tcType === "tool") {
    delete claudeBody.thinking;
  }
}

// ── OpenAI image_url → Claude image ──

function convertContentParts(parts: any[]): any[] {
  return parts.map((part: any) => {
    if (part.type === "image_url" && part.image_url?.url) {
      const url: string = part.image_url.url;
      if (url.startsWith("data:")) {
        // data:image/png;base64,iVBOR...
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          return {
            type: "image",
            source: { type: "base64", media_type: match[1], data: match[2] },
          };
        }
      }
      // Remote URL
      return { type: "image", source: { type: "url", url } };
    }
    return part;
  });
}

// ── OpenAI tool_choice → Claude tool_choice ──

function convertToolChoice(tc: any): any {
  if (tc === "auto") return { type: "auto" };
  if (tc === "required") return { type: "any" };
  if (tc === "none") return { type: "none" };
  if (tc?.type === "function" && tc.function?.name) {
    return { type: "tool", name: tc.function.name };
  }
  return tc;
}

// ── OpenAI tools → Claude tools ──

function convertTools(tools: any[]): any[] {
  return tools.map((t: any) => {
    if (t.type === "function" && t.function) {
      return {
        name: t.function.name,
        description: t.function.description || "",
        input_schema: t.function.parameters || {
          type: "object",
          properties: {},
        },
      };
    }
    return t;
  });
}

// ── OpenAI chat completion request → Claude messages request ──

export function openaiToClaude(body: any): any {
  const claudeBody: any = {
    model: resolveModel(body.model || "claude-sonnet-4-6"),
    max_tokens: body.max_tokens || 8192,
    stream: !!body.stream,
  };

  if (body.temperature !== undefined) claudeBody.temperature = body.temperature;
  if (body.top_p !== undefined) claudeBody.top_p = body.top_p;
  if (body.stop)
    claudeBody.stop_sequences = Array.isArray(body.stop)
      ? body.stop
      : [body.stop];

  // Thinking / reasoning
  if (body.reasoning_effort) {
    applyThinking(claudeBody, body.reasoning_effort);
  }

  const messages: any[] = [];
  const systemParts: any[] = [];

  for (const msg of body.messages || []) {
    if (msg.role === "system") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content?.map((c: any) => c.text).join("\n");
      systemParts.push({ type: "text", text });
    } else if (msg.role === "tool") {
      // OpenAI tool result → Claude tool_result
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content:
              typeof msg.content === "string"
                ? msg.content
                : JSON.stringify(msg.content),
          },
        ],
      });
    } else if (msg.role === "assistant" && msg.tool_calls) {
      // Assistant message with tool_calls → Claude assistant with tool_use blocks
      const content: any[] = [];
      if (msg.content) {
        content.push({
          type: "text",
          text: typeof msg.content === "string" ? msg.content : "",
        });
      }
      for (const tc of msg.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function?.name || "",
          input: tc.function?.arguments
            ? JSON.parse(tc.function.arguments)
            : {},
        });
      }
      messages.push({ role: "assistant", content });
    } else {
      // Convert image parts if content is array
      let content = msg.content;
      if (Array.isArray(content)) {
        content = convertContentParts(content);
      }
      messages.push({
        role: msg.role === "user" ? "user" : "assistant",
        content,
      });
    }
  }

  if (systemParts.length) claudeBody.system = systemParts;
  claudeBody.messages = messages;

  // Tools
  if (body.tools) claudeBody.tools = convertTools(body.tools);
  if (body.tool_choice)
    claudeBody.tool_choice = convertToolChoice(body.tool_choice);

  // Disable thinking when tool_choice forces tool use
  if (claudeBody.thinking && claudeBody.tool_choice) {
    disableThinkingIfToolChoiceForced(claudeBody);
  }

  return claudeBody;
}

// ── Claude response → OpenAI chat completion response (non-streaming) ──

function mapStopReason(reason: string): string {
  if (reason === "end_turn") return "stop";
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_calls";
  return "stop";
}

export function claudeToOpenai(claudeResp: any, model: string): any {
  let textContent = "";
  const toolCalls: any[] = [];
  let reasoning = "";

  if (Array.isArray(claudeResp.content)) {
    for (const block of claudeResp.content) {
      if (block.type === "text") {
        textContent += block.text;
      } else if (block.type === "thinking" && block.thinking) {
        reasoning += (reasoning ? "\n\n" : "") + block.thinking;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        });
      }
    }
  }

  const message: any = { role: "assistant", content: textContent || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapStopReason(claudeResp.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: claudeResp.usage?.input_tokens || 0,
      completion_tokens: claudeResp.usage?.output_tokens || 0,
      total_tokens:
        (claudeResp.usage?.input_tokens || 0) +
        (claudeResp.usage?.output_tokens || 0),
    },
  };
}

// ── Claude messages request → OpenAI chat completion request (reverse of openaiToClaude) ──

function budgetToEffort(budget: number): string {
  if (budget <= 0) return "none";
  if (budget <= 1024) return "low";
  if (budget <= 8192) return "medium";
  if (budget <= 24576) return "high";
  return "xhigh";
}

function reverseToolChoice(tc: any): any {
  if (!tc) return undefined;
  if (tc.type === "auto") return "auto";
  if (tc.type === "any") return "required";
  if (tc.type === "none") return "none";
  if (tc.type === "tool" && tc.name) {
    return { type: "function", function: { name: tc.name } };
  }
  return tc;
}

export function claudeRequestToOpenai(body: any): any {
  const openaiBody: any = {
    model: body.model,
    max_tokens: body.max_tokens || 8192,
    stream: !!body.stream,
  };

  if (body.temperature !== undefined) openaiBody.temperature = body.temperature;
  if (body.top_p !== undefined) openaiBody.top_p = body.top_p;
  if (body.stop_sequences) {
    openaiBody.stop = body.stop_sequences;
  }

  // thinking → reasoning_effort
  if (body.thinking?.type === "enabled" && body.thinking.budget_tokens) {
    openaiBody.reasoning_effort = budgetToEffort(body.thinking.budget_tokens);
  }

  const messages: any[] = [];

  // system → system message
  if (body.system) {
    const parts = Array.isArray(body.system) ? body.system : [body.system];
    const text = parts
      .map((p: any) => (typeof p === "string" ? p : p.text || ""))
      .join("\n");
    if (text) messages.push({ role: "system", content: text });
  }

  // Claude messages → OpenAI messages
  for (const msg of body.messages || []) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const parts: any[] = [];
        const toolResults: any[] = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            parts.push({ type: "text", text: block.text });
          } else if (block.type === "image") {
            if (block.source?.type === "base64") {
              parts.push({
                type: "image_url",
                image_url: {
                  url: `data:${block.source.media_type};base64,${block.source.data}`,
                },
              });
            } else if (block.source?.type === "url") {
              parts.push({
                type: "image_url",
                image_url: { url: block.source.url },
              });
            }
          } else if (block.type === "tool_result") {
            toolResults.push({
              role: "tool",
              tool_call_id: block.tool_use_id,
              content:
                typeof block.content === "string"
                  ? block.content
                  : JSON.stringify(block.content),
            });
          }
        }
        if (parts.length) {
          messages.push({
            role: "user",
            content:
              parts.length === 1 && parts[0].type === "text"
                ? parts[0].text
                : parts,
          });
        }
        messages.push(...toolResults);
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        messages.push({ role: "assistant", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        const toolCalls: any[] = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            textParts.push(block.text);
          } else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input || {}),
              },
            });
          }
          // thinking / redacted_thinking — skip
        }
        const assistantMsg: any = {
          role: "assistant",
          content: textParts.join("") || null,
        };
        if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
        messages.push(assistantMsg);
      }
    }
  }

  openaiBody.messages = messages;

  // tools: input_schema → parameters
  if (body.tools) {
    openaiBody.tools = body.tools.map((t: any) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || t.parameters || {
          type: "object",
          properties: {},
        },
      },
    }));
  }

  // tool_choice: Claude → OpenAI
  if (body.tool_choice) {
    const converted = reverseToolChoice(body.tool_choice);
    if (converted !== undefined) openaiBody.tool_choice = converted;
  }

  return openaiBody;
}

// ── OpenAI chat completion response → Claude messages response (reverse of claudeToOpenai) ──

function mapFinishReason(reason: string): string {
  if (reason === "stop") return "end_turn";
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls") return "tool_use";
  return "end_turn";
}

export function openaiResponseToClaude(resp: any, model: string): any {
  const choice = resp.choices?.[0];
  const msg = choice?.message;
  const content: any[] = [];

  if (msg?.content) {
    content.push({ type: "text", text: msg.content });
  }

  if (msg?.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function?.arguments || "{}");
      } catch { /* ignore */ }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function?.name || "",
        input,
      });
    }
  }

  return {
    id: resp.id || `msg_${uuidv4()}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: mapFinishReason(choice?.finish_reason || "stop"),
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens || 0,
      output_tokens: resp.usage?.completion_tokens || 0,
    },
  };
}

// ── OpenAI SSE chunk → Claude SSE events (reverse of claudeStreamEventToOpenai) ──

export interface ReverseStreamState {
  msgId: string;
  model: string;
  started: boolean;
  blockIndex: number;
  textBlockOpen: boolean;
  toolBlockOpen: boolean;
  currentToolId: string;
  currentToolName: string;
  inputTokens: number;
  outputTokens: number;
}

export function createReverseStreamState(model: string): ReverseStreamState {
  return {
    msgId: `msg_${uuidv4()}`,
    model,
    started: false,
    blockIndex: 0,
    textBlockOpen: false,
    toolBlockOpen: false,
    currentToolId: "",
    currentToolName: "",
    inputTokens: 0,
    outputTokens: 0,
  };
}

function closeContentBlock(
  events: string[],
  state: ReverseStreamState,
  kind: "text" | "tool",
  advance: boolean,
): void {
  events.push(
    formatSSEEvent("content_block_stop", {
      type: "content_block_stop",
      index: state.blockIndex,
    }),
  );
  if (advance) state.blockIndex++;
  if (kind === "text") state.textBlockOpen = false;
  else state.toolBlockOpen = false;
}

export function openaiStreamChunkToClaudeEvents(
  chunk: any,
  state: ReverseStreamState,
): string[] {
  const events: string[] = [];
  const choice = chunk.choices?.[0];
  if (!choice) return events;

  const delta = choice.delta;
  const finishReason = choice.finish_reason;

  // First chunk: emit message_start
  if (!state.started && delta) {
    state.started = true;
    events.push(
      formatSSEEvent("message_start", {
        type: "message_start",
        message: {
          id: state.msgId,
          type: "message",
          role: "assistant",
          content: [],
          model: state.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: chunk.usage?.prompt_tokens || 0, output_tokens: 0 },
        },
      }),
    );
    state.inputTokens = chunk.usage?.prompt_tokens || 0;
  }

  // Text content delta
  if (delta?.content) {
    if (!state.textBlockOpen) {
      if (state.toolBlockOpen) closeContentBlock(events, state, "tool", true);
      events.push(
        formatSSEEvent("content_block_start", {
          type: "content_block_start",
          index: state.blockIndex,
          content_block: { type: "text", text: "" },
        }),
      );
      state.textBlockOpen = true;
    }
    events.push(
      formatSSEEvent("content_block_delta", {
        type: "content_block_delta",
        index: state.blockIndex,
        delta: { type: "text_delta", text: delta.content },
      }),
    );
  }

  // Tool calls delta
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      // New tool call (has id and name)
      if (tc.id && tc.function?.name) {
        if (state.textBlockOpen) closeContentBlock(events, state, "text", true);
        if (state.toolBlockOpen) closeContentBlock(events, state, "tool", true);
        state.currentToolId = tc.id;
        state.currentToolName = tc.function.name;
        events.push(
          formatSSEEvent("content_block_start", {
            type: "content_block_start",
            index: state.blockIndex,
            content_block: {
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
            },
          }),
        );
        state.toolBlockOpen = true;
      }

      // Tool arguments delta
      if (tc.function?.arguments) {
        events.push(
          formatSSEEvent("content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: tc.function.arguments,
            },
          }),
        );
      }
    }
  }

  // Finish reason: close blocks, emit message_delta + message_stop
  if (finishReason) {
    if (state.textBlockOpen) closeContentBlock(events, state, "text", false);
    if (state.toolBlockOpen) closeContentBlock(events, state, "tool", false);

    state.outputTokens = chunk.usage?.completion_tokens || 0;
    events.push(
      formatSSEEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: mapFinishReason(finishReason) },
        usage: { output_tokens: state.outputTokens },
      }),
    );
    events.push(
      formatSSEEvent("message_stop", { type: "message_stop" }),
    );
  }

  return events;
}

// ── Streaming state tracker ──

export interface StreamState {
  chatId: string;
  model: string;
  toolCalls: Map<number, { id: string; name: string; args: string }>;
  nextToolIndex: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export function createStreamState(model: string): StreamState {
  return {
    chatId: `chatcmpl-${uuidv4()}`,
    model,
    toolCalls: new Map(),
    nextToolIndex: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

function makeChunk(
  state: StreamState,
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

// ── Claude SSE event → OpenAI SSE chunk(s) ──

export function claudeStreamEventToOpenai(
  event: string,
  data: any,
  state: StreamState,
): string[] {
  const chunks: string[] = [];

  if (event === "message_start") {
    const usage = data.message?.usage;
    state.inputTokens = usage?.input_tokens || 0;
    state.cacheCreationInputTokens = usage?.cache_creation_input_tokens || 0;
    state.cacheReadInputTokens = usage?.cache_read_input_tokens || 0;
    chunks.push(makeChunk(state, { role: "assistant", content: "" }, null));
    return chunks;
  }

  if (event === "content_block_start") {
    const block = data.content_block;
    if (block?.type === "tool_use") {
      const idx = state.nextToolIndex++;
      state.toolCalls.set(data.index, {
        id: block.id,
        name: block.name,
        args: "",
      });
      chunks.push(
        makeChunk(
          state,
          {
            tool_calls: [
              {
                index: idx,
                id: block.id,
                type: "function",
                function: { name: block.name, arguments: "" },
              },
            ],
          },
          null,
        ),
      );
    }
    // thinking / redacted_thinking block start — no output needed
    return chunks;
  }

  if (event === "content_block_delta") {
    const deltaType = data.delta?.type;

    if (deltaType === "text_delta") {
      chunks.push(makeChunk(state, { content: data.delta.text }, null));
    } else if (deltaType === "thinking_delta") {
      // Emit as reasoning_content for clients that support it
      chunks.push(
        makeChunk(state, { reasoning_content: data.delta.thinking }, null),
      );
    } else if (deltaType === "redacted_thinking_delta") {
      // Redacted (encrypted) thinking blocks — discard, never forward to clients
    } else if (deltaType === "input_json_delta") {
      const tc = state.toolCalls.get(data.index);
      if (tc) {
        tc.args += data.delta.partial_json;
        // Find the OpenAI tool index
        let tcIdx = 0;
        for (const [blockIdx] of state.toolCalls) {
          if (blockIdx === data.index) break;
          tcIdx++;
        }
        chunks.push(
          makeChunk(
            state,
            {
              tool_calls: [
                {
                  index: tcIdx,
                  function: { arguments: data.delta.partial_json },
                },
              ],
            },
            null,
          ),
        );
      }
    }
    return chunks;
  }

  if (event === "content_block_stop") {
    // No explicit output needed
    return chunks;
  }

  if (event === "message_delta") {
    state.outputTokens = data.usage?.output_tokens || 0;
    const finishReason = mapStopReason(data.delta?.stop_reason || "end_turn");
    const usage = data.usage
      ? {
          prompt_tokens: data.usage.input_tokens || 0,
          completion_tokens: data.usage.output_tokens || 0,
          total_tokens:
            (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
        }
      : undefined;
    chunks.push(makeChunk(state, {}, finishReason, usage));
    return chunks;
  }

  if (event === "message_stop") {
    chunks.push("[DONE]");
    return chunks;
  }

  return chunks;
}
