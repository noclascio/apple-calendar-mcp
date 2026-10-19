// HTTP endpoint for the owner's iOS Shortcut: receives the Reminders snapshot and returns queued changes.
//
// POST /shortcut/sync
//   Authorization: Bearer <SHORTCUT_TOKEN>
//   Body: the snapshot as text, either raw text/plain or a form field named "payload".
//   Response: { "stored": n, "commands": [ { "kind": "create", "title": ..., "list": ..., "due": ..., "notes": ... } ] }
//
// The Shortcut then creates each command as a new reminder. Commands are removed once handed over.

import { secretsEqual } from "./authorize";
import { drainCommands, parseSnapshotPayload, writeSnapshot } from "./reminders";

type ShortcutEnv = Pick<Env, "REMINDERS_KV" | "SHORTCUT_TOKEN"> & Partial<Pick<Env, "CALENDAR_TIME_ZONE">>;

const MIN_TOKEN_LENGTH = 24;
const MAX_BODY_BYTES = 4_000_000;

function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization")?.trim();
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}

async function authorized(request: Request, env: ShortcutEnv): Promise<boolean> {
  const configured = env.SHORTCUT_TOKEN;
  if (!configured || configured.length < MIN_TOKEN_LENGTH) return false;
  const presented = bearer(request);
  if (!presented) return false;
  return secretsEqual(presented, configured);
}

async function readPayload(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    const field = form.get("payload");
    if (typeof field === "string") return field;
    if (field && typeof field === "object" && "text" in field) return await (field as File).text();
    return "";
  }
  if (contentType.includes("application/json")) {
    const body = (await request.json()) as { payload?: unknown };
    return typeof body?.payload === "string" ? body.payload : "";
  }
  return await request.text();
}

export function isShortcutRoute(url: URL): boolean {
  return url.pathname === "/shortcut/sync";
}

export async function handleShortcut(request: Request, env: ShortcutEnv): Promise<Response> {
  const url = new URL(request.url);
  if (!isShortcutRoute(url)) return new Response("Not found", { status: 404 });
  if (!env.SHORTCUT_TOKEN || env.SHORTCUT_TOKEN.length < MIN_TOKEN_LENGTH) {
    return Response.json({ error: "SHORTCUT_TOKEN is not configured on the Worker." }, { status: 503 });
  }
  if (!env.REMINDERS_KV) {
    return Response.json({ error: "REMINDERS_KV is not bound on the Worker." }, { status: 503 });
  }
  if (!(await authorized(request, env))) {
    return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": 'Bearer realm="shortcut"' } });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return new Response("Payload too large", { status: 413 });

  const payload = await readPayload(request);
  const items = await parseSnapshotPayload(payload, env.CALENDAR_TIME_ZONE ?? "UTC");
  const snapshot = await writeSnapshot(env.REMINDERS_KV, items);
  const commands = await drainCommands(env.REMINDERS_KV);
  console.info("shortcut_sync", { stored: items.length, commands: commands.length });
  return Response.json({
    stored: items.length,
    syncedAt: snapshot.syncedAt,
    commands: commands.map((command) => ({
      kind: command.kind,
      title: command.title,
      list: command.list ?? "",
      due: command.due ?? "",
      notes: command.notes ?? "",
      priority: command.priority ?? "none",
    })),
  });
}
