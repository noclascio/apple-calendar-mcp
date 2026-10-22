// Verifies the Worker entry point routes bearer-token MCP traffic around OAuth and leaves everything else to it.

import { describe, expect, it } from "vitest";
import worker from "../src/worker";

const TOKEN = "api-token-that-is-long-enough-0123456789";

function env(token: string | undefined) {
  return {
    ICLOUD_USERNAME: "owner@example.com",
    ICLOUD_APP_PASSWORD: "test-password",
    CALENDAR_TIME_ZONE: "America/New_York",
    APPROVAL_PASSWORD: "approval-password-long-enough-123456",
    API_TOKEN: token,
  } as unknown as Env;
}

const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

describe("worker routing", () => {
  it("serves MCP directly when the API token is presented", async () => {
    const request = new Request("https://calendar.example.workers.dev/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream", host: "calendar.example.workers.dev", origin: "https://calendar.example.workers.dev" },
      body: initialize,
    });
    const response = await worker.fetch(request, env(TOKEN), ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("apple-calendar-mcp-server");
  });

  it("does not bypass OAuth for a wrong, short, or missing token", async () => {
    for (const [configured, presented] of [[TOKEN, "Bearer wrong"], ["short", "Bearer short"], [TOKEN, undefined]] as const) {
      const request = new Request("https://calendar.example.workers.dev/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", host: "calendar.example.workers.dev", origin: "https://calendar.example.workers.dev", ...(presented ? { authorization: presented } : {}) },
        body: initialize,
      });
      const response = await worker.fetch(request, env(configured), ctx);
      expect(response.status).toBe(401);
    }
  });
});

describe("basic-auth form of the API token", () => {
  it("accepts any username with the token as the password on /mcp", async () => {
    const encoded = btoa(`token:${TOKEN}`);
    const request = new Request("https://calendar.example.workers.dev/mcp", {
      method: "POST",
      headers: { authorization: `Basic ${encoded}`, "content-type": "application/json", accept: "application/json, text/event-stream", host: "calendar.example.workers.dev", origin: "https://calendar.example.workers.dev" },
      body: initialize,
    });
    expect((await worker.fetch(request, env(TOKEN), ctx)).status).toBe(200);
  });

  it("rejects basic auth with the wrong password", async () => {
    const encoded = btoa("token:wrong-password-that-is-also-long-enough");
    const request = new Request("https://calendar.example.workers.dev/mcp", {
      method: "POST",
      headers: { authorization: `Basic ${encoded}`, "content-type": "application/json", accept: "application/json, text/event-stream", host: "calendar.example.workers.dev", origin: "https://calendar.example.workers.dev" },
      body: initialize,
    });
    expect((await worker.fetch(request, env(TOKEN), ctx)).status).toBe(401);
  });
});

describe("crash guard", () => {
  it("turns an unhandled exception into a readable 500 instead of a Cloudflare 1101", async () => {
    // A malformed multipart body makes formData() throw inside the Shortcut handler.
    const request = new Request("https://calendar.example.workers.dev/shortcut/sync", {
      method: "POST",
      headers: { authorization: `Bearer ${"shortcut-token-that-is-long-enough-0123456789"}`, "content-type": "multipart/form-data; boundary=nope" },
      body: "garbage",
    });
    const kv = { async get() { return null; }, async put() {} } as unknown as KVNamespace;
    const response = await worker.fetch(request, { ...env(TOKEN), SHORTCUT_TOKEN: "shortcut-token-that-is-long-enough-0123456789", REMINDERS_KV: kv } as unknown as Env, ctx);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("unexpected error") });
  });
});
