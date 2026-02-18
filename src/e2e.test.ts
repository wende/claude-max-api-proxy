/**
 * End-to-end test for the Claude Max API proxy.
 *
 * Starts the real server, sends HTTP requests, and verifies responses
 * against the OpenAI API format. Requires Claude CLI to be installed
 * and authenticated — uses haiku for speed and cost.
 *
 * Run: npm test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer } from "./server/index.js";
import type { Server } from "http";
import type { AddressInfo } from "net";

console.warn("\n" + "=".repeat(70));
console.warn("  WARNING: THIS TEST USES A REAL CLAUDE CODE CLI INSTANCE");
console.warn("  IT WILL BURN TOKENS ON YOUR CLAUDE MAX SUBSCRIPTION");
console.warn("=".repeat(70) + "\n");

let baseUrl: string;
let server: Server;

// Longer timeout — Claude CLI can take a while
const TEST_TIMEOUT = 120_000;

before(async () => {
  server = await startServer({ port: 0 });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await stopServer();
});

// ─── Health & Models ────────────────────────────────────────────────

describe("health and models", () => {
  it("GET /health returns ok", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.status, "ok");
    assert.equal(body.provider, "claude-code-cli");
    assert.ok(body.timestamp);
  });

  it("GET /v1/models lists all model IDs", async () => {
    const res = await fetch(`${baseUrl}/v1/models`);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.object, "list");
    assert.ok(Array.isArray(body.data));

    const ids = body.data.map((m: any) => m.id);
    for (const expected of [
      "claude-opus-4",
      "claude-opus-4-6",
      "claude-sonnet-4",
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",
      "claude-haiku-4",
      "claude-haiku-4-5",
    ]) {
      assert.ok(ids.includes(expected), `missing model ${expected}`);
    }

    for (const model of body.data) {
      assert.equal(model.object, "model");
      assert.equal(model.owned_by, "anthropic");
      assert.ok(typeof model.created === "number");
    }
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`${baseUrl}/v1/nonexistent`);
    assert.equal(res.status, 404);
  });

  it("returns 400 for empty messages", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "haiku", messages: [] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as any;
    assert.ok(body.error);
    assert.equal(body.error.code, "invalid_messages");
  });
});

// ─── Non-streaming completion ───────────────────────────────────────

describe("non-streaming completion", { timeout: TEST_TIMEOUT }, () => {
  it("returns a valid OpenAI response for a simple prompt", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4",
        stream: false,
        messages: [
          {
            role: "user",
            content: "Reply with exactly the word 'pong' and nothing else.",
          },
        ],
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as any;

    // Shape checks
    assert.ok(body.id, "missing id");
    assert.equal(body.object, "chat.completion");
    assert.ok(typeof body.created === "number");
    assert.ok(body.model, "missing model");

    // Choices
    assert.ok(Array.isArray(body.choices));
    assert.equal(body.choices.length, 1);
    const choice = body.choices[0];
    assert.equal(choice.index, 0);
    assert.equal(choice.finish_reason, "stop");
    assert.equal(choice.message.role, "assistant");
    assert.ok(typeof choice.message.content === "string");
    assert.ok(choice.message.content.length > 0, "empty content");

    // Usage
    assert.ok(body.usage, "missing usage");
    assert.ok(typeof body.usage.prompt_tokens === "number");
    assert.ok(typeof body.usage.completion_tokens === "number");
    assert.ok(typeof body.usage.total_tokens === "number");
    assert.ok(body.usage.prompt_tokens > 0, "prompt_tokens should be > 0");
    assert.ok(body.usage.total_tokens > 0, "total_tokens should be > 0");
  });

  it("handles array-style content blocks", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "haiku",
        stream: false,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Reply with exactly 'ok'." }],
          },
        ],
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(body.choices[0].message.content.length > 0);
  });
});

// ─── Streaming completion ───────────────────────────────────────────

describe("streaming completion", { timeout: TEST_TIMEOUT }, () => {
  it("returns valid SSE chunks with usage in final chunk", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4",
        stream: true,
        messages: [
          {
            role: "user",
            content: "Reply with exactly the word 'pong' and nothing else.",
          },
        ],
      }),
    });

    assert.equal(res.status, 200);
    assert.ok(
      res.headers.get("content-type")?.includes("text/event-stream"),
      "expected text/event-stream content type"
    );

    // Read the full SSE stream
    const text = await res.text();
    const lines = text.split("\n");

    const chunks: any[] = [];
    let gotDone = false;

    for (const line of lines) {
      if (line === "data: [DONE]") {
        gotDone = true;
        continue;
      }
      if (!line.startsWith("data: ")) continue;
      const json = JSON.parse(line.slice(6));
      chunks.push(json);
    }

    assert.ok(gotDone, "stream should end with [DONE]");
    assert.ok(chunks.length >= 1, "should have at least one chunk");

    // First data chunk should have role: "assistant" in delta
    const firstContentChunk = chunks.find(
      (c) => c.choices?.[0]?.delta?.role === "assistant"
    );
    assert.ok(firstContentChunk, "first chunk should set role to assistant");

    // All chunks should have correct shape
    for (const chunk of chunks) {
      assert.ok(chunk.id, "chunk missing id");
      assert.equal(chunk.object, "chat.completion.chunk");
      assert.ok(typeof chunk.created === "number");
      assert.ok(chunk.model, "chunk missing model");
      assert.ok(Array.isArray(chunk.choices));
      assert.equal(chunk.choices.length, 1);
    }

    // Last chunk should have finish_reason: "stop"
    const lastChunk = chunks[chunks.length - 1];
    assert.equal(lastChunk.choices[0].finish_reason, "stop");

    // Last chunk should include usage (our new feature)
    assert.ok(lastChunk.usage, "final chunk should include usage");
    assert.ok(typeof lastChunk.usage.prompt_tokens === "number");
    assert.ok(typeof lastChunk.usage.completion_tokens === "number");
    assert.ok(typeof lastChunk.usage.total_tokens === "number");

    // Concatenated text from all deltas should be non-empty
    const fullText = chunks
      .map((c) => c.choices[0].delta.content || "")
      .join("");
    assert.ok(fullText.length > 0, "streamed text should be non-empty");
  });
});
