# Session Pooling — Spec (Tier 1) — Rev 2

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
      YES + idle → write to stdin, mark busy
      YES + busy → enqueue on process's requestQueue (max 3, reject with 429 if full)
      NO  → warmPool["opus"].pop() → lock to sessionKey
            if warmPool empty → spawn new process (3-10s cold start, one-time)
            if MAX_TOTAL_PROCESSES reached → fall back to ClaudeSubprocess

4. Write prompt to process stdin as stream-json message
5. Read response from process stdout, emit events to caller
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

### Context Accumulation Threshold (Critical — Finding #3)

Each request adds its full prompt to the CLI's accumulated context. After 50 requests, the CLI could have 500K+ tokens of accumulated noise, risking context window overflow and degraded responses.

**Rule:** When a process completes a request and `requestCount > 50`:
- If `requestQueue` is empty → recycle immediately (kill, respawn fresh into warm pool, clear the session lock — next request from this key claims a new process)
- If `requestQueue` is non-empty → drain the queue first, then recycle when empty

The threshold is configurable via `POOL_MAX_REQUESTS_PER_PROCESS` (default 50).

### Nightly Sweep (3:00 AM ET)

```
For each locked process:
  If lastRequestAt < (now - 2 hours) OR requestCount > 50:
    If state == "busy" → skip (don't interrupt active work)
    Kill process
    Remove from lockedSessions
    Spawn fresh process into warmPool (if below configured size)

Refill warmPool to configured sizes:
  opus:   max(0, POOL_OPUS_SIZE - currentOpusWarm)  new processes
  sonnet: max(0, POOL_SONNET_SIZE - currentSonnetWarm) new processes

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

### Unknown Model Routing (Major — Finding #8)

If a request has a valid `x-openclaw-session-key` but requests a model not in any pool (e.g., `haiku`):
- **Do not attempt pooled routing** — there's no pool for that model
- Fall back to `ClaudeSubprocess` (subprocess-per-request)
- Log the model name for tracking — if it appears frequently, consider adding a pool

### Model Pool Flex Zone (Major — Finding #5)

Static 6/4 opus/sonnet split can starve one model if usage patterns shift. The warm pool sizing is a *target*, not a hard partition:

- On startup, spawn `POOL_OPUS_SIZE` opus + `POOL_SONNET_SIZE` sonnet processes
- If the opus warm pool is empty but the sonnet pool has excess (> `POOL_SONNET_SIZE`): **do not cross-assign** (different model). Spawn a cold opus process.
- If total processes < `MAX_TOTAL_PROCESSES`, cold spawns are always allowed regardless of per-model targets
- The 3 AM sweep refills to configured targets, naturally rebalancing

This is simpler than a dynamic flex zone and maintains the invariant that model pools are pure. The `MAX_TOTAL_PROCESSES` cap (default 30) prevents runaway spawning.

## Invariants (non-negotiable)

- A locked process serves ONLY the session key it is locked to. No exceptions. No "borrowing" idle locked processes.
- A process serves ONLY one request at a time on its stdin pipe. Concurrent requests queue on the per-process request queue.
- The warm pool is partitioned by model. An opus request never gets a sonnet process or vice versa.
- If the warm pool is empty and no process is available, the proxy spawns a cold subprocess (same as current behavior). It NEVER fails a request due to pool exhaustion — it degrades to cold-start or subprocess fallback.
- Total process count (locked + warm) must not exceed `MAX_TOTAL_PROCESSES` (default 30). Beyond this, new requests fall back to `ClaudeSubprocess`.
- The production port (3456) and health endpoint format remain unchanged. Existing OpenClaw provider config works without modification.
- `ClaudeSubprocess` (subprocess-per-request) is retained in the codebase as fallback for unknown models and headerless requests.
- The nightly sweep runs at 3:00 AM America/New_York (DST-aware), not UTC.

## Forbidden Patterns

- **No cross-session routing:** A process locked to session A must never serve session B, even if A is idle and B is queued. Claim a new process instead.
- **No model mixing within a process:** A process spawned with `--model opus` must never receive a sonnet request. Model is baked at spawn time.
- **No eager recycling of active sessions:** The sweep recycles only processes idle > 2 hours OR exceeding the request count threshold. A process that served a request 30 minutes ago stays locked, even during the 3 AM sweep (unless it's over the request count limit).
- **No shared mutable state between pool and routes:** The router exposes `execute()`, `stats()`, and `sweep()` only. Routes do not directly manipulate pool internals.
- **No removal of the existing subprocess manager:** `ClaudeSubprocess` stays for fallback and backward compatibility.
- **No concurrent writes to a process's stdin:** The per-process request queue serializes all writes. Any code path that bypasses the queue is a critical bug.

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
- [ ] `stats()` returns: `{ total, locked, warm: { opus, sonnet }, busy, queued, orphansReclaimed, totalRequests, processRecycles }`
- [ ] Sweep correctly identifies and recycles processes idle > 2 hours OR requestCount > 50
- [ ] Sweep skips busy processes (never interrupts active work)
- [ ] Sweep refills warm pool to configured size after recycling (respecting `MAX_TOTAL_PROCESSES`)
- [ ] Process death triggers atomic cleanup: remove from `lockedSessions`, reject queued requests with 503, spawn replacement
- [ ] Auth errors (exit code + error message matching) trigger process death recovery
- [ ] Graceful shutdown kills all processes and drains/rejects queued requests

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
- Graceful shutdown integration (SIGTERM/SIGINT)

**Acceptance Criteria:**
- [ ] Pool initializes with configured sizes on server start
- [ ] Sweep runs at 3:00 AM ET daily, correctly handling EST↔EDT transitions
- [ ] Pool sizes configurable via env vars without code changes
- [ ] Server startup logs pool configuration and initial stats
- [ ] Graceful shutdown waits for in-flight requests (30s timeout) before killing processes
- [ ] Queued requests are rejected with 503 during shutdown

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
3. **Backpressure:** Send 5 rapid requests on the same session key (queue depth 3) → first executes, 3 queue, 5th returns 429.
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
15. **Health:** `/health` endpoint returns pool stats including locked/warm/busy/queued/orphansReclaimed counts.
16. **Build:** `npm run build` succeeds with no errors or warnings.

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
    "locked": 7,
    "warm": { "opus": 3, "sonnet": 2 },
    "busy": 2,
    "queued": 0,
    "maxTotal": 30,
    "orphansReclaimed": 3,
    "totalRequests": 142,
    "processRecycles": 5,
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

## Review History

| Rev | Date | Reviewer | Findings | Status |
|-----|------|----------|----------|--------|
| 1 | 2026-03-21 | Opus sub-agent | 14 (3C/5M/6m) | All resolved in Rev 2 |

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
