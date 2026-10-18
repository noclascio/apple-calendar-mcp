// Verifies the token-gated HTTP API without reaching iCloud: auth, discovery, validation, and reminders.

import { describe, expect, it } from "vitest";
import { API_SPEC, handleApi } from "../src/api";
import { queueCreate, readCommands, writeSnapshot, type KvLike } from "../src/reminders";

const TOKEN = "api-token-that-is-long-enough-0123456789";

function memoryKv(): KvLike {
  const store = new Map<string, string>();
  return { async get(key) { return store.get(key) ?? null; }, async put(key, value) { store.set(key, value); } };
}

function env(kv: KvLike, token: string | undefined = TOKEN) {
  return {
    ICLOUD_USERNAME: "owner@example.com",
    ICLOUD_APP_PASSWORD: "test-password",
    CALENDAR_TIME_ZONE: "America/New_York",
    REMINDERS_KV: kv as unknown as KVNamespace,
    API_TOKEN: token,
  };
}

const base = "https://calendar.example.workers.dev";
const auth = { authorization: `Bearer ${TOKEN}` };

describe("HTTP API", () => {
  it("is disabled without a token and rejects bad tokens", async () => {
    const kv = memoryKv();
    expect((await handleApi(new Request(`${base}/api`), env(kv, ""))).status).toBe(503);
    expect((await handleApi(new Request(`${base}/api`), env(kv, "short"))).status).toBe(503);
    expect((await handleApi(new Request(`${base}/api`), env(kv))).status).toBe(401);
    expect((await handleApi(new Request(`${base}/api`, { headers: { authorization: "Bearer wrong" } }), env(kv))).status).toBe(401);
  });

  it("describes itself and reports unknown routes and wrong methods", async () => {
    const kv = memoryKv();
    const spec = await handleApi(new Request(`${base}/api`, { headers: auth }), env(kv));
    expect(spec.status).toBe(200);
    expect(await spec.json()).toEqual(API_SPEC);
    expect((await handleApi(new Request(`${base}/api/nope`, { headers: auth }), env(kv))).status).toBe(404);
    expect((await handleApi(new Request(`${base}/api/calendars`, { method: "DELETE", headers: auth }), env(kv))).status).toBe(405);
  });

  it("validates input before touching iCloud", async () => {
    const kv = memoryKv();
    const missing = await handleApi(new Request(`${base}/api/events?start=2026-10-20T00:00:00Z`, { headers: auth }), env(kv));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "Invalid input.", issues: [{ path: "end" }] });

    const badBody = await handleApi(new Request(`${base}/api/events`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ title: "no calendar" }) }), env(kv));
    expect(badBody.status).toBe(400);

    const notJson = await handleApi(new Request(`${base}/api/events`, { method: "POST", headers: auth, body: "nope" }), env(kv));
    expect(notJson.status).toBe(400);
  });

  it("serves reminders from the snapshot and queues new ones", async () => {
    const kv = memoryKv();
    await writeSnapshot(kv, [
      { id: "a", title: "Call dentist", list: "Personal", priority: "high", flagged: true, completed: false, due: "2026-10-20T18:00:00.000Z" },
      { id: "b", title: "Buy milk", list: "Groceries", priority: "none", flagged: false, completed: false },
    ], new Date());
    const all = await handleApi(new Request(`${base}/api/reminders`, { headers: auth }), env(kv));
    expect(all.status).toBe(200);
    const body = (await all.json()) as { total: number; lists: string[]; ageMinutes: number };
    expect(body.total).toBe(2);
    expect(body.lists).toEqual(["Groceries", "Personal"]);
    expect(body.ageMinutes).toBe(0);

    const filtered = (await (await handleApi(new Request(`${base}/api/reminders?list=Personal&query=dentist`, { headers: auth }), env(kv))).json()) as { total: number };
    expect(filtered.total).toBe(1);

    const queued = await handleApi(new Request(`${base}/api/reminders`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ title: "Renew passport", list: "Admin", due: "2026-11-01T09:00:00-04:00", priority: "medium" }),
    }), env(kv));
    expect(queued.status).toBe(202);
    expect(await readCommands(kv)).toMatchObject([{ kind: "create", title: "Renew passport", list: "Admin", due: "2026-11-01T13:00:00.000Z", priority: "medium" }]);

    await queueCreate(kv, { title: "Second" });
    const pending = (await (await handleApi(new Request(`${base}/api/reminders`, { headers: auth }), env(kv))).json()) as { pendingChanges: number };
    expect(pending.pendingChanges).toBe(2);
  });

  it("reports a missing snapshot as an upstream error, not a crash", async () => {
    const kv = memoryKv();
    const response = await handleApi(new Request(`${base}/api/reminders`, { headers: auth }), env(kv));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Shortcut") });
  });
});
