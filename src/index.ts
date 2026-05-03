/**
 * Claude Code CLI Provider Plugin for Clawdbot
 *
 * Enables using Claude Max subscription through Claude Code CLI,
 * bypassing OAuth token scope restrictions.
 */

import { startServer, stopServer, getServer } from "./server/index.js";
import { verifyClaude, verifyAuth } from "./subprocess/manager.js";

// Provider constants
const PROVIDER_ID = "claude-code-cli";
const PROVIDER_LABEL = "Claude Code CLI";
const DEFAULT_PORT = 3456;
const DEFAULT_MODEL = "claude-code-cli/claude-sonnet-4-6";

// Available models
const AVAILABLE_MODELS = [
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    alias: "opus",
    reasoning: true,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    alias: "sonnet",
    reasoning: false,
  },
  {
    id: "claude-haiku-4-6",
    name: "Claude Haiku 4.6",
    alias: "haiku",
    reasoning: false,
  },
];

/**
 * Build model definitions for Clawdbot config
 */
function buildModelDefinition(model: (typeof AVAILABLE_MODELS)[number]) {
  return {
    id: model.id,
    name: model.name,
    api: "openai-completions",
    reasoning: model.reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

/**
 * Empty plugin config schema (no user configuration needed)
 */
function emptyPluginConfigSchema() {
  return {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  };
}

/**
 * Plugin definition
 */
const claudeCodeCliPlugin = {
  id: "claude-code-cli-provider",
  name: "Claude Code CLI Provider",
  description:
    "Use Claude Max subscription via Claude Code CLI (bypasses OAuth restrictions)",
  configSchema: emptyPluginConfigSchema(),

  register(api: any) {
    let serverPort = DEFAULT_PORT;

    // Register the provider
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/claude-code-cli",
      aliases: ["claude-cli", "claude-max"],
      envVars: [], // No env vars needed - uses Claude CLI auth

      auth: [
        {
          id: "local",
          label: "Local Claude CLI",
          hint: "Uses your existing Claude Code CLI authentication (from Claude Max)",
          kind: "custom",

          run: async (ctx: any) => {
            const spin = ctx.prompter.progress("Checking Claude CLI...");

            try {
              // 1. Verify Claude CLI is installed
              const cliCheck = await verifyClaude();
              if (!cliCheck.ok) {
                spin.stop("Claude CLI not found");
                await ctx.prompter.note(
                  "Install Claude Code: npm install -g @anthropic-ai/claude-code",
                  "Installation"
                );
                throw new Error(cliCheck.error);
              }
              spin.message("Claude CLI found, checking auth...");

              // 2. Verify authentication
              const authCheck = await verifyAuth();
              if (!authCheck.ok) {
                spin.stop("Not authenticated");
                await ctx.prompter.note(
                  "Run 'claude auth login' to authenticate with your Claude Max account",
                  "Authentication"
                );
                throw new Error(authCheck.error);
              }
              spin.message("Authenticated, starting server...");

              // 3. Ask for port
              const portInput = await ctx.prompter.text({
                message: "Local server port",
                initialValue: String(DEFAULT_PORT),
                validate: (v: string) => {
                  const p = parseInt(v, 10);
                  if (isNaN(p) || p < 1 || p > 65535) {
                    return "Enter a valid port (1-65535)";
                  }
                  return undefined;
                },
              });
              serverPort = parseInt(portInput, 10);

              // 4. Start the local server
              await startServer({ port: serverPort });
              spin.stop("Claude CLI provider ready");

              const baseUrl = `http://127.0.0.1:${serverPort}/v1`;

              return {
                profiles: [
                  {
                    profileId: `${PROVIDER_ID}:local`,
                    credential: {
                      type: "token",
                      provider: PROVIDER_ID,
                      token: "local", // Dummy token - CLI handles auth
                    },
                  },
                ],
                configPatch: {
                  models: {
                    providers: {
                      [PROVIDER_ID]: {
                        baseUrl,
                        apiKey: "local",
                        api: "openai-completions",
                        authHeader: false,
                        models: AVAILABLE_MODELS.map(buildModelDefinition),
                      },
                    },
                  },
                  agents: {
                    defaults: {
                      models: Object.fromEntries(
                        AVAILABLE_MODELS.map((m) => [
                          `${PROVIDER_ID}/${m.id}`,
                          {},
                        ])
                      ),
                    },
                  },
                },
                defaultModel: DEFAULT_MODEL,
                notes: [
                  "This uses your Claude Max subscription via Claude Code CLI.",
                  "Your OAuth token is used by the CLI, not exposed directly.",
                  `Local server running at http://127.0.0.1:${serverPort}`,
                  "Keep the server running to use this provider.",
                ],
              };
            } catch (err) {
              spin.stop("Setup failed");
              throw err;
            }
          },
        },
      ],
    });

    // Handle plugin unload
    api.on("plugin:unload", async () => {
      const server = getServer();
      if (server) {
        console.log("[ClaudeCodeCLI] Stopping server on plugin unload");
        await stopServer();
      }
    });

    // Register CLI command for manual server control
    api.registerCli?.((cli: any) => {
      cli
        .command("claude-cli:start [port]")
        .description("Start the Claude CLI proxy server")
        .action(async (port: string) => {
          const p = parseInt(port || String(DEFAULT_PORT), 10);
          await startServer({ port: p });
          console.log(`Server started on port ${p}`);
        });

      cli
        .command("claude-cli:stop")
        .description("Stop the Claude CLI proxy server")
        .action(async () => {
          await stopServer();
          console.log("Server stopped");
        });

      cli
        .command("claude-cli:status")
        .description("Check Claude CLI proxy server status")
        .action(() => {
          const server = getServer();
          if (server) {
            console.log(`Server is running on port ${serverPort}`);
          } else {
            console.log("Server is not running");
          }
        });
    });

    console.log("[ClaudeCodeCLI] Plugin registered");
  },
};

export default claudeCodeCliPlugin;

// Also export server utilities for standalone use
export { startServer, stopServer, getServer } from "./server/index.js";
export { ClaudeSubprocess, verifyClaude, verifyAuth } from "./subprocess/manager.js";
export { sessionManager } from "./session/manager.js";
