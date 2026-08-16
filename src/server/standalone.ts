#!/usr/bin/env node
/**
 * Standalone server for testing without Clawdbot
 *
 * Usage:
 *   npm run start
 *   # or
 *   node dist/server/standalone.js [port]
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { startServer, stopServer } from "./index.js";
import { verifyClaude } from "../subprocess/manager.js";
import { initApiKey, initAdminKey } from "./auth.js";

/**
 * Minimal .env loader: only sets variables that are not already present in
 * process.env, so container/CI environment variables always win.
 * No external dependency needed.
 */
function loadEnvFile(): void {
  let content: string;
  try {
    content = readFileSync(".env", "utf8");
  } catch {
    return; // no .env file - fine
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

const DEFAULT_PORT = 3456;

async function main(): Promise<void> {
  console.log("Claude Code CLI Provider - Standalone Server");
  console.log("============================================\n");

  loadEnvFile();

  // Parse port: CLI argument > PORT env var > default
  const port = parseInt(
    process.argv[2] || process.env.PORT || String(DEFAULT_PORT),
    10
  );
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${process.argv[2] || process.env.PORT}`);
    process.exit(1);
  }

  // Host binding: 0.0.0.0 is required inside Docker containers,
  // 127.0.0.1 is the safer default for local development.
  const host = process.env.HOST || "127.0.0.1";

  // API key authentication
  const keyStatus = initApiKey();
  if (keyStatus.enabled && keyStatus.generated) {
    console.log("[Auth] No PROXY_API_KEY configured - generated a random one:");
    console.log(`[Auth]   ${keyStatus.key}`);
    console.log("[Auth] Set PROXY_API_KEY in your environment to use your own.\n");
  } else if (keyStatus.enabled) {
    console.log("[Auth] API key authentication: ENABLED\n");
  } else {
    console.log("[Auth] WARNING: API key authentication DISABLED (PROXY_API_KEY=off)");
    console.log("[Auth] Only do this for local development!\n");
  }

  const adminStatus = initAdminKey();
  if (adminStatus.configured) {
    console.log("[Auth] Admin endpoints (/admin/*): ENABLED (dedicated PROXY_ADMIN_KEY)");
  } else if (keyStatus.enabled) {
    console.log("[Auth] Admin endpoints (/admin/*): ENABLED (falls back to PROXY_API_KEY)");
  }

  // Verify Claude CLI
  console.log("Checking Claude CLI...");
  const cliCheck = await verifyClaude();
  if (!cliCheck.ok) {
    console.error(`Error: ${cliCheck.error}`);
    process.exit(1);
  }
  console.log(`  Claude CLI: ${cliCheck.version || "OK"}`);

  // Check for credentials. The CLI can also store them in the OS keychain,
  // which we can't inspect - so a missing config dir is a warning, not fatal.
  console.log("Checking authentication...");
  const configDir = process.env.CLAUDE_CONFIG_DIR || `${process.env.HOME}/.claude`;
  let hasCredentials = false;
  try {
    hasCredentials =
      existsSync(configDir) && readdirSync(configDir).some((f) => f.endsWith(".json"));
  } catch {
    hasCredentials = false;
  }
  if (hasCredentials) {
    console.log("  Credentials: found\n");
  } else {
    console.log("  Credentials: NOT FOUND");
    console.log("  The server will start anyway, but chat requests will return a");
    console.log("  guidance message until you log in via the admin API:");
    console.log("    POST /admin/relogin/start  ->  open URL in browser");
    console.log("    POST /admin/relogin/complete  ->  submit the code\n");
  }

  // Start server
  try {
    await startServer({ port, host });
    console.log("\nServer ready. Test with:");
    console.log(`  curl -X POST http://localhost:${port}/v1/chat/completions \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"model": "claude-sonnet-4", "messages": [{"role": "user", "content": "Hello!"}]}'`);
    console.log("\nPress Ctrl+C to stop.\n");
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    await stopServer();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
