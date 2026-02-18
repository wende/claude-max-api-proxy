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

- `src/types/claude-cli.ts` - Claude CLI JSON streaming types and type guards
- `src/types/openai.ts` - OpenAI-compatible API types
- `src/adapter/openai-to-cli.ts` - Converts OpenAI requests to CLI input
- `src/adapter/cli-to-openai.ts` - Converts CLI output to OpenAI responses
- `src/subprocess/manager.ts` - Spawns and manages Claude CLI subprocesses
- `src/server/routes.ts` - Express route handlers (streaming + non-streaming)
- `src/server/standalone.js` - Server entry point
