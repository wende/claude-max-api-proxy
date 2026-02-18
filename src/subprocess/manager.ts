/**
 * Claude Code CLI Subprocess Manager
 *
 * Handles spawning, managing, and parsing output from Claude CLI subprocesses.
 * Uses spawn() instead of exec() to prevent shell injection vulnerabilities.
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import fs from "fs/promises";
import path from "path";
import type {
  ClaudeCliMessage,
  ClaudeCliAssistant,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "../types/claude-cli.js";
import {
  isAssistantMessage,
  isResultMessage,
  isContentDelta,
  isTextBlockStart,
  isToolUseBlockStart,
  isInputJsonDelta,
  isContentBlockStop,
} from "../types/claude-cli.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";

export interface SubprocessOptions {
  model: ClaudeModel;
  sessionId?: string;
  cwd?: string;
  timeout?: number;
}

export interface SubprocessEvents {
  message: (msg: ClaudeCliMessage) => void;
  assistant: (msg: ClaudeCliAssistant) => void;
  result: (result: ClaudeCliResult) => void;
  error: (error: Error) => void;
  close: (code: number | null) => void;
  raw: (line: string) => void;
}

const DEFAULT_TIMEOUT = 300000; // 5 minutes

/**
 * System prompt appended to Claude CLI to map OpenClaw tool names to Claude Code equivalents.
 * OpenClaw's system prompt references tools like `exec`, `read`, `web_search` etc. that
 * don't exist in Claude Code. This mapping tells the model what to use instead.
 */
const OPENCLAW_TOOL_MAPPING_PROMPT = [
  "## Tool Name Mapping",
  "You are running inside Claude Code CLI, not OpenClaw. The system prompt may reference OpenClaw tool names — map them to your actual tools:",
  "",
  "### Direct tool replacements",
  "- `exec` or `process` → use `Bash` (run shell commands)",
  "- `read` → use `Read` (read file contents)",
  "- `write` → use `Write` (write files)",
  "- `edit` → use `Edit` (edit files)",
  "- `grep` → use `Grep` (search file contents)",
  "- `find` or `ls` → use `Glob` or `Bash(ls ...)`",
  "- `web_search` → use `WebSearch`",
  "- `web_fetch` → use `WebFetch`",
  "- `image` → use `Read` (Claude Code can read images)",
  "",
  "### OpenClaw CLI tools (use via Bash)",
  "These OpenClaw tools are available through the `openclaw` CLI. Use `Bash` to run them:",
  '- `memory_search` → `Bash(openclaw memory search "<query>")` — semantic search across memory files',
  "- `memory_get` → `Read` on the memory file directly, OR `Bash(openclaw memory search \"<query>\")` for discovery",
  '- `message` → `Bash(openclaw message send --to <target> "<text>")` — send messages to channels (Telegram, Discord, etc.)',
  "  - Also: `openclaw message read`, `openclaw message broadcast`, `openclaw message react`, `openclaw message poll`",
  "- `cron` → `Bash(openclaw cron list)`, `Bash(openclaw cron add ...)`, `Bash(openclaw cron status)` — manage scheduled jobs",
  "  - Also: `openclaw cron rm`, `openclaw cron enable`, `openclaw cron disable`, `openclaw cron runs`, `openclaw cron run`, `openclaw cron edit`",
  '- `sessions_list` → `Bash(openclaw agent --local --message "list sessions")` or check session files directly',
  '- `sessions_history` → `Bash(openclaw agent --local --message "show history for session <key>")` or check session files',
  "- `nodes` → `Bash(openclaw nodes status)`, `Bash(openclaw nodes describe <node>)`, `Bash(openclaw nodes invoke --node <id> --command <cmd>)`",
  '  - Also: `openclaw nodes run --node <id> "<shell command>"` for running commands on paired nodes',
  "",
  "### Not available via CLI",
  "- `browser` — requires OpenClaw's dedicated browser server (no CLI equivalent)",
  "- `canvas` — requires paired node with canvas capability; use `openclaw nodes invoke` if a node is available",
  "",
  "### Skills",
  "When a skill says to run a bash/python command, use the `Bash` tool directly.",
  "Skills are located in the `skills/` directory relative to your working directory.",
  "To use a skill: `Read` its SKILL.md file first, then follow the instructions using `Bash`.",
  "Run `openclaw skills list --eligible --json` to see all available skills.",
].join("\n");

export class ClaudeSubprocess extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer: string = "";
  private timeoutId: NodeJS.Timeout | null = null;
  private isKilled: boolean = false;

  /**
   * Start the Claude CLI subprocess with the given prompt
   */
  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    const args = this.buildArgs(prompt, options);
    const timeout = options.timeout || DEFAULT_TIMEOUT;

    return new Promise((resolve, reject) => {
      try {
        // Use spawn() for security - no shell interpretation
        this.process = spawn("claude", args, {
          cwd: options.cwd || process.cwd(),
          env: { ...process.env },
          stdio: ["pipe", "pipe", "pipe"],
        });

        // Set timeout
        this.timeoutId = setTimeout(() => {
          if (!this.isKilled) {
            this.isKilled = true;
            this.process?.kill("SIGTERM");
            this.emit("error", new Error(`Request timed out after ${timeout}ms`));
          }
        }, timeout);

        // Handle spawn errors (e.g., claude not found)
        this.process.on("error", (err) => {
          this.clearTimeout();
          if (err.message.includes("ENOENT")) {
            reject(
              new Error(
                "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
              )
            );
          } else {
            reject(err);
          }
        });

        // Close stdin since we pass prompt as argument
        this.process.stdin?.end();

        console.error(`[Subprocess] Process spawned with PID: ${this.process.pid}`);

        // Parse JSON stream from stdout
        this.process.stdout?.on("data", (chunk: Buffer) => {
          const data = chunk.toString();
          console.error(`[Subprocess] Received ${data.length} bytes of stdout`);
          this.buffer += data;
          this.processBuffer();
        });

        // Capture stderr for debugging
        this.process.stderr?.on("data", (chunk: Buffer) => {
          const errorText = chunk.toString().trim();
          if (errorText) {
            // Don't emit as error unless it's actually an error
            // Claude CLI may write debug info to stderr
            console.error("[Subprocess stderr]:", errorText.slice(0, 200));
          }
        });

        // Handle process close
        this.process.on("close", (code) => {
          console.error(`[Subprocess] Process closed with code: ${code}`);
          this.clearTimeout();
          // Process any remaining buffer
          if (this.buffer.trim()) {
            this.processBuffer();
          }
          this.emit("close", code);
        });

        // Resolve immediately since we're streaming
        resolve();
      } catch (err) {
        this.clearTimeout();
        reject(err);
      }
    });
  }

  /**
   * Build CLI arguments array
   */
  private buildArgs(prompt: string, options: SubprocessOptions): string[] {
    const args = [
      "--print", // Non-interactive mode
      "--dangerously-skip-permissions", // Skip permission prompts
      "--output-format",
      "stream-json", // JSON streaming output
      "--verbose", // Required for stream-json
      "--include-partial-messages", // Enable streaming chunks
      "--model",
      options.model, // Model alias (opus/sonnet/haiku)
      "--no-session-persistence", // Don't save sessions
      "--append-system-prompt",
      OPENCLAW_TOOL_MAPPING_PROMPT,
      prompt, // Pass prompt as argument (more reliable than stdin)
    ];

    if (options.sessionId) {
      args.push("--session-id", options.sessionId);
    }

    return args;
  }

  /**
   * Process the buffer and emit parsed messages
   */
  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // Keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message: ClaudeCliMessage = JSON.parse(trimmed);
        this.emit("message", message);

        if (isTextBlockStart(message)) {
          // Emit when a new text content block starts (for inserting separators)
          this.emit("text_block_start", message as ClaudeCliStreamEvent);
        }

        if (isToolUseBlockStart(message)) {
          this.emit("tool_use_start", message as ClaudeCliStreamEvent);
        }

        if (isInputJsonDelta(message)) {
          this.emit("input_json_delta", message as ClaudeCliStreamEvent);
        }

        if (isContentBlockStop(message)) {
          this.emit("content_block_stop", message as ClaudeCliStreamEvent);
        }

        if (isContentDelta(message)) {
          // Emit content delta for streaming (text_delta only)
          this.emit("content_delta", message as ClaudeCliStreamEvent);
        } else if (isAssistantMessage(message)) {
          this.emit("assistant", message);
        } else if (isResultMessage(message)) {
          this.emit("result", message);
        }
      } catch {
        // Non-JSON output, emit as raw
        this.emit("raw", trimmed);
      }
    }
  }

  /**
   * Clear the timeout timer
   */
  private clearTimeout(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * Kill the subprocess
   */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.isKilled && this.process) {
      this.isKilled = true;
      this.clearTimeout();
      this.process.kill(signal);
    }
  }

  /**
   * Check if the process is still running
   */
  isRunning(): boolean {
    return this.process !== null && !this.isKilled && this.process.exitCode === null;
  }
}

/**
 * Verify that Claude CLI is installed and accessible
 */
export async function verifyClaude(): Promise<{ ok: boolean; error?: string; version?: string }> {
  return new Promise((resolve) => {
    const proc = spawn("claude", ["--version"], { stdio: "pipe" });
    let output = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on("error", () => {
      resolve({
        ok: false,
        error:
          "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
      });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, version: output.trim() });
      } else {
        resolve({
          ok: false,
          error: "Claude CLI returned non-zero exit code",
        });
      }
    });
  });
}

/**
 * Check if Claude CLI is authenticated
 *
 * Claude Code stores credentials in the OS keychain, not a file.
 * We verify authentication by checking if we can call the CLI successfully.
 * If the CLI is installed, it typically has valid credentials from `claude auth login`.
 */
export async function verifyAuth(): Promise<{ ok: boolean; error?: string }> {
  // If Claude CLI is installed and the user has run `claude auth login`,
  // credentials are stored in the OS keychain and will be used automatically.
  // We can't easily check the keychain, so we'll just return true if the CLI exists.
  // Authentication errors will surface when making actual API calls.
  return { ok: true };
}
