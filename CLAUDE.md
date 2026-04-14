# Claude Max API Proxy

OpenAI-compatible API proxy that wraps the Claude Code CLI.

## Build

```bash
npm run build    # Compile TypeScript
npm run dev      # Watch mode for development
```

## Service Management

The proxy runs as a macOS LaunchAgent on port 3456.

**Plist location:** `~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist`

**Logs:**
- stdout: `~/.openclaw/logs/claude-max-proxy.log`
- stderr: `~/.openclaw/logs/claude-max-proxy.err.log`

### Restart the service

```bash
launchctl kickstart -k gui/$(id -u)/com.openclaw.claude-max-proxy
```

### Stop the service

```bash
launchctl bootout gui/$(id -u)/com.openclaw.claude-max-proxy
```

### Start the service (after stop or plist change)

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist
```

### Reload after plist changes

```bash
launchctl bootout gui/$(id -u)/com.openclaw.claude-max-proxy
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist
```

### Check status

```bash
launchctl list com.openclaw.claude-max-proxy
```

## Architecture

The proxy uses a session-aware process pool to eliminate per-request spawn overhead
(3–10s) and prevent cross-agent context contamination.

### Key files

- `src/subprocess/router.ts` - **SessionPoolRouter**: session-key locking, per-model warm pools, orphan reclamation, context accumulation recycling, nightly sweep
- `src/subprocess/manager.ts` - **ClaudeSubprocess**: single-request subprocess fallback (retained for headerless requests and non-pooled models)
- `src/server/routes.ts` - Express route handlers; routes pool requests via `x-openclaw-session-key` header; falls back to ClaudeSubprocess when header is absent
- `src/server/standalone.ts` - Server entry point; initializes pool, schedules 3 AM ET sweep via node-cron, handles graceful shutdown
- `src/adapter/openai-to-cli.ts` - Converts OpenAI requests to CLI input
- `src/adapter/cli-to-openai.ts` - Converts CLI output to OpenAI responses
- `src/types/claude-cli.ts` - Claude CLI JSON streaming types and type guards
- `src/types/openai.ts` - OpenAI-compatible API types

### Request routing

```
POST /v1/chat/completions
  x-openclaw-session-key present AND model is opus/sonnet
    → SessionPoolRouter.execute() → locked warm process (33% faster)
  header absent OR model is haiku
    → ClaudeSubprocess (subprocess-per-request, original behavior)
```

### Pool env vars

| Var | Default | Description |
|-----|---------|-------------|
| POOL_OPUS_SIZE | 6 | Warm opus processes |
| POOL_SONNET_SIZE | 4 | Warm sonnet processes |
| MAX_TOTAL_PROCESSES | 30 | Hard cap (locked + warm) |
| POOL_MAX_REQUESTS_PER_PROCESS | 50 | Context accumulation threshold |
| POOL_REQUEST_QUEUE_DEPTH | 3 | Per-process queue depth before 429 |
| POOL_REQUEST_TIMEOUT_MS | 300000 | Per-request timeout (5 min) |
| SWEEP_IDLE_THRESHOLD_MS | 7200000 | Idle time before sweep recycles (2 hr) |
| SWEEP_HOUR | 3 | Hour in ET for nightly sweep |
