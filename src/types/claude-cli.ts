/**
 * Types for Claude Code CLI JSON streaming output
 * Based on research from PROTOCOL.md
 */

export interface ClaudeCliInit {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  tools: string[];
  mcp_servers: unknown[];
  model: string;
  permissionMode: string;
  slash_commands: unknown[];
  skills: unknown[];
  plugins: unknown[];
  uuid: string;
}

export interface ClaudeCliHookStarted {
  type: "system";
  subtype: "hook_started";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  session_id: string;
}

export interface ClaudeCliHookResponse {
  type: "system";
  subtype: "hook_response";
  hook_id: string;
  output: string;
  exit_code: number;
  outcome: "success" | "error";
}

export interface ClaudeCliTextContent {
  type: "text";
  text: string;
}

export interface ClaudeCliToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ClaudeCliAssistantContent = ClaudeCliTextContent | ClaudeCliToolUseContent;

export interface ClaudeCliAssistant {
  type: "assistant";
  message: {
    model: string;
    id: string;
    type: "message";
    role: "assistant";
    content: ClaudeCliAssistantContent[];
    stop_reason: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  session_id: string;
  uuid: string;
}

export interface ClaudeCliResult {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  session_id: string;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage: Record<string, {
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
  }>;
}

export interface ClaudeCliSystemMessage {
  type: "system";
  subtype: string;
  [key: string]: unknown;
}

export interface ClaudeCliStreamEvent {
  type: "stream_event";
  event: {
    type: "message_start" | "content_block_start" | "content_block_delta" | "content_block_stop" | "message_delta" | "message_stop";
    index?: number;
    delta?: {
      type: "text_delta";
      text: string;
    } | {
      type: "input_json_delta";
      partial_json: string;
    };
    content_block?: {
      type: "text";
      text: string;
    } | {
      type: "tool_use";
      id: string;
      name: string;
    };
    message?: {
      model: string;
      id: string;
      role: "assistant";
      content: ClaudeCliAssistantContent[];
      stop_reason: string | null;
      usage: {
        input_tokens: number;
        output_tokens: number;
      };
    };
  };
  session_id: string;
  uuid: string;
}

export type ClaudeCliMessage =
  | ClaudeCliInit
  | ClaudeCliHookStarted
  | ClaudeCliHookResponse
  | ClaudeCliAssistant
  | ClaudeCliResult
  | ClaudeCliStreamEvent
  | ClaudeCliSystemMessage;

export function isAssistantMessage(msg: ClaudeCliMessage): msg is ClaudeCliAssistant {
  return msg.type === "assistant";
}

export function isResultMessage(msg: ClaudeCliMessage): msg is ClaudeCliResult {
  return msg.type === "result";
}

export function isStreamEvent(msg: ClaudeCliMessage): msg is ClaudeCliStreamEvent {
  return msg.type === "stream_event";
}

export function isContentDelta(msg: ClaudeCliMessage): msg is ClaudeCliStreamEvent {
  return (
    isStreamEvent(msg) &&
    msg.event.type === "content_block_delta" &&
    msg.event.delta?.type === "text_delta"
  );
}

export function isToolUseBlockStart(msg: ClaudeCliMessage): msg is ClaudeCliStreamEvent {
  return (
    isStreamEvent(msg) &&
    msg.event.type === "content_block_start" &&
    msg.event.content_block?.type === "tool_use"
  );
}

export function isInputJsonDelta(msg: ClaudeCliMessage): msg is ClaudeCliStreamEvent {
  return (
    isStreamEvent(msg) &&
    msg.event.type === "content_block_delta" &&
    msg.event.delta?.type === "input_json_delta"
  );
}

export function isContentBlockStop(msg: ClaudeCliMessage): msg is ClaudeCliStreamEvent {
  return isStreamEvent(msg) && msg.event.type === "content_block_stop";
}

export function isTextBlockStart(msg: ClaudeCliMessage): msg is ClaudeCliStreamEvent {
  return (
    isStreamEvent(msg) &&
    msg.event.type === "content_block_start" &&
    msg.event.content_block?.type === "text"
  );
}

export function isSystemInit(msg: ClaudeCliMessage): msg is ClaudeCliInit {
  return msg.type === "system" && (msg as ClaudeCliSystemMessage).subtype === "init";
}
