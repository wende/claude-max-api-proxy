/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration.
 * Routes session-keyed requests through SessionPoolRouter; falls back to
 * ClaudeSubprocess for headerless or non-pooled requests.
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import {
  SessionPoolRouter,
  type ExecuteResult,
} from "../subprocess/router.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import {
  cliResultToOpenai,
  createDoneChunk,
} from "../adapter/cli-to-openai.js";
import type { OpenAIChatRequest } from "../types/openai.js";
import type {
  ClaudeCliAssistant,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "../types/claude-cli.js";

// ---------------------------------------------------------------------------
// Module-level router reference (set by standalone.ts at startup)
// ---------------------------------------------------------------------------

let poolRouter: SessionPoolRouter | null = null;

export function setPoolRouter(router: SessionPoolRouter): void {
  poolRouter = router;
}

export function getPoolRouter(): SessionPoolRouter | null {
  return poolRouter;
}

// ---------------------------------------------------------------------------
// POST /v1/chat/completions
// ---------------------------------------------------------------------------

export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;
  const startTime = Date.now();
  const earlySessionKey = (req.headers["x-openclaw-session-key"] as string | undefined) || (body as any).sessionId;
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event: "request_received",
    requestId,
    sessionKey: earlySessionKey || "(none)",
    model: body.model || "(none)",
    stream,
    messageCount: body.messages?.length ?? 0,
    contentLength: req.headers["content-length"] || "(none)",
  }));

  try {
    // Validate request
    if (
      !body.messages ||
      !Array.isArray(body.messages) ||
      body.messages.length === 0
    ) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    const cliInput = openaiToCli(body);
    const sessionKey = (req.headers["x-openclaw-session-key"] as string | undefined) || cliInput.sessionId;
    const agentId = req.headers["x-openclaw-agent-id"] as string | undefined;

    // --- Pool routing ---
    if (sessionKey && poolRouter) {
      const result = poolRouter.execute(
        cliInput.prompt,
        cliInput.model,
        sessionKey
      );

      if (result) {
        // Pooled route
        const { emitter, routeType, pid, queueDepth } = result;
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          event: "request_routed",
          requestId,
          sessionKey,
          model: cliInput.model,
          routeType,
          pid,
          queueDepth,
          elapsedMs: Date.now() - startTime,
        }));

        if (stream) {
          await handlePooledStreaming(
            req,
            res,
            emitter,
            requestId,
            startTime,
            sessionKey,
            agentId,
            cliInput.model,
            routeType,
            pid,
            queueDepth
          );
        } else {
          await handlePooledNonStreaming(
            res,
            emitter,
            requestId,
            startTime,
            sessionKey,
            agentId,
            cliInput.model,
            routeType,
            pid,
            queueDepth
          );
        }
        return;
      }
      // result === null → fall through to ClaudeSubprocess
    }

    // --- Fallback: ClaudeSubprocess (no session key, unpooled model, or at capacity) ---
    const subprocess = new ClaudeSubprocess();

    if (stream) {
      await handleStreamingResponse(req, res, subprocess, cliInput, requestId);
    } else {
      await handleNonStreamingResponse(res, subprocess, cliInput, requestId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);

    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message,
          type: "server_error",
          code: null,
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Pooled streaming response
// ---------------------------------------------------------------------------

async function handlePooledStreaming(
  _req: Request,
  res: Response,
  emitter: ExecuteResult["emitter"],
  requestId: string,
  startTime: number,
  sessionKey: string,
  agentId: string | undefined,
  model: string,
  routeType: string,
  pid: number | null,
  queueDepth: number
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);
  res.flushHeaders();
  res.write(":ok\n\n");

  return new Promise<void>((resolve) => {
    let isFirst = true;
    let lastModel = "claude-sonnet-4";
    let isComplete = false;
    let hasEmittedText = false;

    const onTextBlockStart = () => {
      if (hasEmittedText && !res.writableEnded) {
        const sepChunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [
            { index: 0, delta: { content: "\n\n" }, finish_reason: null },
          ],
        };
        res.write(`data: ${JSON.stringify(sepChunk)}\n\n`);
      }
    };

    const onContentDelta = (event: ClaudeCliStreamEvent) => {
      const delta = event.event.delta;
      const text = (delta?.type === "text_delta" && delta.text) || "";
      if (text && !res.writableEnded) {
        const chunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [
            {
              index: 0,
              delta: {
                role: isFirst ? ("assistant" as const) : undefined,
                content: text,
              },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
        hasEmittedText = true;
      }
    };

    const onAssistant = (message: ClaudeCliAssistant) => {
      lastModel = message.message.model;
    };

    const onResult = (result: ClaudeCliResult) => {
      isComplete = true;
      const latencyMs = Date.now() - startTime;
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "request",
          sessionKey,
          agentId,
          model,
          pid,
          latencyMs,
          queueDepth,
          routeType,
          cacheHit: routeType,
          requestCount: result.num_turns,
        })
      );

      if (!res.writableEnded) {
        const doneChunk = createDoneChunk(requestId, lastModel);
        if (result.usage) {
          doneChunk.usage = {
            prompt_tokens: result.usage.input_tokens || 0,
            completion_tokens: result.usage.output_tokens || 0,
            total_tokens:
              (result.usage.input_tokens || 0) +
              (result.usage.output_tokens || 0),
          };
        }
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    };

    const onError = (error: Error) => {
      isComplete = true;
      const latencyMs = Date.now() - startTime;
      const errWithStatus = error as Error & {
        statusCode?: number;
        retryAfter?: number;
      };

      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "request_error",
          sessionKey,
          model,
          pid,
          latencyMs,
          routeType,
          error: error.message,
        })
      );

      if (!res.headersSent) {
        const status = errWithStatus.statusCode || 500;
        if (status === 429) {
          res.setHeader("Retry-After", String(errWithStatus.retryAfter || 5));
        }
        res.status(status).json({
          error: {
            message: error.message,
            type: status === 429 ? "rate_limit_error" : "server_error",
            code: null,
          },
        });
      } else if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: {
              message: error.message,
              type: "server_error",
              code: null,
            },
          })}\n\n`
        );
        res.end();
      }
      resolve();
    };

    // Client disconnect: remove only request-specific listeners,
    // preserving safeEmitter()'s permanent error listener
    res.on("close", () => {
      if (!isComplete) {
        emitter.removeListener("text_block_start", onTextBlockStart);
        emitter.removeListener("content_delta", onContentDelta);
        emitter.removeListener("assistant", onAssistant);
        emitter.removeListener("result", onResult);
        emitter.removeListener("error", onError);
      }
      resolve();
    });

    emitter.on("text_block_start", onTextBlockStart);
    emitter.on("content_delta", onContentDelta);
    emitter.on("assistant", onAssistant);
    emitter.on("result", onResult);
    emitter.on("error", onError);
  });
}

// ---------------------------------------------------------------------------
// Pooled non-streaming response
// ---------------------------------------------------------------------------

async function handlePooledNonStreaming(
  res: Response,
  emitter: ExecuteResult["emitter"],
  requestId: string,
  startTime: number,
  sessionKey: string,
  agentId: string | undefined,
  model: string,
  routeType: string,
  pid: number | null,
  queueDepth: number
): Promise<void> {
  return new Promise((resolve) => {
    emitter.on("result", (result: ClaudeCliResult) => {
      const latencyMs = Date.now() - startTime;
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "request",
          sessionKey,
          agentId,
          model,
          pid,
          latencyMs,
          queueDepth,
          routeType,
          cacheHit: routeType,
          requestCount: result.num_turns,
        })
      );
      res.json(cliResultToOpenai(result, requestId));
      resolve();
    });

    emitter.on("error", (error: Error) => {
      const latencyMs = Date.now() - startTime;
      const errWithStatus = error as Error & {
        statusCode?: number;
        retryAfter?: number;
      };

      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "request_error",
          sessionKey,
          model,
          pid,
          latencyMs,
          routeType,
          error: error.message,
        })
      );

      if (!res.headersSent) {
        const status = errWithStatus.statusCode || 500;
        if (status === 429) {
          res.setHeader("Retry-After", String(errWithStatus.retryAfter || 5));
        }
        res.status(status).json({
          error: {
            message: error.message,
            type: status === 429 ? "rate_limit_error" : "server_error",
            code: null,
          },
        });
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Fallback: ClaudeSubprocess streaming (existing behavior, unchanged)
// ---------------------------------------------------------------------------

async function handleStreamingResponse(
  req: Request,
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);
  res.flushHeaders();
  res.write(":ok\n\n");

  return new Promise<void>((resolve, reject) => {
    let isFirst = true;
    let lastModel = "claude-sonnet-4";
    let isComplete = false;
    let hasEmittedText = false;

    res.on("close", () => {
      if (!isComplete) {
        subprocess.kill();
      }
      resolve();
    });

    subprocess.on("text_block_start", () => {
      if (hasEmittedText && !res.writableEnded) {
        const sepChunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [
            {
              index: 0,
              delta: { content: "\n\n" },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(sepChunk)}\n\n`);
      }
    });

    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      const delta = event.event.delta;
      const text = (delta?.type === "text_delta" && delta.text) || "";
      if (text && !res.writableEnded) {
        const chunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [
            {
              index: 0,
              delta: {
                role: isFirst ? ("assistant" as const) : undefined,
                content: text,
              },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
        hasEmittedText = true;
      }
    });

    subprocess.on("assistant", (message: ClaudeCliAssistant) => {
      lastModel = message.message.model;
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      isComplete = true;
      if (!res.writableEnded) {
        const doneChunk = createDoneChunk(requestId, lastModel);
        if (result.usage) {
          doneChunk.usage = {
            prompt_tokens: result.usage.input_tokens || 0,
            completion_tokens: result.usage.output_tokens || 0,
            total_tokens:
              (result.usage.input_tokens || 0) +
              (result.usage.output_tokens || 0),
          };
        }
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    subprocess.on("error", (error: Error) => {
      console.error("[Streaming] Error:", error.message);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: {
              message: error.message,
              type: "server_error",
              code: null,
            },
          })}\n\n`
        );
        res.end();
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      if (!res.writableEnded) {
        if (code !== 0 && !isComplete) {
          res.write(
            `data: ${JSON.stringify({
              error: {
                message: `Process exited with code ${code}`,
                type: "server_error",
                code: null,
              },
            })}\n\n`
          );
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    subprocess
      .start(cliInput.prompt, {
        model: cliInput.model,
        sessionId: cliInput.sessionId,
      })
      .catch((err) => {
        console.error("[Streaming] Subprocess start error:", err);
        reject(err);
      });
  });
}

// ---------------------------------------------------------------------------
// Fallback: ClaudeSubprocess non-streaming (existing behavior, unchanged)
// ---------------------------------------------------------------------------

async function handleNonStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string
): Promise<void> {
  return new Promise((resolve) => {
    let finalResult: ClaudeCliResult | null = null;

    subprocess.on("result", (result: ClaudeCliResult) => {
      finalResult = result;
    });

    subprocess.on("error", (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      res.status(500).json({
        error: {
          message: error.message,
          type: "server_error",
          code: null,
        },
      });
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      if (finalResult) {
        res.json(cliResultToOpenai(finalResult, requestId));
      } else if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });

    subprocess
      .start(cliInput.prompt, {
        model: cliInput.model,
        sessionId: cliInput.sessionId,
      })
      .catch((error) => {
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
        resolve();
      });
  });
}

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------

export function handleModels(_req: Request, res: Response): void {
  const now = Math.floor(Date.now() / 1000);
  const modelIds = [
    "claude-opus-4",
    "claude-opus-4-6",
    "claude-sonnet-4",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    "claude-haiku-4",
    "claude-haiku-4-5",
  ];
  res.json({
    object: "list",
    data: modelIds.map((id) => ({
      id,
      object: "model",
      owned_by: "anthropic",
      created: now,
    })),
  });
}

// ---------------------------------------------------------------------------
// GET /health — includes pool stats when available
// ---------------------------------------------------------------------------

export function handleHealth(_req: Request, res: Response): void {
  const base: Record<string, unknown> = {
    status: "ok",
    provider: "claude-code-cli",
    timestamp: new Date().toISOString(),
  };

  if (poolRouter) {
    base.pool = poolRouter.stats();
  }

  res.json(base);
}
