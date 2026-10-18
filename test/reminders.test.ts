// Verifies snapshot parsing, the command queue, and the Shortcut endpoint without touching Apple.

import { describe, expect, it } from "vitest";
import { drainCommands, parseSnapshotPayload, queueCreate, readCommands, readSnapshot, writeSnapshot, type KvLike } from "../src/reminders";
import { handleShortcut } from "../src/shortcut";

function memoryKv(): KvLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
  };
}

const SEP = "|||";
const TOKEN = "shortcut-token-that-is-long-enough-0123456789";

describe("snapshot payload", () => {
  it("parses one reminder per line and folds continuation lines into notes", async () => {
    const payload = [
      ["Call dentist", "Personal", "2026-10-20T14:00:00-04:00", "High", "Yes", "Ask about crown"].join(SEP),
      "second line of the dentist note",
      ["Buy milk", "Groceries", "", "None", "No", ""].join(SEP),
      "",
      ["Renew passport", "Admin", "2026-11-01", "Medium", "No", "Form DS-82", "No"].join(SEP),
    ].join("\n");
    const items = await parseSnapshotPayload(payload);
    expect(items.map((item) => item.title)).toEqual(["Call dentist", "Buy milk", "Renew passport"]);
    expect(items[0]).toMatchObject({ list: "Personal", priority: "high", flagged: true, completed: false, due: "2026-10-20T18:00:00.000Z" });
    expect(items[0]?.notes).toBe("Ask about crown\nsecond line of the dentist note");
    expect(items[1]).toMatchObject({ list: "Groceries", priority: "none", flagged: false });
    expect(items[1]?.due).toBeUndefined();
    expect(items[1]?.notes).toBeUndefined();
    expect(items[2]?.priority).toBe("medium");
    expect(items[0]?.id).toMatch(/^[0-9a-f]{24}$/);
  });

  it("gives the same reminder the same id across syncs", async () => {
    const line = ["Pay rent", "Bills", "2026-11-01T09:00:00Z", "None", "No", ""].join(SEP);
    const [a] = await parseSnapshotPayload(line);
    const [b] = await parseSnapshotPayload(line);
    expect(a?.id).toBe(b?.id);
  });

  it("round-trips through KV", async () => {
    const kv = memoryKv();
    const items = await parseSnapshotPayload(["A", "L", "", "None", "No", ""].join(SEP));
    await writeSnapshot(kv, items, new Date("2026-10-18T22:00:00Z"));
    const snapshot = await readSnapshot(kv);
    expect(snapshot?.syncedAt).toBe("2026-10-18T22:00:00.000Z");
    expect(snapshot?.items).toHaveLength(1);
  });
});

describe("command queue", () => {
  it("queues creates and drains only what was handed over", async () => {
    const kv = memoryKv();
    await queueCreate(kv, { title: "First", list: "Personal", due: "2026-10-21T13:00:00-04:00", priority: "high" });
    await queueCreate(kv, { title: "Second", notes: "  trimmed  " });
    const before = await readCommands(kv);
    expect(before).toHaveLength(2);
    expect(before[0]).toMatchObject({ kind: "create", title: "First", list: "Personal", due: "2026-10-21T17:00:00.000Z", priority: "high" });
    expect(before[1]).toMatchObject({ title: "Second", notes: "trimmed" });
    expect(before[1]?.list).toBeUndefined();

    const delivered = await drainCommands(kv);
    expect(delivered.map((command) => command.title)).toEqual(["First", "Second"]);
    expect(await readCommands(kv)).toEqual([]);
    expect(await drainCommands(kv)).toEqual([]);
  });
});

describe("shortcut endpoint", () => {
  const env = (kv: KvLike, token: string | undefined = TOKEN) => ({ REMINDERS_KV: kv as unknown as KVNamespace, SHORTCUT_TOKEN: token });

  it("rejects missing, short, or wrong tokens before reading the body", async () => {
    const kv = memoryKv();
    const url = "https://calendar.example.workers.dev/shortcut/sync";
    expect((await handleShortcut(new Request(url, { method: "POST", body: "x" }), env(kv))).status).toBe(401);
    expect((await handleShortcut(new Request(url, { method: "POST", body: "x", headers: { authorization: "Bearer nope" } }), env(kv))).status).toBe(401);
    expect((await handleShortcut(new Request(url, { method: "POST", body: "x", headers: { authorization: `Bearer ${TOKEN}` } }), env(kv, "short"))).status).toBe(503);
    expect(kv.store.size).toBe(0);
  });

  it("stores the snapshot from a form field and returns queued commands once", async () => {
    const kv = memoryKv();
    await queueCreate(kv, { title: "Queued by agent", list: "Personal" });
    const form = new FormData();
    form.set("payload", [["Existing", "Personal", "", "None", "No", ""].join(SEP)].join("\n"));
    const request = new Request("https://calendar.example.workers.dev/shortcut/sync", {
      method: "POST",
      body: form,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const response = await handleShortcut(request, env(kv));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { stored: number; commands: Array<{ kind: string; title: string; list: string; due: string }> };
    expect(body.stored).toBe(1);
    expect(body.commands).toEqual([{ kind: "create", title: "Queued by agent", list: "Personal", due: "", notes: "", priority: "none" }]);
    expect((await readSnapshot(kv))?.items[0]?.title).toBe("Existing");
    expect(await readCommands(kv)).toEqual([]);
  });

  it("accepts a raw text body and ignores other methods and paths", async () => {
    const kv = memoryKv();
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" };
    const ok = await handleShortcut(new Request("https://x.workers.dev/shortcut/sync", { method: "POST", body: ["T", "L", "", "", "", ""].join(SEP), headers }), env(kv));
    expect(ok.status).toBe(200);
    expect((await handleShortcut(new Request("https://x.workers.dev/shortcut/sync", { method: "GET", headers }), env(kv))).status).toBe(405);
    expect((await handleShortcut(new Request("https://x.workers.dev/shortcut/other", { method: "POST", headers }), env(kv))).status).toBe(404);
  });
});
