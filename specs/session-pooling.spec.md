# Session Pooling — Spec (Tier 1) — Rev 5

**Rev 5 (2026-03-21):** Addresses 4 findings from fourth Opus sub-agent review. 1 major, 3 minor. All prior resolutions verified adequate.

**Rev 4 (2026-03-21):** Addresses 7 findings from third Opus sub-agent review. 3 major, 4 minor. All prior resolutions verified adequate.

**Rev 3 (2026-03-21):** Addresses 7 new findings from second Opus sub-agent review. 3 major, 4 minor. All Rev 1 resolutions verified adequate.

**Rev 2 (2026-03-21):** Addresses 14 findings from Opus sub-agent architectural review. 3 critical, 5 major, 6 minor. All resolved.

## Purpose

Replace the subprocess-per-request architecture in the Claude Max API proxy with a session-aware process pool that locks warm CLI processes to OpenClaw session keys, eliminating 3–10s spawn overhead per request while preventing cross-agent context contamination.

## Context

The proxy currently spawns a new `claude --print` subprocess for every API request. Each process pays the full startup cost (CLI initialization, auth handshake), then dies after one response. With 20 agent sessions and ~5 concurrent, this overhead is the dominant latency contributor.

The prototype (`src/subprocess/pool.ts`, `src/server/standalone-pool.ts`) proved the concept: 33% faster single requests, clean concurrent handling, queue draining. But it uses a shared stateless pool — any process serves any agent. Testing confirmed that CLI processes in `--input-format stream-json` mode accumulate context across messages (the CLI treats sequential stdin messages as one continuous conversation). This means a shared pool causes cross-agent context contamination and unbounded context growth.

The production design locks each CLI process to a specific OpenClaw session key (which encodes agent + channel/thread). No cross-contamination. Context accumulation is bounded to one session's traffic. A nightly sweep recycles idle processes.

## Architecture

### Components

```
┌──────────────────────────────────────────────────┐
│  routes.ts (existing)                            │
│  handleChatCompletions()                         │
│    ├─ reads x-openclaw-session-key header        │
│    ├─ reads model from request body              │
│    └─ calls SessionPoolRouter.execute()          │
└──────────────┬───────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────┐
│  SessionPoolRouter (NEW — src/subprocess/router.ts) │
│    ├─ lockedSessions: Map<sessionKey, PooledProcess> │
│    ├─ warmPool: Map<model, PooledProcess[]>          │
│    │   ├─ opus pool (default 6)                      │
│    │   └─ sonnet pool (default 4)                    │
│    ├─ execute(prompt, model, sessionKey) → Emitter   │
│    │   1. Check lockedSessions for sessionKey        │
│    │   2. If found + idle → route to locked process  │
│    │   3. If found + busy → enqueue on per-process   │
│    │      request queue (max depth: 3)               │
│    │   4. If not found → claim from warmPool[model]  │
│    │   5. If warmPool empty → spawn cold process     │
│    │   6. Lock claimed/spawned process to sessionKey  │
│    ├─ sweep() — 3 AM ET nightly                      │
│    │   Recycle locked processes idle > 2 hours        │
│    │   Recycle locked processes with requestCount > 50│
│    │   Respawn recycled into warmPool                 │
│    │   Refill warmPool to configured size             │
│    │   Enforce MAX_TOTAL_PROCESSES cap                │
│    └─ shutdown() — graceful teardown                  │
└──────────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────┐
│  PooledProcess (enhanced from prototype pool.ts) │
│    ├─ CLI process (--input-format stream-json)   │
│    ├─ model: "opus" | "sonnet"                   │
│    ├─ lockedTo: sessionKey | null                │
│    ├─ agentChannel: string | null (lineage key)  │
│    ├─ lastRequestAt: timestamp                   │
│    ├─ spawnedAt: timestamp                       │
│    ├─ requestCount: number                       │
│    ├─ state: "idle" | "busy" | "recycling"       │
│    └─ requestQueue: Array<PendingRequest>         │
└──────────────────────────────────────────────────┘
```

### Request Flow

```
1. OpenClaw gateway → POST /v1/chat/completions
   Headers: x-openclaw-session-key: "agent:scope:discord:channel:1475832162648461316"
   Body: { model: "claude-opus-4", messages: [...], stream: true }

2. routes.ts extracts sessionKey from header, model from body

3. SessionPoolRouter.execute(prompt, "opus", sessionKey):
   a) lockedSessions.has(sessionKey)?
      YES + idle → write to stdin, mark busy, start request timeout timer
      YES + busy → enqueue on process's requestQueue (max 3, reject with 429 if full)
      YES + PENDING_SENTINEL → enqueue (claim in progress, will drain when ready)
      NO  → set PENDING_SENTINEL in lockedSessions (synchronous, prevents race)
            → warmPool["opus"].pop() → lock to sessionKey (replace sentinel)
            if warmPool empty AND total processes < MAX_TOTAL_PROCESSES → spawn new process (3-10s cold start, one-time), lock to sessionKey
            if warmPool empty AND total processes >= MAX_TOTAL_PROCESSES → reject queued requests on sentinel, delete sentinel, fall back to ClaudeSubprocess (log warning with process count)

4. Write prompt to process stdin as stream-json message
5. Read response from process stdout, emit events to caller
   - If POOL_REQUEST_TIMEOUT_MS exceeded → treat as process death (kill, reject queue, respawn)
6. Mark process idle, drain requestQueue if non-empty (next queued request starts)
7. Process stays locked to sessionKey for future requests
```

### Per-Process Request Serialization (Critical — Finding #1)

Each `PooledProcess` has a `requestQueue` (FIFO, max depth 3). The CLI's stdin pipe can only handle one message at a time — interleaving would corrupt both responses.

**When a request arrives for a locked-busy process:**
1. If `requestQueue.length < 3` → enqueue, return a pending emitter
2. If `requestQueue.length >= 3` → reject with HTTP 429 "Too Many Requests" + `Retry-After: 5`
3. When the active request completes → dequeue next, write to stdin, emit to its caller

**Why max depth 3:** A queue deeper than 3 means the session is being hammered faster than the model can respond. Backpressure via 429 is safer than unbounded queueing. The gateway will retry.

### Orphan Reclamation via Lineage Tracking (Critical — Finding #2)

Session resets generate a new session key. The old process is orphaned. Without lineage tracking, orphans accumulate until the 3 AM sweep — 20+ manual resets in a day = 20+ leaked processes.

**Solution:** Each `PooledProcess` stores `agentChannel` — extracted from the session key (e.g., `agent:scope:discord:channel:1475832162648461316` → `scope:discord:channel:1475832162648461316`). When a new session key arrives:

1. Parse the `agentChannel` from the new key
2. Scan `lockedSessions` for any process with the same `agentChannel` but a *different* session key
3. If found → that process is orphaned. If idle: kill immediately, respawn into warm pool. If busy: mark for reclamation after current request completes.

This catches resets instantly without waiting for the nightly sweep.

### Orphan Queue Rejection (Major — Finding N1)

When a session reset triggers orphan reclamation (see "Orphan Reclamation" above), the orphaned process may have queued requests from the old session key. These requests belong to a dead session — the gateway has already moved on to a new session key.

**Rule:** When a process is marked as orphaned:
- If idle: kill immediately, respawn into warm pool
- If busy with an active request: let the active request complete, then kill
- **All queued requests on the orphaned process are rejected immediately with HTTP 503 + `Retry-After: 3`** — they belong to the dead session key. The gateway will retry with the new key, which will route to the new process.

Do NOT drain queued requests on an orphaned process. The queue contents are stale — they were enqueued under a session key that no longer exists.

### Canonical Lock Clearing (Major — Finding N8)

Multiple flows remove session locks: timeout recovery, context recycling, orphan reclamation, process death, sweep, and shutdown. Each MUST use the same canonical cleanup sequence:

```
function clearSessionLock(sessionKey: string, process: PooledProcess):
  1. lockedSessions.delete(sessionKey)          // remove the mapping entirely
  2. process.lockedTo = null                     // clear the process's back-reference
  3. process.agentChannel = null                 // clear lineage key
  4. process.requestCount = 0                    // reset counter for reuse
  5. // caller then either: kills the process, or returns it to warmPool
```

**Rule:** Every code path that unlocks a session MUST call this single function. No inline `lockedSessions.delete()` scattered across the codebase. This prevents stale artifacts (e.g., deleting the map entry but leaving `process.lockedTo` set, or forgetting to clear lineage).

Deliverable: a private `clearSessionLock()` method on `SessionPoolRouter`. All unlock paths call it.

### Per-Request Timeout (Major — Finding N2)

If a CLI process hangs (stuck inference, deadlocked stdin/stdout pipe, unresponsive model), it stays in "busy" state indefinitely. The per-process queue fills to max depth, then all subsequent requests get 429'd. The nightly sweep skips busy processes. The session is permanently wedged.

**Solution:** `POOL_REQUEST_TIMEOUT_MS` (default 300000 / 5 minutes).

When a request has been in-flight longer than this threshold:
1. Treat the process as dead — trigger the standard process death recovery flow
2. The active request's emitter receives a timeout error
3. Reject all queued requests with 503 + `Retry-After: 3`
4. Remove the process from `lockedSessions`
5. Spawn a replacement into the warm pool
6. Log the timeout event with session key, PID, and elapsed time

**Why 5 minutes:** The existing proxy has a 15-minute timeout for subprocess-per-request. Pooled processes should be tighter — a 5-minute inference is extremely unusual and likely indicates a hang. The model typically responds in 10-60 seconds. This is configurable via env var.

### Atomic Pool Claim (Major — Finding N3)

Two simultaneous requests for the same *new* session key can race: both check `lockedSessions.has(key)` → false, both attempt to claim from the warm pool. One overwrites the other's lock, orphaning a process with no lineage reclamation.

Node.js is single-threaded, but the `execute()` path has async yield points (cold spawn with `await`). Between the `has()` check and the lock write, another request can enter the same path.

**Solution:** Set a pending-lock sentinel immediately (synchronously) on first touch:

```
execute(prompt, model, sessionKey):
  if lockedSessions.has(sessionKey):
    // route to existing locked process (or queue)
  else:
    // SYNCHRONOUS: set sentinel before any async work
    lockedSessions.set(sessionKey, PENDING_SENTINEL)
    try:
      process = warmPool[model].pop() ?? await spawnCold(model)
      lockedSessions.set(sessionKey, process)  // replace sentinel with real process
    catch:
      lockedSessions.delete(sessionKey)  // clean up sentinel on failure
      throw

  // Second request for same key hits the `has()` check → true → queues on the sentinel
  // When sentinel is replaced with real process, queued requests are drained
```

The `PENDING_SENTINEL` is a special marker that causes incoming requests for that key to enqueue. When the real process is assigned, the queue drains.

**Implementation note (Finding N16):** `lockedSessions` is typed `Map<string, PooledProcess>`, but the sentinel is not a real `PooledProcess`. Implement the sentinel as a lightweight object with `{ isPending: true, requestQueue: PendingRequest[] }` — it has a queue (where requests accumulate while the real process is being claimed/spawned) but no actual CLI process. When the real process is assigned, transfer the sentinel's `requestQueue` to the new `PooledProcess` and drain it. The router checks `isPending` to distinguish sentinels from real processes. Type the map as `Map<string, PooledProcess | PendingSentinel>` or use a discriminated union.

### Failed Cold Spawn Recovery (Major — Finding N9)

If a `PENDING_SENTINEL` is set and the cold spawn fails (CLI binary missing, auth broken, OOM), the catch block deletes the sentinel — but requests that queued against the sentinel are now waiting on nothing. They hang forever.

**Rule:** Before deleting the sentinel on spawn failure:
1. Collect all requests queued against this session key's sentinel
2. Reject each with HTTP 503 + `Retry-After: 3`
3. Then delete the sentinel from `lockedSessions`
4. Log the spawn failure with model, session key, and error

```
catch (error):
  rejectQueuedRequests(sessionKey, 503, "Retry-After: 3")  // drain before delete
  lockedSessions.delete(sessionKey)
  log({ event: "cold_spawn_failed", sessionKey, model, error })
  throw  // propagate to the original requester
```

### Context Accumulation Threshold (Critical — Finding #3)

Each request adds its full prompt to the CLI's accumulated context. After 50 requests, the CLI could have 500K+ tokens of accumulated noise, risking context window overflow and degraded responses.

**Rule:** When a process completes a request and `requestCount > 50`:
- If `requestQueue` is empty → recycle immediately: call `clearSessionLock()`, kill process, respawn into warm pool. Next request from this key claims a new process.
- If `requestQueue` is non-empty → set state to `"recycling"` (prevents new requests from being enqueued by sweep or new arrivals — they get a fresh process instead). Drain the existing queue normally. When queue empties, THEN call `clearSessionLock()`, kill, respawn. **Important (Finding N17):** `clearSessionLock()` resets `requestCount` to 0, so it must be called AFTER the drain-then-recycle decision, not before. The `"recycling"` state is the guard — it signals that this process is committed to being recycled regardless of the counter.

The threshold is configurable via `POOL_MAX_REQUESTS_PER_PROCESS` (default 50).

### Nightly Sweep (3:00 AM ET)

```
For each locked process:
  If lastRequestAt < (now - 2 hours) OR requestCount > 50:
    If state == "busy" OR state == "recycling" → skip (don't interrupt active work or double-kill a mid-recycle process — Finding N14)
    Kill process
    Remove from lockedSessions
    Spawn fresh process into warmPool (if below configured size)

Refill warmPool to configured sizes (check cap before EACH spawn, not once — Finding N11):
  for each model in [opus, sonnet]:
    while warmPool[model].length < configured size:
      if total(locked + warm) >= MAX_TOTAL_PROCESSES:
        log warning, stop refilling
        break
      spawn one process, add to warmPool[model]

Enforce MAX_TOTAL_PROCESSES:
  If total(locked + warm) > MAX_TOTAL_PROCESSES:
    Do NOT spawn new warm processes — let the pool recover naturally
    Log a warning with current counts
```

**DST Handling (Finding #9):** Use `Intl.DateTimeFormat` with `timeZone: 'America/New_York'` to resolve the current ET hour, not a fixed UTC offset. This handles EST/EDT transitions correctly. Alternatively, use `node-cron` with timezone support (`{ timezone: 'America/New_York' }`).

### Session Reset Handling

When an agent's session is reset in OpenClaw, the gateway generates a new `sessionId`, which changes the `x-openclaw-session-key`. The proxy sees a new key → lineage tracking detects the orphan → orphan is reclaimed immediately (if idle) or after its current request (if busy) → new key claims a fresh process from the warm pool.

### Process Death Recovery (Major — Finding #4)

When a CLI process exits unexpectedly:

1. **If idle:** Remove from `lockedSessions` (if locked) or from `warmPool`. Spawn replacement into warm pool.
2. **If busy (mid-request):**
   - The active request's emitter receives an error event
   - Remove the dead process from `lockedSessions`
   - **Do NOT auto-retry** — the gateway handles retries at the HTTP level
   - If the process had queued requests, reject them with 503 + `Retry-After: 3`
   - Spawn a replacement into the warm pool

The key invariant: a dead process is never left in `lockedSessions`. The `exit` handler atomically removes the mapping and spawns a replacement.

### Client Disconnect Handling (Major — Finding #6)

When a client disconnects mid-stream:
- Detach the response emitter (stop sending to the dead connection)
- Let the CLI process finish generating its response (the flat-rate subscription means no cost for wasted inference)
- The process returns to `idle` state, still locked to its session key
- **Context divergence:** The CLI now has a response in its accumulated context that the gateway never received. This is harmless because OpenClaw sends the full messages array with every request — the gateway's context is authoritative, and the CLI's accumulated context is noise that gets recycled away eventually.

### Auth Token Expiration (Major — Finding #7)

Long-lived CLI processes (up to 24 hours between sweeps) may outlive their auth token.

**Detection:** If a CLI process returns an auth error (non-zero exit or error message containing "auth", "unauthorized", "token expired"):
1. Mark the process as dead — trigger the process death recovery flow
2. Log the auth failure for monitoring
3. The replacement process will authenticate fresh on spawn

**No preemptive refresh needed.** The Claude CLI handles token refresh internally for most cases. This catch handles the edge case where it doesn't.

### Unknown Model Routing (Major — Finding #8, updated Finding N15)

The existing `extractModel()` in `openai-to-cli.ts` normalizes model strings: it maps known names to `ClaudeModel` values (`"opus" | "sonnet" | "haiku"`) and defaults unrecognized strings to `"opus"`. This means truly unknown model strings (e.g., `"gpt-4"`) silently become `"opus"` and will route to the opus pool — the "unknown model" fallback path is unreachable via the adapter.

**The router must check against the set of pooled models, not rely on type-level unknowns:**

```
const POOLED_MODELS = new Set(["opus", "sonnet"]);  // models that have warm pools

if (POOLED_MODELS.has(resolvedModel)):
  // route through SessionPoolRouter
else:
  // fall back to ClaudeSubprocess (e.g., haiku)
```

This correctly handles:
- `haiku` — a valid `ClaudeModel` but not pooled → falls back to `ClaudeSubprocess`
- Truly unknown strings — already mapped to `"opus"` by `extractModel()` → routes to opus pool (correct, since the CLI will run opus on the Max subscription regardless)
- Future models — add to `POOLED_MODELS` when a pool is created, otherwise they fall back

**Do not modify `extractModel()`** — its defaulting behavior is correct for the CLI (which needs a valid model name). The pooling decision is a separate layer.

Log any non-pooled model name for tracking — if haiku or a future model appears frequently, consider adding a pool.

### Model Pool Flex Zone (Major — Finding #5)

Static 6/4 opus/sonnet split can starve one model if usage patterns shift. The warm pool sizing is a *target*, not a hard partition:

- On startup, spawn `POOL_OPUS_SIZE` opus + `POOL_SONNET_SIZE` sonnet processes
- If the opus warm pool is empty but the sonnet pool has excess (> `POOL_SONNET_SIZE`): **do not cross-assign** (different model). Spawn a cold opus process.
- If total processes < `MAX_TOTAL_PROCESSES`, cold spawns are always allowed regardless of per-model targets
- The 3 AM sweep refills to configured targets, naturally rebalancing

This is simpler than a dynamic flex zone and maintains the invariant that model pools are pure. The `MAX_TOTAL_PROCESSES` cap (default 30) prevents runaway spawning.

### Serialization Loss in Fallback Mode (Major — Finding N10)

When `MAX_TOTAL_PROCESSES` is reached, new session-keyed requests fall back to `ClaudeSubprocess` (subprocess-per-request). Two simultaneous requests for the same session key both get separate subprocesses — no serialization, no locking. The per-process request queue does not apply to fallback subprocesses.

**This is a known degradation, not a bug.** Fallback mode is a safety valve for when the pool is saturated. In practice:
- If the cap is routinely hit, the correct fix is to increase `MAX_TOTAL_PROCESSES`, not to add serialization to the fallback path.
- Subprocess-per-request was the *entire* architecture before pooling — it works, it's just slower.
- Log a warning each time fallback is used with the current process count, so operators can detect when the cap needs raising.

## Invariants (non-negotiable)

- A locked process serves ONLY the session key it is locked to. No exceptions. No "borrowing" idle locked processes.
- A process serves ONLY one request at a time on its stdin pipe. Concurrent requests queue on the per-process request queue.
- The warm pool is partitioned by model. An opus request never gets a sonnet process or vice versa.
- If the warm pool is empty and no process is available, the proxy spawns a cold subprocess (same as current behavior). It NEVER fails a request due to pool exhaustion — it degrades to cold-start or subprocess fallback.
- Total process count (locked + warm) must not exceed `MAX_TOTAL_PROCESSES` (default 30). Beyond this, new requests fall back to `ClaudeSubprocess`.
- The production port (3456) and health endpoint format remain unchanged. Existing OpenClaw provider config works without modification.
- `ClaudeSubprocess` (subprocess-per-request) is retained in the codebase as fallback for unknown models and headerless requests. Fallback subprocesses are NOT counted against `MAX_TOTAL_PROCESSES` — they are short-lived (die after one request) and self-limiting.
- The nightly sweep runs at 3:00 AM America/New_York (DST-aware), not UTC.
- Pool claim for a new session key is atomic: a `PENDING_SENTINEL` is set synchronously before any async work. No two requests for the same new key can both claim a process.
- Every in-flight request has a timeout (`POOL_REQUEST_TIMEOUT_MS`). A hung process is treated as dead and recovered automatically.
- All session lock clearing goes through `clearSessionLock()`. No inline `lockedSessions.delete()` calls.
- Failed cold spawns reject all queued requests before deleting the sentinel. No orphaned waiters.
- Sweep refill checks `MAX_TOTAL_PROCESSES` before each individual spawn, not once at the start.
- Sweep skips processes in `recycling` state (same as `busy`). No double-kill.
- Shutdown closes the listening socket before draining. No new connections accepted during teardown.

## Forbidden Patterns

- **No cross-session routing:** A process locked to session A must never serve session B, even if A is idle and B is queued. Claim a new process instead.
- **No model mixing within a process:** A process spawned with `--model opus` must never receive a sonnet request. Model is baked at spawn time.
- **No eager recycling of active sessions:** The sweep recycles only processes idle > 2 hours OR exceeding the request count threshold. A process that served a request 30 minutes ago stays locked, even during the 3 AM sweep (unless it's over the request count limit). **Clarification:** The inline `requestCount > 50` recycling (in "Context Accumulation Threshold") is not eager recycling — it triggers only after a request completes and only when the queue is empty. It is a safety valve, not a sweep.
- **No shared mutable state between pool and routes:** The router exposes `execute()`, `stats()`, and `sweep()` only. Routes do not directly manipulate pool internals.
- **No removal of the existing subprocess manager:** `ClaudeSubprocess` stays for fallback and backward compatibility.
- **No concurrent writes to a process's stdin:** The per-process request queue serializes all writes. Any code path that bypasses the queue is a critical bug.
- **No draining queued requests on orphaned processes:** When lineage reclamation marks a process as orphaned, queued requests are rejected (503), not drained. They belong to a dead session key.
- **No pool claim without sentinel:** The `lockedSessions.set(key, PENDING_SENTINEL)` must execute synchronously before any `await`. Skipping the sentinel creates a race condition between concurrent requests for the same new key.

## Modules

### Module 1: SessionPoolRouter (`src/subprocess/router.ts`)

**Status:** Planning
**Owner:** Max
**Dependencies:** Existing pool.ts (to be refactored), existing openai-to-cli.ts adapter

**Deliverables:**
- `SessionPoolRouter` class with `execute()`, `stats()`, `sweep()`, `shutdown()`
- Per-model warm pools (opus, sonnet) with configurable sizes
- Session-key locking with `lockedSessions` map
- Per-process FIFO request queue (max depth 3) with 429 backpressure
- Lineage tracking (`agentChannel`) for orphan detection on session reset
- Context accumulation guard: recycle process when `requestCount > POOL_MAX_REQUESTS_PER_PROCESS`
- Cold-start fallback when warm pool is empty (subject to `MAX_TOTAL_PROCESSES` cap)
- `ClaudeSubprocess` fallback when `MAX_TOTAL_PROCESSES` is reached or model is unknown
- Nightly sweep logic (idle > 2 hours OR requestCount > 50 → recycle → refill)
- Process health monitoring: auto-respawn on unexpected death with atomic `lockedSessions` cleanup
- Auth error detection: treat auth failures as process death, trigger recovery flow
- Per-request timeout (`POOL_REQUEST_TIMEOUT_MS`): hung processes treated as dead, triggers recovery
- Atomic pool claim via `PENDING_SENTINEL`: prevents race condition on simultaneous new-key requests
- Orphan queue rejection: queued requests on orphaned processes are rejected (503), not drained
- Canonical `clearSessionLock()` method used by all unlock paths (timeout, recycle, orphan, death, sweep, shutdown)
- Failed cold spawn recovery: reject queued requests before deleting sentinel
- Fallback serialization loss documented and logged (warning when fallback triggered)

**Acceptance Criteria:**
- [ ] Requests with the same `x-openclaw-session-key` always route to the same process
- [ ] Requests with different session keys never share a process
- [ ] Two rapid requests on the same session key are serialized — second waits for first to complete, no stdin interleaving
- [ ] Fourth request on a busy process (queue depth 3) returns HTTP 429 with `Retry-After: 5`
- [ ] When warm pool is empty, a cold process is spawned and the request succeeds (no failure)
- [ ] When `MAX_TOTAL_PROCESSES` is reached, new session requests fall back to `ClaudeSubprocess`
- [ ] Opus requests only go to opus processes; sonnet to sonnet
- [ ] Unknown model (e.g., haiku) with session key header falls back to `ClaudeSubprocess`
- [ ] Session reset (new key, same agent+channel) immediately orphan-reclaims the old process
- [ ] Process with `requestCount > 50` is recycled on next idle transition (queue drained first)
- [ ] `stats()` returns: `{ total, locked: { total, opus, sonnet }, warm: { opus, sonnet }, busy, queued, orphansReclaimed, totalRequests, processRecycles, routeHits: { locked, warm, cold, fallback } }`
- [ ] Sweep correctly identifies and recycles processes idle > 2 hours OR requestCount > 50
- [ ] Sweep skips busy processes (never interrupts active work)
- [ ] Sweep refills warm pool to configured size after recycling (respecting `MAX_TOTAL_PROCESSES`)
- [ ] Process death triggers atomic cleanup: remove from `lockedSessions`, reject queued requests with 503, spawn replacement
- [ ] Auth errors (exit code + error message matching) trigger process death recovery
- [ ] Request timeout (`POOL_REQUEST_TIMEOUT_MS`) kills hung process and triggers death recovery
- [ ] Orphan reclamation rejects queued requests on the orphaned process with 503 (does not drain them)
- [ ] Two simultaneous requests for the same new session key do not both claim a process — second request queues behind the pending sentinel
- [ ] `agentChannel` extraction validates session key format and falls back to full key if format is unexpected
- [ ] Graceful shutdown kills all processes and drains/rejects queued requests
- [ ] All unlock paths (timeout, recycle, orphan, death, sweep, shutdown) use `clearSessionLock()` — no inline `lockedSessions.delete()`
- [ ] Failed cold spawn rejects queued requests with 503 before deleting sentinel
- [ ] Fallback to ClaudeSubprocess logs a warning with current total process count
- [ ] Sweep refill checks MAX_TOTAL_PROCESSES before each spawn (not once)
- [ ] Sweep skips processes in `recycling` state

### Module 2: Route Integration (`src/server/routes.ts`)

**Status:** Planning
**Owner:** Max
**Dependencies:** Module 1

**Deliverables:**
- Extract `x-openclaw-session-key` and `x-openclaw-agent-id` from request headers
- Route through `SessionPoolRouter.execute()` instead of `new ClaudeSubprocess()`
- Fallback to `ClaudeSubprocess` if session key header is missing (backward compat)
- Client disconnect handling: detach emitter, let process finish, return to locked-idle state
- Structured logging: log session key, model, process PID, latency, queue depth per request

**Acceptance Criteria:**
- [ ] Requests with `x-openclaw-session-key` header use pooled routing
- [ ] Requests without the header fall back to subprocess-per-request (existing behavior)
- [ ] Streaming and non-streaming both work through the pool
- [ ] Client disconnect does not kill the pooled process — it completes and returns to locked-idle
- [ ] Health endpoint includes pool stats from `stats()`
- [ ] No changes to the response format (OpenAI-compatible output unchanged)
- [ ] Each request logs: `{ sessionKey, model, processPid, latencyMs, queueDepth, cacheHit: "locked"|"warm"|"cold"|"fallback" }`

### Module 3: Server Startup & Sweep Scheduling (`src/server/standalone.ts`)

**Status:** Planning
**Owner:** Max
**Dependencies:** Module 1

**Deliverables:**
- Initialize `SessionPoolRouter` at server startup with configured pool sizes
- Schedule nightly sweep at 3:00 AM ET using `node-cron` with `timezone: 'America/New_York'` (DST-aware)
- Environment variable configuration:
  - `POOL_OPUS_SIZE` (default 6) — warm opus processes
  - `POOL_SONNET_SIZE` (default 4) — warm sonnet processes
  - `POOL_MAX_REQUESTS_PER_PROCESS` (default 50) — context accumulation threshold
  - `MAX_TOTAL_PROCESSES` (default 30) — hard cap on all pool processes (locked + warm)
  - `SWEEP_HOUR` (default 3) — hour in ET for nightly sweep
  - `SWEEP_IDLE_THRESHOLD_MS` (default 7200000) — idle time before sweep recycles
  - `POOL_REQUEST_QUEUE_DEPTH` (default 3) — per-process queue depth
  - `POOL_REQUEST_TIMEOUT_MS` (default 300000) — per-request timeout; hung process treated as dead
- Graceful shutdown integration (SIGTERM/SIGINT):
  1. **Immediately** close the listening socket (stop accepting new connections — Finding N12)
  2. Wait for in-flight requests to complete (30s timeout)
  3. Call `SessionPoolRouter.shutdown()` — rejects all queued requests with 503, kills all pool processes
  4. Exit

  **Implementation note (Finding N18):** `standalone.ts` should handle the full shutdown sequence directly rather than delegating to the existing `stopServer()` in `index.ts`. The current `stopServer()` has no pool awareness. The standalone entry point owns both the HTTP server and the pool router, so it is the natural place for the coordinated shutdown: `server.close()` (step 1), then timeout (step 2), then `router.shutdown()` (step 3), then `process.exit()` (step 4).

**Acceptance Criteria:**
- [ ] Pool initializes with configured sizes on server start
- [ ] Sweep runs at 3:00 AM ET daily, correctly handling EST↔EDT transitions
- [ ] Pool sizes configurable via env vars without code changes
- [ ] Server startup logs pool configuration and initial stats
- [ ] Graceful shutdown closes listening socket immediately on SIGTERM, then drains in-flight (30s timeout)
- [ ] Queued requests are rejected with 503 during shutdown
- [ ] No new connections accepted after shutdown signal

### Module 4: Prototype Cleanup

**Status:** Planning
**Owner:** Max
**Dependencies:** Modules 1-3 merged and verified

**Deliverables:**
- Remove `src/server/standalone-pool.ts` (prototype — superseded by production integration)
- Refactor `src/subprocess/pool.ts` into the router or remove if fully superseded
- Update CLAUDE.md with new architecture documentation
- **Separate commit from Modules 1-3** (allows clean revert if prototype removal causes issues)

**Acceptance Criteria:**
- [ ] No orphaned prototype files in the codebase
- [ ] CLAUDE.md reflects the pooled architecture
- [ ] Build succeeds with no unused imports or dead code
- [ ] Committed separately from the main pooling implementation

## Validation Criteria

What "done" looks like — these must be verified by someone other than the builder:

1. **Functional:** Send 5 requests from different session keys → each gets a dedicated process. Send a 6th from a key that already has a process → routed to the existing one (verify via logs or health endpoint).
2. **Serialization:** Send 2 rapid requests on the same session key → both succeed, responses are correct and not interleaved. Verify via log timestamps that the second waited for the first.
3. **Backpressure:** Send 5 rapid requests on the same session key (queue depth 3) → first executes, next 3 queue, 5th returns 429.
4. **Concurrency:** Send 3 simultaneous requests from different keys → all served in parallel with no queueing.
5. **Cold start:** Send a request after all warm processes are claimed → new process spawned, request succeeds, latency logged.
6. **Overflow cap:** Fill the pool to `MAX_TOTAL_PROCESSES`, send another request with a new session key → falls back to `ClaudeSubprocess`, still succeeds.
7. **Sweep:** Manually trigger sweep → processes idle > 2 hours recycled, processes with requestCount > 50 recycled, active processes retained. Warm pool refilled.
8. **Session reset:** Send request with key A, then send with key A' (different session ID, same agent+channel) → gets a fresh process. Key A's process reclaimed immediately.
9. **Orphan reclamation:** Simulate 5 rapid session resets from the same agent → verify no orphan accumulation (all old processes reclaimed, not leaked until 3 AM).
10. **Process death:** Kill a locked process's PID externally → verify: removed from lockedSessions, replacement spawned, next request on that key gets a new process.
11. **Client disconnect:** Start a streaming request, disconnect mid-stream → process not killed, returns to locked-idle state, next request on same key works.
12. **Context degradation:** Send 60 requests through the same locked process → verify the process is recycled after request 50 (on next idle). Verify subsequent request gets a fresh process.
13. **Backward compat:** Send a request without `x-openclaw-session-key` header → falls back to subprocess-per-request. No error.
14. **Unknown model:** Send a request with session key + model "haiku" → falls back to `ClaudeSubprocess`. No error.
15. **Health:** `/health` endpoint returns pool stats including locked/warm/busy/queued/orphansReclaimed counts. Stats include aggregate route-hit counters: locked, warm, cold, fallback.
16. **Request timeout:** Simulate a hung process (e.g., suspend with SIGSTOP). Verify request times out after `POOL_REQUEST_TIMEOUT_MS`, process is killed and replaced, queued requests rejected with 503.
17. **Atomic claim:** Send 2 simultaneous requests for the same new session key → only one process claimed, second request queued and served after the first completes.
18. **Orphan queue rejection:** Enqueue 2 requests on a locked process, then trigger a session reset. Verify queued requests receive 503 (not drained through the orphaned process).
19. **Build:** `npm run build` succeeds with no errors or warnings.
20. **Lock clearing consistency:** Grep the codebase for `lockedSessions.delete` — it should appear ONLY inside `clearSessionLock()`. No other direct deletions.
21. **Failed cold spawn:** Simulate a spawn failure (e.g., invalid CLAUDE_BIN) after sentinel is set with queued requests → queued requests receive 503, sentinel is cleaned up.
22. **Sweep refill cap:** Set MAX_TOTAL_PROCESSES=12, fill 10 locked + 2 warm. Trigger sweep that recycles 1 → refill spawns 1. Verify total never exceeds 12.
23. **Shutdown socket close:** Send SIGTERM, then immediately attempt a new connection → connection refused (socket closed). In-flight requests complete within 30s.

## Observability (Finding #12)

### Logging

Every request logs a structured JSON line:
```json
{
  "ts": "2026-03-21T17:30:00Z",
  "event": "request",
  "sessionKey": "agent:scope:discord:channel:...",
  "model": "opus",
  "pid": 12345,
  "latencyMs": 1770,
  "queueDepth": 0,
  "routeType": "locked|warm|cold|fallback",
  "requestCount": 12
}
```

Pool lifecycle events (spawn, recycle, death, orphan-reclaim, sweep) are also logged as structured JSON.

### Health Endpoint

`GET /health` returns:
```json
{
  "status": "ok",
  "provider": "claude-code-cli",
  "pool": {
    "total": 12,
    "locked": { "total": 7, "opus": 5, "sonnet": 2 },
    "warm": { "opus": 3, "sonnet": 2 },
    "busy": 2,
    "queued": 0,
    "maxTotal": 30,
    "orphansReclaimed": 3,
    "totalRequests": 142,
    "processRecycles": 5,
    "requestTimeouts": 0,
    "routeHits": { "locked": 98, "warm": 32, "cold": 8, "fallback": 4 },
    "uptime": 43200
  }
}
```

## Decision Log

| Date | Decision | Rationale | Alternatives Considered |
|------|----------|-----------|------------------------|
| 2026-03-21 | Per-session-key locking over shared stateless pool | CLI accumulates context in stream-json mode (empirically verified). Shared pool causes cross-agent contamination. Locking prevents this. | Shared pool + aggressive recycling — rejected because it doesn't prevent cross-contamination within the recycling window |
| 2026-03-21 | Per-model pools over single mixed pool | CLI `--model` flag is set at spawn time, cannot be changed per-request in stream-json mode | Single pool with model flag per message — not supported by CLI |
| 2026-03-21 | 3 AM ET sweep over idle timeout | Simpler rules (one daily check vs. continuous timeout tracking). Session resets handle intra-day cleanup. User controls context freshness via manual reset. | Rolling idle timeout (30 min) — adds complexity, may recycle processes the user wants kept warm |
| 2026-03-21 | 6 opus + 4 sonnet pool sizing | Matches observed usage pattern: ~70% opus, ~30% sonnet. 10 total covers expected 5-concurrent peak with buffer. Configurable via env vars. | 5+5 — doesn't match actual model distribution |
| 2026-03-21 | Retain ClaudeSubprocess as fallback | Backward compatibility for requests without session key header. Also serves unknown models (haiku, future models) not in the pool. | Remove entirely — breaks headerless requests, limits future model support |
| 2026-03-21 | Per-process request queue (max 3) + 429 backpressure | **Rev 2 — Finding #1.** CLI stdin pipe cannot handle concurrent writes. Serialization via FIFO queue prevents data corruption. Max depth 3 with 429 prevents unbounded memory growth. | Reject immediately if busy (too aggressive — normal gateway retry creates brief bursts). Unbounded queue (memory risk). |
| 2026-03-21 | Lineage-based orphan reclamation | **Rev 2 — Finding #2.** Session resets orphan processes. Without immediate reclamation, 20+ resets/day = 20+ leaked processes until 3 AM. Lineage key (agent+channel) detects orphans on the spot. | Wait for 3 AM sweep (unacceptable leak rate). Timer-based idle reclamation (adds complexity, doesn't catch rapid resets). |
| 2026-03-21 | Request count threshold (50) for recycling | **Rev 2 — Finding #3.** CLI accumulates context from every request. 50 requests ≈ 100-200K tokens of noise. Recycling at this threshold prevents context window overflow while staying well within safe bounds for a day's active session. | No threshold, rely on manual resets only (risky for agents that never reset). Lower threshold like 20 (too aggressive, causes unnecessary cold starts). |
| 2026-03-21 | MAX_TOTAL_PROCESSES cap (30) | **Rev 2 — Finding #12.** Prevents runaway process spawning from consuming all system memory. 30 processes × 200MB = 6GB worst case — well within 128GB. Beyond 30, requests fall back to ClaudeSubprocess. | No cap (dangerous). Per-model cap only (doesn't prevent total runaway). |
| 2026-03-21 | Reject (not drain) queued requests on orphaned processes | **Rev 3 — Finding N1.** Queued requests belong to the dead session key. Draining them serves stale requests and delays the process kill. Rejecting with 503 lets the gateway retry with the new key. | Drain queue first (serves stale-session requests, delays reclamation). |
| 2026-03-21 | Per-request timeout (5 min default) | **Rev 3 — Finding N2.** Without a timeout, a hung CLI process permanently wedges a session. 5 min is generous for inference (typical: 10-60s) but catches real hangs. Triggers standard death recovery. | No timeout (process stays busy forever). 15-min matching old proxy (too long for pooled — blocks the session). |
| 2026-03-21 | PENDING_SENTINEL for atomic pool claim | **Rev 3 — Finding N3.** Async yield points between `has()` and `set()` create a window for duplicate claims. Synchronous sentinel closes the window. Second request queues instead of claiming. | Mutex/lock (overkill for single-threaded Node). Accept the race (orphans a process silently). |
| 2026-03-21 | Canonical clearSessionLock() method | **Rev 4 — Finding N8.** Six different flows clear session locks with inconsistent cleanup. Single method prevents stale artifacts (dangling lockedTo, leftover lineage keys). | Inline cleanup per flow (error-prone, already caused inconsistency). |
| 2026-03-21 | Reject queued requests on failed cold spawn | **Rev 4 — Finding N9.** Sentinel deletion without queue drain leaves waiters hanging forever. Explicit rejection before deletion ensures no orphaned promises. | Let waiters timeout naturally (up to 5 min hang per request). |
| 2026-03-21 | Document fallback serialization loss as known degradation | **Rev 4 — Finding N10.** Adding serialization to ClaudeSubprocess fallback adds complexity to a safety valve that shouldn't be hit often. If it's hit often, increase the cap. | Add fallback serialization (complexity for a rare path). |
| 2026-03-21 | Route by POOLED_MODELS set, not type system | **Rev 5 — Finding N15.** `extractModel()` defaults unknowns to "opus" — the type system can't distinguish pooled from non-pooled. Explicit set check is the correct routing mechanism. | Modify extractModel to return null (breaks existing callers). |
| 2026-03-21 | Standalone.ts owns shutdown sequence | **Rev 5 — Finding N18.** The server module has no pool awareness. Rather than threading the router through `startServer`/`stopServer`, let the entry point coordinate both. | Thread router into index.ts (unnecessary coupling). |

## Review History

| Rev | Date | Reviewer | Findings | Status |
|-----|------|----------|----------|--------|
| 1 | 2026-03-21 | Opus sub-agent | 14 (3C/5M/6m) | All resolved in Rev 2 |
| 2 | 2026-03-21 | Opus sub-agent | 7 (0C/3M/4m) | All resolved in Rev 3 |
| 3 | 2026-03-21 | Opus sub-agent | 7 (0C/3M/4m) | All resolved in Rev 4 |
| 4 | 2026-03-21 | Opus sub-agent | 4 (0C/1M/3m) | All resolved in Rev 5 |

### Finding Resolution Index

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | CRITICAL | No per-process request serialization | Per-process FIFO request queue (max 3) + 429 backpressure. See "Per-Process Request Serialization" section. |
| 2 | CRITICAL | Orphaned processes leak until 3 AM | Lineage tracking via `agentChannel` field. Immediate reclamation on session reset. See "Orphan Reclamation" section. |
| 3 | CRITICAL | No context accumulation mitigation | `requestCount > 50` triggers recycling on next idle. Configurable via env var. See "Context Accumulation Threshold" section. |
| 4 | MAJOR | Process death while locked — race condition | Atomic cleanup in `exit` handler: remove from lockedSessions, reject queued requests with 503, spawn replacement. See "Process Death Recovery" section. |
| 5 | MAJOR | Static pool sizing can starve one model | Pools are targets, not hard partitions. Cold spawns allowed up to MAX_TOTAL_PROCESSES. See "Model Pool Flex Zone" section. |
| 6 | MAJOR | Client disconnect leaves CLI context diverged | Documented as harmless — OpenClaw sends full context every request, CLI accumulation is noise. See "Client Disconnect Handling" section. |
| 7 | MAJOR | No auth expiration handling | Auth errors treated as process death, triggering standard recovery flow. See "Auth Token Expiration" section. |
| 8 | MAJOR | Unknown model + session key — ambiguous routing | Unknown models bypass pool entirely, fall back to ClaudeSubprocess. See "Unknown Model Routing" section. |
| 9 | MINOR | DST handling for sweep | Use `node-cron` with `timezone: 'America/New_York'` or `Intl.DateTimeFormat`. Specified in "Nightly Sweep" section. |
| 10 | MINOR | `stats()` interface not defined | Full interface specified in "Health Endpoint" section under Observability. |
| 11 | MINOR | No validation test for context degradation | Added as Validation Criterion #12: send 60 requests, verify recycling at 50. |
| 12 | MINOR | Prototype cleanup should be separate commit | Module 4 now specifies separate commit. |
| 13 | MINOR | No logging/observability spec | Added "Observability" section with structured logging and health endpoint schemas. |
| 14 | MINOR | Pool size conflates warm vs. total | Added `MAX_TOTAL_PROCESSES` (default 30) as hard cap distinct from per-model warm targets. |
| N1 | MAJOR | Orphan reclamation races with in-flight queue | Queued requests on orphaned processes are rejected (503), not drained. They belong to the dead session. See "Orphan Queue Rejection" section. |
| N2 | MAJOR | No per-request timeout for hung processes | `POOL_REQUEST_TIMEOUT_MS` (default 300000). Timeout triggers process death recovery. See "Per-Request Timeout" section. |
| N3 | MAJOR | Pool claim not atomic — race on new session key | `PENDING_SENTINEL` set synchronously before async work. See "Atomic Pool Claim" section. |
| N4 | MINOR | `agentChannel` extraction assumes fixed key format | Validation added — falls back to full session key if format is unexpected. AC added to Module 1. |
| N5 | MINOR | Off-by-one in backpressure validation criterion | Fixed wording: "first executes, next 3 queue, 5th returns 429." |
| N6 | MINOR | ClaudeSubprocess fallback not counted in MAX_TOTAL_PROCESSES | Documented as intentional — fallback processes are short-lived and self-limiting. |
| N7 | MINOR | No aggregate route-hit counters in stats() | Added `routeHits: { locked, warm, cold, fallback }` to health endpoint. |
| N8 | MAJOR | Inconsistent lock-clearing language across flows | Canonical `clearSessionLock()` method — all unlock paths must call it. See "Canonical Lock Clearing" section. |
| N9 | MAJOR | Queued requests orphaned on failed cold spawn | Reject queued requests with 503 before deleting sentinel on spawn failure. See "Failed Cold Spawn Recovery" section. |
| N10 | MAJOR | Serialization loss in ClaudeSubprocess fallback | Documented as known degradation. Log warning when fallback triggered. See "Serialization Loss in Fallback Mode" section. |
| N11 | MINOR | Sweep refill could overshoot MAX_TOTAL_PROCESSES | Check cap before each individual spawn in refill loop. Updated in "Nightly Sweep" section. |
| N12 | MINOR | Shutdown doesn't specify when to stop accepting connections | Close listening socket immediately on SIGTERM. Updated in Module 3. |
| N13 | MINOR | Health endpoint missing locked counts per model | Added `locked: { total, opus, sonnet }` to health endpoint. |
| N14 | MINOR | Sweep could double-kill a process mid-inline-recycle | Sweep skips processes in `recycling` state. Updated in "Nightly Sweep" section. |
| N15 | MAJOR | `extractModel` defaults unknowns to "opus", defeating unknown-model fallback | Router checks against `POOLED_MODELS` set, not type-level unknowns. `extractModel` unchanged. See updated "Unknown Model Routing" section. |
| N16 | MINOR | PENDING_SENTINEL has no queue data structure | Sentinel is a `{ isPending: true, requestQueue: [] }` object. Queue transfers to real process on claim. See updated "Atomic Pool Claim" section. |
| N17 | MINOR | `clearSessionLock` resets requestCount before drain completes | Drain-then-recycle sets `"recycling"` state first, calls `clearSessionLock` only after drain completes. See updated "Context Accumulation Threshold" section. |
| N18 | MINOR | Shutdown has no mechanism to access pool from server module | `standalone.ts` owns the full shutdown sequence directly. See updated Module 3. |

## Pre-Change Impact Statement

**Risk:** 🟡 Yellow

**Impact on dependent systems:**
- **OpenClaw gateway:** No changes required. Gateway already sends `x-openclaw-session-key` and `x-openclaw-agent-id` headers. Pool is transparent — same endpoint, same response format.
- **All 20+ agent sessions:** Transparent improvement. Agents see faster responses, no behavioral change.
- **systemd service:** No changes to the service file. Same binary, same port.
- **Monitoring:** Health endpoint gains pool stats — additive, not breaking.

**What could break:**
- If the session key header extraction is wrong, all requests fall through to subprocess (safe degradation, but no pooling benefit)
- If pool process dies mid-request and respawn races with the next request on the same key, the next request could get a cold start instead of its locked process (handled by atomic cleanup in Finding #4 resolution)
- If the 3 AM sweep timezone calculation is wrong, sweep runs at wrong time (consequences are minor — processes accumulate a few extra hours of context; mitigated by DST-aware scheduling in Finding #9 resolution)
- If `MAX_TOTAL_PROCESSES` is set too low, more requests fall back to subprocess than expected (safe degradation, adjust the cap)

**Rollback path:**
1. Set `POOL_OPUS_SIZE=0` and `POOL_SONNET_SIZE=0` → all requests fall back to `ClaudeSubprocess` (no pooling, same as current behavior)
2. Or: revert to the pre-pooling commit — `ClaudeSubprocess` is never removed

**What needs testing:**
- End-to-end request with session key header → confirm routing to locked process
- Concurrent requests from different keys → confirm parallel execution
- Rapid requests on same key → confirm serialization, no interleaving
- Process death → confirm auto-respawn and session mapping cleanup
- Session reset → confirm orphan reclamation
- Sweep with mix of active and idle processes → confirm correct recycling
- Request without header → confirm fallback to subprocess
