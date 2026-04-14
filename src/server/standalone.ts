#!/usr/bin/env node
/**
 * Standalone server with session-aware process pooling
 *
 * Initializes the SessionPoolRouter, schedules the nightly sweep,
 * and owns the full graceful-shutdown sequence.
 *
 * Usage:
 *   npm run start
 *   node dist/server/standalone.js [port]
 */

import cron from "node-cron";
import { startServer } from "./index.js";
import { setPoolRouter } from "./routes.js";
import { SessionPoolRouter } from "../subprocess/router.js";
import { verifyClaude, verifyAuth } from "../subprocess/manager.js";
import type { Server } from "http";

// ---------------------------------------------------------------------------
// Environment configuration
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 3456;

const env = {
  port: parseInt(process.env.PORT || process.argv[2] || String(DEFAULT_PORT), 10),
  opusSize: parseInt(process.env.POOL_OPUS_SIZE || "6", 10),
  sonnetSize: parseInt(process.env.POOL_SONNET_SIZE || "4", 10),
  maxRequestsPerProcess: parseInt(process.env.POOL_MAX_REQUESTS_PER_PROCESS || "50", 10),
  maxTotalProcesses: parseInt(process.env.MAX_TOTAL_PROCESSES || "30", 10),
  sweepHour: parseInt(process.env.SWEEP_HOUR || "3", 10),
  sweepIdleThresholdMs: parseInt(process.env.SWEEP_IDLE_THRESHOLD_MS || "7200000", 10),
  requestQueueDepth: parseInt(process.env.POOL_REQUEST_QUEUE_DEPTH || "3", 10),
  requestTimeoutMs: parseInt(process.env.POOL_REQUEST_TIMEOUT_MS || "300000", 10),
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Claude Code CLI Provider - Session Pool Server");
  console.log("===============================================\n");

  // Validate port
  if (isNaN(env.port) || env.port < 1 || env.port > 65535) {
    console.error(`Invalid port: ${process.argv[2]}`);
    process.exit(1);
  }

  // Verify Claude CLI
  console.log("Checking Claude CLI...");
  const cliCheck = await verifyClaude();
  if (!cliCheck.ok) {
    console.error(`Error: ${cliCheck.error}`);
    process.exit(1);
  }
  console.log(`  Claude CLI: ${cliCheck.version || "OK"}`);

  // Verify authentication
  console.log("Checking authentication...");
  const authCheck = await verifyAuth();
  if (!authCheck.ok) {
    console.error(`Error: ${authCheck.error}`);
    console.error("Please run: claude auth login");
    process.exit(1);
  }
  console.log("  Authentication: OK\n");

  // --- Initialize SessionPoolRouter ---
  console.log("Pool configuration:");
  console.log(`  Opus pool size:       ${env.opusSize}`);
  console.log(`  Sonnet pool size:     ${env.sonnetSize}`);
  console.log(`  Max total processes:  ${env.maxTotalProcesses}`);
  console.log(`  Max requests/process: ${env.maxRequestsPerProcess}`);
  console.log(`  Request queue depth:  ${env.requestQueueDepth}`);
  console.log(`  Request timeout:      ${env.requestTimeoutMs}ms`);
  console.log(`  Sweep hour (ET):      ${env.sweepHour}:00`);
  console.log(`  Sweep idle threshold: ${env.sweepIdleThresholdMs}ms\n`);

  const router = new SessionPoolRouter({
    opusSize: env.opusSize,
    sonnetSize: env.sonnetSize,
    maxRequestsPerProcess: env.maxRequestsPerProcess,
    maxTotalProcesses: env.maxTotalProcesses,
    requestQueueDepth: env.requestQueueDepth,
    requestTimeoutMs: env.requestTimeoutMs,
    sweepIdleThresholdMs: env.sweepIdleThresholdMs,
  });

  // Register router with routes module
  setPoolRouter(router);

  // Initialize warm pools
  await router.initialize();

  // --- Start HTTP server ---
  let server: Server;
  try {
    server = await startServer({ port: env.port });
  } catch (err) {
    console.error("Failed to start server:", err);
    await router.shutdown();
    process.exit(1);
  }

  console.log(`\n[Server] Pool stats: ${JSON.stringify(router.stats())}`);
  console.log("\nServer ready. Test with:");
  console.log(
    `  curl -X POST http://localhost:${env.port}/v1/chat/completions \\`
  );
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(
    `    -d '{"model": "claude-sonnet-4", "messages": [{"role": "user", "content": "Hello!"}]}'`
  );
  console.log("\nPress Ctrl+C to stop.\n");

  // --- Schedule nightly sweep ---
  const sweepJob = cron.schedule(
    `0 ${env.sweepHour} * * *`,
    () => {
      console.log("[Sweep] Nightly sweep triggered");
      router.sweep().catch((err: unknown) => {
        console.error("[Sweep] Error:", err);
      });
    },
    { timezone: "America/New_York" }
  );

  // --- Graceful shutdown ---
  let shutdownInProgress = false;

  const shutdown = async (signal: string) => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;

    console.log(`\n[Shutdown] ${signal} received — starting graceful shutdown`);

    // 1. Stop the cron job
    sweepJob.stop();

    // 2. Close listening socket FIRST (stop new connections)
    console.log("[Shutdown] Closing listening socket...");
    server.close();

    // 3. Wait for in-flight requests (30s timeout)
    console.log("[Shutdown] Waiting up to 30s for in-flight requests...");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.log("[Shutdown] 30s timeout reached — forcing shutdown");
        resolve();
      }, 30000);

      // Check if all connections are done
      server.on("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    // 4. Shutdown the pool router (rejects queued, kills processes)
    console.log("[Shutdown] Shutting down pool router...");
    await router.shutdown();

    // 5. Exit
    console.log("[Shutdown] Complete.");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[FATAL] Unhandled promise rejection:", reason);
  process.exit(1);
});

process.on("uncaughtException", (err: Error) => {
  console.error("[FATAL] Uncaught exception:", err);
  process.exit(1);
});

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
