import { v4 as uuidv4 } from "uuid";

// ── OpenAI Chat Completions request → Codex Responses API request ──

export function chatCompletionsToCodexRequest(body: any): any {
  const codexBody: any = {
    model: body.model,
    stream: !!body.stream,
  };

  if (body.max_tokens) codexBody.max_output_tokens = body.max_tokens;
  if (body.temperature !== undefined) codexBody.temperature = body.temperature;
  if (body.top_p !== undefined) codexBody.top_p = body.top_p;

  // reasoning_effort → reasoning
  if (body.reasoning_effort) {
    codexBody.reasoning = { effort: body.reasoning_effort };
  }

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

  if (instructions) codexBody.instructions = instructions;
  codexBody.input = input;

  // Tools
  if (body.tools) {
    codexBody.tools = body.tools.map((t: any) => {
      if (t.type === "function" && t.function) {
        return {
          type: "function",
          name: t.function.name,
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

  return codexBody;
}

// ── Codex Responses API response → OpenAI Chat Completions response ──

export function codexResponseToOpenAI(respData: any, model: string): any {
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
      toolCalls.push({
        id: item.call_id || item.id,
        type: "function",
        function: {
          name: item.name,
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
}

export function createCodexStreamState(model: string): CodexStreamState {
  return {
    chatId: `chatcmpl-${uuidv4()}`,
    model,
    inputTokens: 0,
    outputTokens: 0,
    started: false,
    hasToolCalls: false,
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

  if (type === "response.output_item.added") {
    const item = eventData.item;
    if (item?.type === "function_call") {
      state.hasToolCalls = true;
      chunks.push(
        makeOpenAIChunk(
          state,
          {
            tool_calls: [
              {
                index: eventData.output_index || 0,
                id: item.call_id || item.id,
                type: "function",
                function: { name: item.name || "", arguments: "" },
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
