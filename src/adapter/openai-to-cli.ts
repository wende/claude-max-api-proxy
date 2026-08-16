/**
 * Converts OpenAI chat request format to Claude CLI input
 */

import type { OpenAIChatRequest, OpenAIContentBlock, OpenAIToolDefinition } from "../types/openai.js";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type ClaudeModel = "opus" | "sonnet" | "haiku";

export interface CliImage {
  /** MIME type, e.g. image/png */
  mimeType: string;
  /** Raw base64 payload (without data URL prefix) */
  data: string;
  /** Original remote URL if the client sent one (no base64 copy kept) */
  sourceUrl?: string;
}

export interface CliInput {
  prompt: string;
  model: ClaudeModel;
  sessionId?: string;
  effort?: ClaudeEffort;
  /** Images extracted from image_url content blocks, to be materialized as temp files */
  images?: CliImage[];
  /** Client-side tool definitions from the OpenAI request */
  tools?: OpenAIToolDefinition[];
  /** True when the client sent tools - the CLI's built-in tools must be disabled then */
  hasClientTools?: boolean;
}

const EFFORT_LEVELS: ClaudeEffort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Normalize effort from an OpenAI-compatible request (reasoning_effort or effort).
 * Unknown values are ignored so the CLI default applies.
 */
export function extractEffort(request: OpenAIChatRequest): ClaudeEffort | undefined {
  const raw = (request.reasoning_effort || request.effort || "").toLowerCase().trim();
  return (EFFORT_LEVELS as string[]).includes(raw) ? (raw as ClaudeEffort) : undefined;
}

const MODEL_MAP: Record<string, ClaudeModel> = {
  // Direct model names (provider prefixes like `claude-code-cli/` and `claude-max/`
  // are stripped by extractModel before consulting this map)
  "claude-opus-4": "opus",
  "claude-opus-4-6": "opus",
  "claude-sonnet-4": "sonnet",
  "claude-sonnet-4-5": "sonnet",
  "claude-sonnet-4-6": "sonnet",
  "claude-sonnet-5": "sonnet",
  "claude-opus-5": "opus",
  "claude-haiku-4": "haiku",
  "claude-haiku-4-5": "haiku",
  // Bare aliases
  "opus": "opus",
  "sonnet": "sonnet",
  "haiku": "haiku",
  "opus-max": "opus",
  "sonnet-max": "sonnet",
};

/**
 * Extract Claude model alias from request model string
 */
export function extractModel(model: string): ClaudeModel {
  // Try direct lookup
  if (MODEL_MAP[model]) {
    return MODEL_MAP[model];
  }

  // Try stripping provider prefix
  const stripped = model.replace(/^(?:claude-code-cli|claude-max)\//, "");
  if (MODEL_MAP[stripped]) {
    return MODEL_MAP[stripped];
  }

  // Default to opus (Claude Max subscription)
  return "opus";
}

/**
 * Extract text from a content field that may be a string or array of content blocks.
 * OpenAI API allows content as either:
 *   - A plain string: "Hello"
 *   - An array of content blocks: [{"type": "text", "text": "Hello"}]
 */
function extractText(content: string | OpenAIContentBlock[] | null): string {
  if (content === null || content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text" || block.type === "input_text")
      .map((block) => (block as { text: string }).text)
      .join("\n");
  }
  return String(content || "");
}

/**
 * Extract images from OpenAI image_url content blocks.
 * Data URLs (what OpenWebUI sends for uploads) are decoded to base64 payloads;
 * remote http(s) URLs are passed through as sourceUrl for later download.
 */
export function extractImages(messages: OpenAIChatRequest["messages"]): CliImage[] {
  const images: CliImage[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== "image_url" || !block.image_url?.url) continue;
      const url = block.image_url.url;
      const dataUrl = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (dataUrl) {
        images.push({ mimeType: dataUrl[1], data: dataUrl[2] });
      } else if (/^https?:\/\//.test(url)) {
        images.push({ mimeType: "", data: "", sourceUrl: url });
      }
    }
  }
  return images;
}

/**
 * Strip OpenClaw-specific tooling sections from system prompts.
 * These reference tools (exec, process, web_search, etc.) that don't exist
 * in the Claude Code CLI environment, causing the model to get confused.
 * We remove: ## Tooling, ## Tool Call Style, ## OpenClaw CLI Quick Reference,
 * ## OpenClaw Self-Update
 */
function stripOpenClawTooling(text: string): string {
  const sectionsToStrip = [
    "## Tooling",
    "## Tool Call Style",
    "## OpenClaw CLI Quick Reference",
    "## OpenClaw Self-Update",
  ];
  let result = text;
  for (const section of sectionsToStrip) {
    // Match from section header to the next ## header (or end of string)
    const pattern = new RegExp(
      section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        "\\n[\\s\\S]*?(?=\\n## |$)",
      "g"
    );
    result = result.replace(pattern, "");
  }
  // Clean up excessive blank lines left behind
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * We format the messages into a readable format that preserves context.
 */
export function messagesToPrompt(
  messages: OpenAIChatRequest["messages"]
): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const text = extractText(msg.content);
    switch (msg.role) {
      case "system":
        // System messages become context instructions
        // Strip OpenClaw tooling sections that conflict with Claude Code's native tools
        parts.push(`<system>\n${stripOpenClawTooling(text)}\n</system>\n`);
        break;

      case "user":
        // User messages are the main prompt
        parts.push(text);
        break;

      case "assistant":
        // Previous assistant responses for context
        parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
        break;

      case "tool":
        // Client-executed tool results (OpenWebUI sends role="tool")
        parts.push(`<tool_result>\n${text}\n</tool_result>\n`);
        break;
    }
  }

  return parts.join("\n").trim();
}

/**
 * Render client tool definitions as a system-level instruction block.
 * Claude Code has no native mechanism for client-executed tools in --print
 * mode, so we describe them and require a <tool_call> JSON envelope - the
 * response adapter parses it back into OpenAI tool_calls.
 */
export function toolsToPromptBlock(tools: OpenAIToolDefinition[]): string {
  const defs = tools
    .map((t) => {
      const params = t.function.parameters
        ? JSON.stringify(t.function.parameters)
        : "{}";
      return `- ${t.function.name}: ${t.function.description || "(no description)"}\n  parameters: ${params}`;
    })
    .join("\n");

  return [
    "<available_tools>",
    "The client provides the following tools. You CANNOT execute them yourself -",
    "the client runs them and sends the result back as a tool message.",
    "To request a tool call, respond with ONLY a JSON block in this exact format:",
    '<tool_call>{"name": "<tool_name>", "arguments": {...}}</tool_call>',
    "No other text before or after. One tool call per response.",
    "If no tool is needed, answer normally.",
    "",
    defs,
    "</available_tools>",
  ].join("\n");
}

/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request: OpenAIChatRequest): CliInput {
  const images = extractImages(request.messages);
  const tools = request.tools;
  let prompt = messagesToPrompt(request.messages);
  if (tools && tools.length > 0) {
    prompt = toolsToPromptBlock(tools) + "\n\n" + prompt;
  }
  return {
    prompt,
    model: extractModel(request.model),
    sessionId: request.user, // Use OpenAI's user field for session mapping
    effort: extractEffort(request),
    ...(images.length > 0 ? { images } : {}),
    ...(tools && tools.length > 0 ? { tools, hasClientTools: true } : {}),
  };
}

/**
 * Build CLI input for a request that will --resume an existing Claude CLI
 * session. Since the CLI already remembers everything up to `sinceIndex`
 * (it generated the assistant turns itself), we only need to forward the
 * messages appended since then — not the full history again.
 */
export function openaiToCliDelta(
  request: OpenAIChatRequest,
  sinceIndex: number
): CliInput {
  const newMessages = request.messages
    .slice(sinceIndex)
    .filter((m) => m.role !== "assistant");

  const source = newMessages.length ? newMessages : request.messages;
  const images = extractImages(source);
  const tools = request.tools;
  // Fallback to full history if nothing new was found (shouldn't happen,
  // but never send an empty prompt to the CLI)
  let prompt = messagesToPrompt(source);
  if (tools && tools.length > 0) {
    prompt = toolsToPromptBlock(tools) + "\n\n" + prompt;
  }
  return {
    prompt,
    model: extractModel(request.model),
    sessionId: request.user,
    effort: extractEffort(request),
    ...(images.length > 0 ? { images } : {}),
    ...(tools && tools.length > 0 ? { tools, hasClientTools: true } : {}),
  };
}
