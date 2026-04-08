/**
 * Session Pool Router
 *
 * Maintains per-model warm pools of persistent Claude CLI processes and locks
 * them to OpenClaw session keys.  Each session key gets a dedicated process —
 * no cross-session contamination, no concurrent stdin writes.
 *
 * See specs/session-pooling.spec.md (Rev 5) for the full design.
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";

/**
 * Factory that creates an EventEmitter with a permanent no-op error listener
 * so it never reaches a zero-listener state.  Prevents Node's default throw
 * behavior when callers detach their listeners before an async error fires.
 * The permanent listener is attached at creation time — no complex tracking needed.
 */
function safeEmitter(): EventEmitter {
  const emitter = new EventEmitter();
  // Permanent no-op guard: emitter always has ≥1 error listener, so Node never
  // throws on emit("error", ...) regardless of what callers attach or detach.
  emitter.on("error", (err: Error) => {
    console.error("[Router] Suppressed emitter error:", err?.message ?? err);
  });
  return emitter;
}

import type {
  ClaudeCliMessage,
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
  isSystemInit,
} from "../types/claude-cli.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";

// ---------------------------------------------------------------------------
// Tool mapping prompt (shared with manager.ts / pool.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Models that have dedicated warm pools. */
export const POOLED_MODELS = new Set<string>(["opus", "sonnet"]);

export type PooledModel = "opus" | "sonnet";

export interface PooledProcess {
  id: number;
  process: ChildProcess;
  model: PooledModel;
  lockedTo: string | null;
  agentChannel: string | null;
  lastRequestAt: number;
  spawnedAt: number;
  requestCount: number;
  state: "idle" | "busy" | "recycling";
  requestQueue: PendingRequest[];
  buffer: string;
  currentEmitter: EventEmitter | null;
  ready: boolean;
  requestTimeoutTimer: NodeJS.Timeout | null;
  orphaned: boolean;
}

export interface PendingRequest {
  prompt: string;
  emitter: EventEmitter;
  resolve: () => void;
}

export interface PendingSentinel {
  isPending: true;
  requestQueue: PendingRequest[];
}

function isPendingSentinel(
  v: PooledProcess | PendingSentinel
): v is PendingSentinel {
  return (v as PendingSentinel).isPending === true;
}

export interface PoolRouterConfig {
  opusSize: number;
  sonnetSize: number;
  maxRequestsPerProcess: number;
  maxTotalProcesses: number;
  requestQueueDepth: number;
  requestTimeoutMs: number;
  sweepIdleThresholdMs: number;
}

export interface PoolStats {
  total: number;
  locked: { total: number; opus: number; sonnet: number };
  warm: { opus: number; sonnet: number };
  busy: number;
  queued: number;
  maxTotal: number;
  orphansReclaimed: number;
  totalRequests: number;
  processRecycles: number;
  requestTimeouts: number;
  routeHits: { locked: number; warm: number; cold: number; fallback: number };
  uptime: number;
}

export interface ExecuteResult {
  emitter: EventEmitter;
  routeType: "locked" | "warm" | "cold" | "fallback";
  pid: number | null;
  queueDepth: number;
}

// ---------------------------------------------------------------------------
// SessionPoolRouter
// ---------------------------------------------------------------------------

export class SessionPoolRouter {
  private config: PoolRouterConfig;
  private lockedSessions = new Map<string, PooledProcess | PendingSentinel>();
  private warmPool = new Map<PooledModel, PooledProcess[]>();
  private allProcesses = new Map<number, PooledProcess>();
  private nextId = 0;
  private shuttingDown = false;
  private startedAt = Date.now();

  // Counters for stats
  private orphansReclaimed = 0;
  private totalRequests = 0;
  private processRecycles = 0;
  private requestTimeouts = 0;
  private routeHits = { locked: 0, warm: 0, cold: 0, fallback: 0 };

  constructor(config: Partial<PoolRouterConfig> = {}) {
    this.config = {
      opusSize: config.opusSize ?? 6,
      sonnetSize: config.sonnetSize ?? 4,
      maxRequestsPerProcess: config.maxRequestsPerProcess ?? 50,
      maxTotalProcesses: config.maxTotalProcesses ?? 30,
      requestQueueDepth: config.requestQueueDepth ?? 3,
      requestTimeoutMs: config.requestTimeoutMs ?? 300000,
      sweepIdleThresholdMs: config.sweepIdleThresholdMs ?? 7200000,
    };
    this.warmPool.set("opus", []);
    this.warmPool.set("sonnet", []);
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  async initialize(): Promise<void> {
    console.log(
      `[Router] Initializing — opus: ${this.config.opusSize}, sonnet: ${this.config.sonnetSize}`
    );
    const promises: Promise<void>[] = [];
    for (let i = 0; i < this.config.opusSize; i++) {
      promises.push(this.spawnWarm("opus"));
    }
    for (let i = 0; i < this.config.sonnetSize; i++) {
      promises.push(this.spawnWarm("sonnet"));
    }
    await Promise.all(promises);
    console.log(
      `[Router] Ready — ${this.allProcesses.size} warm processes spawned`
    );
  }

  // -------------------------------------------------------------------------
  // Execute — main entry point
  // -------------------------------------------------------------------------

  execute(
    prompt: string,
    model: ClaudeModel,
    sessionKey: string
  ): ExecuteResult | null {
    if (this.shuttingDown) {
      const emitter = safeEmitter();
      process.nextTick(() => {
        try {
          emitter.emit("error", new Error("Server is shutting down"));
        } catch (err) {
          console.error(`[Router] Suppressed shutdown error:`, (err as Error).message);
        }
      });
      return { emitter, routeType: "fallback", pid: null, queueDepth: 0 };
    }

    // Only pool opus and sonnet
    if (!POOLED_MODELS.has(model)) {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "fallback_unpooled_model",
          model,
          sessionKey,
          totalProcesses: this.allProcesses.size,
        })
      );
      this.routeHits.fallback++;
      return null; // caller uses ClaudeSubprocess
    }

    const pooledModel = model as PooledModel;

    // --- Lineage-based orphan reclamation ---
    const agentChannel = this.extractAgentChannel(sessionKey);
    this.reclaimOrphans(sessionKey, agentChannel);

    // --- Check lockedSessions ---
    const existing = this.lockedSessions.get(sessionKey);

    if (existing) {
      if (isPendingSentinel(existing)) {
        return this.enqueueOnSentinel(existing, prompt, sessionKey);
      }

      const proc = existing;
      if (proc.state === "idle") {
        this.routeHits.locked++;
        this.totalRequests++;
        return this.routeToProcess(proc, prompt, "locked");
      } else {
        return this.enqueueOnProcess(proc, prompt, sessionKey);
      }
    }

    // --- New session key: claim a process ---
    // Set PENDING_SENTINEL synchronously BEFORE any async work
    const sentinel: PendingSentinel = { isPending: true, requestQueue: [] };
    this.lockedSessions.set(sessionKey, sentinel);

    const warm = this.warmPool.get(pooledModel)!;
    if (warm.length > 0) {
      // Claim from warm pool (synchronous — no race)
      const proc = warm.pop()!;
      this.lockProcess(proc, sessionKey, agentChannel);
      this.transferSentinelQueue(sentinel, proc);
      this.lockedSessions.set(sessionKey, proc);
      this.routeHits.warm++;
      this.totalRequests++;
      return this.routeToProcess(proc, prompt, "warm");
    }

    // Warm pool empty — need cold spawn
    if (this.allProcesses.size >= this.config.maxTotalProcesses) {
      this.rejectSentinelQueue(sentinel, 503, "Pool at capacity");
      this.clearSessionLock(sessionKey, null);
      this.routeHits.fallback++;
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "fallback_at_capacity",
          sessionKey,
          model,
          totalProcesses: this.allProcesses.size,
          maxTotal: this.config.maxTotalProcesses,
        })
      );
      return null; // caller uses ClaudeSubprocess
    }

    // Cold spawn (async)
    const emitter = safeEmitter();
    this.totalRequests++;
    this.routeHits.cold++;

    this.spawnCold(pooledModel)
      .then((proc) => {
        this.lockProcess(proc, sessionKey, agentChannel);
        this.transferSentinelQueue(sentinel, proc);
        this.lockedSessions.set(sessionKey, proc);
        this.assignToProcess(proc, prompt, emitter);
      })
      .catch((err) => {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: "cold_spawn_failed",
            sessionKey,
            model,
            error: String(err),
          })
        );
        this.rejectSentinelQueue(sentinel, 503, "Cold spawn failed");
        this.clearSessionLock(sessionKey, null);
        try {
          emitter.emit("error", new Error(`Cold spawn failed: ${err}`));
        } catch (emitErr) {
          console.error(`[Router] Failed to emit cold spawn error:`, (emitErr as Error).message);
        }
      });

    return {
      emitter,
      routeType: "cold",
      pid: null,
      queueDepth: sentinel.requestQueue.length,
    };
  }

  // -------------------------------------------------------------------------
  // Spawn helpers
  // -------------------------------------------------------------------------

  private async spawnWarm(model: PooledModel): Promise<void> {
    const proc = this.spawnProcess(model);
    this.warmPool.get(model)!.push(proc);
  }

  private async spawnCold(model: PooledModel): Promise<PooledProcess> {
    const proc = this.spawnProcess(model);
    await new Promise<void>((resolve) => {
      if (proc.ready) {
        resolve();
      } else {
        const timer = setTimeout(() => resolve(), 500);
        const onReady = () => {
          clearTimeout(timer);
          resolve();
        };
        proc.process.stdout?.once("data", onReady);
        proc.process.once("error", () => {
          clearTimeout(timer);
          resolve();
        });
      }
    });
    return proc;
  }

  private spawnProcess(model: PooledModel): PooledProcess {
    const id = this.nextId++;
    const args = [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
      "--model",
      model,
      "--append-system-prompt",
      OPENCLAW_TOOL_MAPPING_PROMPT,
    ];

    const child = spawn(process.env.CLAUDE_BIN || "claude", args, {
      cwd: process.env.HOME || "/tmp",
      env: Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE")
      ),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const pooled: PooledProcess = {
      id,
      process: child,
      model,
      lockedTo: null,
      agentChannel: null,
      lastRequestAt: 0,
      spawnedAt: Date.now(),
      requestCount: 0,
      state: "idle",
      requestQueue: [],
      buffer: "",
      currentEmitter: null,
      ready: false,
      requestTimeoutTimer: null,
      orphaned: false,
    };

    this.allProcesses.set(id, pooled);

    child.stdout?.on("data", (chunk: Buffer) => {
      pooled.buffer += chunk.toString();
      this.processBuffer(pooled);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (process.env.DEBUG_SUBPROCESS) {
        console.error(`[Router:${id}] stderr:`, text.slice(0, 200));
      }
      if (text.match(/\b(auth|unauthorized|token expired|forbidden)\b/i)) {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: "auth_error",
            pid: child.pid,
            processId: id,
            model,
            stderr: text.slice(0, 200),
          })
        );
        child.kill("SIGTERM");
      }
    });

    child.on("close", (code) => {
      this.handleProcessDeath(pooled, code);
    });

    child.on("error", (err) => {
      console.error(`[Router:${id}] Process error:`, err.message);
      if (pooled.currentEmitter) {
        try {
          pooled.currentEmitter.emit("error", err);
        } catch (emitErr) {
          console.error(`[Router] Failed to emit process error:`, (emitErr as Error).message);
        }
        pooled.currentEmitter = null;
      }
    });

    pooled.ready = true;

    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "process_spawned",
        processId: id,
        pid: child.pid,
        model,
      })
    );

    return pooled;
  }

  // -------------------------------------------------------------------------
  // Buffer processing
  // -------------------------------------------------------------------------

  private processBuffer(pooled: PooledProcess): void {
    const lines = pooled.buffer.split("\n");
    pooled.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message: ClaudeCliMessage = JSON.parse(trimmed);

        if (isSystemInit(message)) {
          pooled.ready = true;
          continue;
        }

        const emitter = pooled.currentEmitter;
        if (!emitter) continue;

        emitter.emit("message", message);

        if (isTextBlockStart(message)) {
          emitter.emit("text_block_start", message as ClaudeCliStreamEvent);
        }
        if (isToolUseBlockStart(message)) {
          emitter.emit("tool_use_start", message as ClaudeCliStreamEvent);
        }
        if (isInputJsonDelta(message)) {
          emitter.emit("input_json_delta", message as ClaudeCliStreamEvent);
        }
        if (isContentBlockStop(message)) {
          emitter.emit("content_block_stop", message as ClaudeCliStreamEvent);
        }
        if (isContentDelta(message)) {
          emitter.emit("content_delta", message as ClaudeCliStreamEvent);
        } else if (isAssistantMessage(message)) {
          emitter.emit("assistant", message);
        } else if (isResultMessage(message)) {
          emitter.emit("result", message);
          this.releaseProcess(pooled);
        }
      } catch {
        if (process.env.DEBUG_SUBPROCESS) {
          console.error(
            `[Router:${pooled.id}] Non-JSON:`,
            trimmed.slice(0, 100)
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Process assignment & release
  // -------------------------------------------------------------------------

  private routeToProcess(
    proc: PooledProcess,
    prompt: string,
    routeType: "locked" | "warm" | "cold"
  ): ExecuteResult {
    const emitter = safeEmitter();
    this.assignToProcess(proc, prompt, emitter);
    return {
      emitter,
      routeType,
      pid: proc.process.pid ?? null,
      queueDepth: proc.requestQueue.length,
    };
  }

  private assignToProcess(
    pooled: PooledProcess,
    prompt: string,
    emitter: EventEmitter
  ): void {
    pooled.state = "busy";
    pooled.requestCount++;
    pooled.lastRequestAt = Date.now();
    pooled.currentEmitter = emitter;

    const message = JSON.stringify({
      type: "user",
      message: { role: "user", content: prompt },
    });
    pooled.process.stdin?.write(message + "\n");

    this.startRequestTimeout(pooled);
  }

  private releaseProcess(pooled: PooledProcess): void {
    this.clearRequestTimeout(pooled);
    pooled.currentEmitter = null;

    // Orphan check
    if (pooled.orphaned) {
      this.rejectProcessQueue(pooled);
      if (pooled.lockedTo) {
        this.clearSessionLock(pooled.lockedTo, pooled);
      }
      this.killAndRespawn(pooled);
      return;
    }

    // Context accumulation guard
    if (pooled.requestCount > this.config.maxRequestsPerProcess) {
      if (pooled.requestQueue.length === 0) {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: "context_recycle",
            processId: pooled.id,
            pid: pooled.process.pid,
            requestCount: pooled.requestCount,
          })
        );
        if (pooled.lockedTo) {
          this.clearSessionLock(pooled.lockedTo, pooled);
        }
        this.killAndRespawn(pooled);
        this.processRecycles++;
        return;
      } else {
        pooled.state = "recycling";
        this.drainNextRequest(pooled);
        return;
      }
    }

    // Normal release
    if (pooled.requestQueue.length > 0) {
      this.drainNextRequest(pooled);
    } else {
      pooled.state = "idle";
    }
  }

  private drainNextRequest(pooled: PooledProcess): void {
    if (pooled.requestQueue.length === 0) {
      if (pooled.state === "recycling") {
        if (pooled.lockedTo) {
          this.clearSessionLock(pooled.lockedTo, pooled);
        }
        this.killAndRespawn(pooled);
        this.processRecycles++;
        return;
      }
      pooled.state = "idle";
      return;
    }

    const next = pooled.requestQueue.shift()!;
    this.totalRequests++;
    this.assignToProcess(pooled, next.prompt, next.emitter);
    next.resolve();
  }

  // -------------------------------------------------------------------------
  // Per-request timeout
  // -------------------------------------------------------------------------

  private startRequestTimeout(pooled: PooledProcess): void {
    this.clearRequestTimeout(pooled);
    pooled.requestTimeoutTimer = setTimeout(() => {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "request_timeout",
          processId: pooled.id,
          pid: pooled.process.pid,
          sessionKey: pooled.lockedTo,
          elapsedMs: this.config.requestTimeoutMs,
        })
      );
      this.requestTimeouts++;

      if (pooled.currentEmitter) {
        pooled.currentEmitter.emit(
          "error",
          new Error(
            `Request timed out after ${this.config.requestTimeoutMs}ms`
          )
        );
        pooled.currentEmitter = null;
      }

      this.rejectProcessQueue(pooled);

      if (pooled.lockedTo) {
        this.clearSessionLock(pooled.lockedTo, pooled);
      }

      this.killAndRespawn(pooled);
    }, this.config.requestTimeoutMs);
  }

  private clearRequestTimeout(pooled: PooledProcess): void {
    if (pooled.requestTimeoutTimer) {
      clearTimeout(pooled.requestTimeoutTimer);
      pooled.requestTimeoutTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Queue management
  // -------------------------------------------------------------------------

  private enqueueOnProcess(
    proc: PooledProcess,
    prompt: string,
    sessionKey: string
  ): ExecuteResult | null {
    if (proc.state === "recycling") {
      this.routeHits.fallback++;
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "fallback_recycling",
          sessionKey,
          processId: proc.id,
        })
      );
      return null;
    }

    if (proc.requestQueue.length >= this.config.requestQueueDepth) {
      const emitter = safeEmitter();
      process.nextTick(() =>
        emitter.emit(
          "error",
          Object.assign(
            new Error("Too Many Requests — per-session queue full"),
            { statusCode: 429, retryAfter: 5 }
          )
        )
      );
      return {
        emitter,
        routeType: "locked",
        pid: proc.process.pid ?? null,
        queueDepth: proc.requestQueue.length,
      };
    }

    const emitter = safeEmitter();
    const pending: PendingRequest = {
      prompt,
      emitter,
      resolve: () => {},
    };
    proc.requestQueue.push(pending);
    this.routeHits.locked++;

    return {
      emitter,
      routeType: "locked",
      pid: proc.process.pid ?? null,
      queueDepth: proc.requestQueue.length,
    };
  }

  private enqueueOnSentinel(
    sentinel: PendingSentinel,
    prompt: string,
    _sessionKey: string
  ): ExecuteResult | null {
    if (sentinel.requestQueue.length >= this.config.requestQueueDepth) {
      const emitter = safeEmitter();
      process.nextTick(() =>
        emitter.emit(
          "error",
          Object.assign(
            new Error("Too Many Requests — per-session queue full"),
            { statusCode: 429, retryAfter: 5 }
          )
        )
      );
      return {
        emitter,
        routeType: "locked",
        pid: null,
        queueDepth: sentinel.requestQueue.length,
      };
    }

    const emitter = safeEmitter();
    sentinel.requestQueue.push({ prompt, emitter, resolve: () => {} });

    return {
      emitter,
      routeType: "locked",
      pid: null,
      queueDepth: sentinel.requestQueue.length,
    };
  }

  private transferSentinelQueue(
    sentinel: PendingSentinel,
    proc: PooledProcess
  ): void {
    for (const pending of sentinel.requestQueue) {
      proc.requestQueue.push(pending);
    }
    sentinel.requestQueue = [];
  }

  private rejectSentinelQueue(
    sentinel: PendingSentinel,
    statusCode: number,
    message: string
  ): void {
    for (const pending of sentinel.requestQueue) {
      pending.emitter.emit(
        "error",
        Object.assign(new Error(message), { statusCode, retryAfter: 3 })
      );
    }
    sentinel.requestQueue = [];
  }

  private rejectProcessQueue(proc: PooledProcess): void {
    for (const pending of proc.requestQueue) {
      pending.emitter.emit(
        "error",
        Object.assign(new Error("Process unavailable"), {
          statusCode: 503,
          retryAfter: 3,
        })
      );
    }
    proc.requestQueue = [];
  }

  // -------------------------------------------------------------------------
  // Locking
  // -------------------------------------------------------------------------

  private lockProcess(
    proc: PooledProcess,
    sessionKey: string,
    agentChannel: string
  ): void {
    proc.lockedTo = sessionKey;
    proc.agentChannel = agentChannel;
  }

  /**
   * Canonical lock clearing — ALL unlock paths MUST use this method.
   * No inline lockedSessions.delete() anywhere else in the codebase.
   * Pass null for proc when clearing a PendingSentinel (no process state to reset).
   */
  private clearSessionLock(sessionKey: string, proc: PooledProcess | null): void {
    this.lockedSessions.delete(sessionKey);
    if (proc) {
      proc.lockedTo = null;
      proc.agentChannel = null;
      proc.requestCount = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Lineage & orphan reclamation
  // -------------------------------------------------------------------------

  private extractAgentChannel(sessionKey: string): string {
    const parts = sessionKey.split(":");
    if (parts.length >= 2) {
      return parts.slice(1).join(":");
    }
    return sessionKey;
  }

  private reclaimOrphans(
    newSessionKey: string,
    newAgentChannel: string
  ): void {
    for (const [key, value] of this.lockedSessions.entries()) {
      if (key === newSessionKey) continue;
      if (isPendingSentinel(value)) continue;

      const proc = value;
      if (proc.agentChannel === newAgentChannel) {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: "orphan_reclaimed",
            oldSessionKey: key,
            newSessionKey,
            agentChannel: newAgentChannel,
            processId: proc.id,
            pid: proc.process.pid,
            state: proc.state,
          })
        );
        this.orphansReclaimed++;

        // Reject ALL queued requests (they belong to the dead session)
        this.rejectProcessQueue(proc);

        if (proc.state === "idle") {
          this.clearSessionLock(key, proc);
          this.killAndRespawn(proc);
        } else {
          // Busy — mark for reclamation after current request
          proc.orphaned = true;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Process death & respawn
  // -------------------------------------------------------------------------

  private handleProcessDeath(pooled: PooledProcess, code: number | null): void {
    // If already removed from allProcesses (e.g. by killAndRespawn), skip
    if (!this.allProcesses.has(pooled.id)) return;

    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "process_death",
        processId: pooled.id,
        pid: pooled.process.pid,
        code,
        model: pooled.model,
        state: pooled.state,
        lockedTo: pooled.lockedTo,
      })
    );

    this.clearRequestTimeout(pooled);

    if (pooled.currentEmitter) {
      try {
        pooled.currentEmitter.emit(
          "error",
          new Error(`Pool process ${pooled.id} died with code ${code}`)
        );
      } catch (emitErr) {
        console.error(`[Router] Failed to emit process death error:`, (emitErr as Error).message);
      }
      pooled.currentEmitter = null;
    }

    this.rejectProcessQueue(pooled);

    if (pooled.lockedTo) {
      this.clearSessionLock(pooled.lockedTo, pooled);
    }

    this.allProcesses.delete(pooled.id);

    const warm = this.warmPool.get(pooled.model);
    if (warm) {
      const idx = warm.indexOf(pooled);
      if (idx >= 0) warm.splice(idx, 1);
    }

    if (!this.shuttingDown) {
      this.spawnWarm(pooled.model).catch((err) => {
        console.error(`[Router] Failed to respawn after death:`, err);
      });
    }
  }

  private killAndRespawn(pooled: PooledProcess): void {
    this.clearRequestTimeout(pooled);
    pooled.currentEmitter = null;

    // Remove from allProcesses BEFORE kill to prevent double-handling
    this.allProcesses.delete(pooled.id);

    const warm = this.warmPool.get(pooled.model);
    if (warm) {
      const idx = warm.indexOf(pooled);
      if (idx >= 0) warm.splice(idx, 1);
    }

    pooled.process.stdin?.end();
    setTimeout(() => {
      try {
        pooled.process.kill("SIGKILL");
      } catch {
        // Already dead
      }
    }, 3000);

    if (
      !this.shuttingDown &&
      this.allProcesses.size < this.config.maxTotalProcesses
    ) {
      this.spawnWarm(pooled.model).catch((err) => {
        console.error(`[Router] Failed to respawn:`, err);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Sweep (nightly 3 AM ET)
  // -------------------------------------------------------------------------

  async sweep(): Promise<void> {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "sweep_start",
        totalProcesses: this.allProcesses.size,
        lockedSessions: this.lockedSessions.size,
      })
    );

    const now = Date.now();
    const toRecycle: Array<{ key: string; proc: PooledProcess }> = [];

    for (const [key, value] of this.lockedSessions.entries()) {
      if (isPendingSentinel(value)) continue;
      const proc = value;

      if (proc.state === "busy" || proc.state === "recycling") continue;

      const idleMs = now - (proc.lastRequestAt || proc.spawnedAt);
      if (
        idleMs > this.config.sweepIdleThresholdMs ||
        proc.requestCount > this.config.maxRequestsPerProcess
      ) {
        toRecycle.push({ key, proc });
      }
    }

    for (const { key, proc } of toRecycle) {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "sweep_recycle",
          processId: proc.id,
          pid: proc.process.pid,
          model: proc.model,
          idleMs: now - (proc.lastRequestAt || proc.spawnedAt),
          requestCount: proc.requestCount,
        })
      );
      this.clearSessionLock(key, proc);
      this.killAndRespawn(proc);
      this.processRecycles++;
    }

    // Refill warm pools — check MAX_TOTAL_PROCESSES before EACH spawn
    for (const model of ["opus", "sonnet"] as PooledModel[]) {
      const targetSize =
        model === "opus" ? this.config.opusSize : this.config.sonnetSize;
      const warm = this.warmPool.get(model)!;

      while (warm.length < targetSize) {
        if (this.allProcesses.size >= this.config.maxTotalProcesses) {
          console.log(
            JSON.stringify({
              ts: new Date().toISOString(),
              event: "sweep_refill_cap_reached",
              model,
              totalProcesses: this.allProcesses.size,
              maxTotal: this.config.maxTotalProcesses,
            })
          );
          break;
        }
        await this.spawnWarm(model);
      }
    }

    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "sweep_complete",
        totalProcesses: this.allProcesses.size,
        recycled: toRecycle.length,
        warmOpus: this.warmPool.get("opus")!.length,
        warmSonnet: this.warmPool.get("sonnet")!.length,
      })
    );
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  stats(): PoolStats {
    let busy = 0;
    let queued = 0;
    const locked = { total: 0, opus: 0, sonnet: 0 };

    for (const [, value] of this.lockedSessions.entries()) {
      if (isPendingSentinel(value)) {
        queued += value.requestQueue.length;
        continue;
      }
      const proc = value;
      locked.total++;
      if (proc.model === "opus") locked.opus++;
      else locked.sonnet++;
      if (proc.state === "busy" || proc.state === "recycling") busy++;
      queued += proc.requestQueue.length;
    }

    return {
      total: this.allProcesses.size,
      locked,
      warm: {
        opus: this.warmPool.get("opus")!.length,
        sonnet: this.warmPool.get("sonnet")!.length,
      },
      busy,
      queued,
      maxTotal: this.config.maxTotalProcesses,
      orphansReclaimed: this.orphansReclaimed,
      totalRequests: this.totalRequests,
      processRecycles: this.processRecycles,
      requestTimeouts: this.requestTimeouts,
      routeHits: { ...this.routeHits },
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    console.log(
      `[Router] Shutting down — ${this.allProcesses.size} processes`
    );

    // Reject all queued requests
    for (const [, value] of this.lockedSessions.entries()) {
      if (isPendingSentinel(value)) {
        this.rejectSentinelQueue(value, 503, "Server shutting down");
      } else {
        this.rejectProcessQueue(value);
      }
    }

    // Kill all processes
    const kills: Promise<void>[] = [];
    for (const pooled of this.allProcesses.values()) {
      this.clearRequestTimeout(pooled);
      if (pooled.currentEmitter) {
        pooled.currentEmitter.emit(
          "error",
          new Error("Server shutting down")
        );
        pooled.currentEmitter = null;
      }
      kills.push(
        new Promise<void>((resolve) => {
          pooled.process.on("close", () => resolve());
          pooled.process.stdin?.end();
          setTimeout(() => {
            try {
              pooled.process.kill("SIGKILL");
            } catch {
              // already dead
            }
            resolve();
          }, 5000);
        })
      );
    }

    await Promise.all(kills);
    this.allProcesses.clear();
    this.lockedSessions.clear();
    this.warmPool.set("opus", []);
    this.warmPool.set("sonnet", []);
    console.log("[Router] Shutdown complete.");
  }
}
