// Plain HTTP API for assistants that cannot speak MCP (for example Instinct and Fo).
//
// Every route lives under /api and requires `Authorization: Bearer <API_TOKEN>`. The API is disabled
// until API_TOKEN is set. GET /api returns a machine-readable description of the routes.

import { z } from "zod";
import { presentedSecret, secretsEqual } from "./authorize";
import { createEvent, getAccountProfile, getAvailability, listCalendars, searchEvents } from "./calendar";
import { credentials, eventDraftShape, type ToolEnv } from "./mcp";
import { ageMinutes, queueCreate, readCommands, readSnapshot } from "./reminders";
import { publicError } from "./security";

type ApiEnv = ToolEnv & Pick<Env, "API_TOKEN">;

const MIN_TOKEN_LENGTH = 24;
const MAX_BODY_BYTES = 1_000_000;

const prioritySchema = z.enum(["none", "low", "medium", "high"]);
const createEventSchema = z.object({ calendarId: z.string().min(1), ...eventDraftShape }).strict();
const createReminderSchema = z.object({
  title: z.string().min(1).max(1000),
  list: z.string().max(200).optional(),
  due: z.string().optional(),
  notes: z.string().max(20_000).optional(),
  priority: prioritySchema.optional(),
}).strict();

export const API_SPEC = {
  name: "Apple Calendar and Reminders bridge",
  auth: "Send the header `Authorization: Bearer <API_TOKEN>` on every request. HTTP Basic with any username and the token as the password is also accepted.",
  timeZoneNote: "Timed values are ISO 8601 with an explicit offset or Z. Responses use ISO 8601 instants.",
  routes: [
    { method: "GET", path: "/api/profile", description: "Account email, provider, and default IANA time zone." },
    { method: "GET", path: "/api/calendars", description: "Calendars with ids to use in other routes." },
    { method: "GET", path: "/api/events", query: { start: "ISO 8601, required", end: "ISO 8601, required, at most 366 days after start", calendarId: "optional, repeatable", query: "optional text match", limit: "optional, default 100, max 500" }, description: "Events in the window across all calendars or the given ones." },
    { method: "GET", path: "/api/availability", query: { start: "ISO 8601, required", end: "ISO 8601, required", calendarId: "required, repeatable" }, description: "Busy windows per calendar." },
    { method: "POST", path: "/api/events", body: "JSON: { calendarId, title, start, end, allDay?, timeZone?, location?, description?, url?, attendees?, reminders?, recurrence?, structuredLocation? }", description: "Create an event. Same fields as the MCP calendar_create_event tool." },
    { method: "GET", path: "/api/reminders", query: { list: "optional exact list name", query: "optional text match" }, description: "Open reminders from the latest iPhone snapshot, with syncedAt and ageMinutes." },
    { method: "POST", path: "/api/reminders", body: "JSON: { title, list?, due?, notes?, priority? }", description: "Queue a reminder; the owner's iPhone creates it on its next sync." },
  ],
  errors: "400 invalid input with `issues`, 401 bad token, 404 unknown route, 405 wrong method, 502 iCloud or sync error with `error`.",
} as const;

async function authorized(request: Request, env: ApiEnv): Promise<boolean> {
  const configured = env.API_TOKEN;
  if (!configured || configured.length < MIN_TOKEN_LENGTH) return false;
  const presented = presentedSecret(request);
  if (!presented) return false;
  return secretsEqual(presented, configured);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function invalid(error: z.ZodError): Response {
  return json({ error: "Invalid input.", issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) }, 400);
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) throw new Error("Request body too large.");
  try {
    return await request.json();
  } catch {
    throw new Error("Request body must be JSON.");
  }
}

export function isApiRoute(url: URL): boolean {
  return url.pathname === "/api" || url.pathname.startsWith("/api/");
}

export async function handleApi(request: Request, env: ApiEnv): Promise<Response> {
  const url = new URL(request.url);
  if (!isApiRoute(url)) return new Response("Not found", { status: 404 });
  if (!env.API_TOKEN || env.API_TOKEN.length < MIN_TOKEN_LENGTH) {
    return json({ error: "The HTTP API is disabled. Set API_TOKEN on the Worker to enable it." }, 503);
  }
  if (!(await authorized(request, env))) {
    return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": 'Bearer realm="api"' } });
  }

  const route = `${request.method} ${url.pathname.replace(/\/$/, "") || "/api"}`;
  try {
    switch (route) {
      case "GET /api":
        return json(API_SPEC);

      case "GET /api/profile":
        return json({ profile: await getAccountProfile(credentials(env)) });

      case "GET /api/calendars":
        return json({ calendars: await listCalendars(credentials(env)) });

      case "GET /api/events": {
        const params = z.object({
          start: z.string().min(1),
          end: z.string().min(1),
          query: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }).safeParse(Object.fromEntries(url.searchParams));
        if (!params.success) return invalid(params.error);
        const calendarIds = url.searchParams.getAll("calendarId").filter(Boolean);
        const result = await searchEvents(credentials(env), {
          ...(calendarIds.length ? { calendarIds } : {}),
          start: params.data.start,
          end: params.data.end,
          ...(params.data.query ? { query: params.data.query } : {}),
          limit: params.data.limit ?? 100,
          offset: 0,
        });
        return json(result);
      }

      case "GET /api/availability": {
        const params = z.object({ start: z.string().min(1), end: z.string().min(1) }).safeParse(Object.fromEntries(url.searchParams));
        if (!params.success) return invalid(params.error);
        const calendarIds = url.searchParams.getAll("calendarId").filter(Boolean);
        if (calendarIds.length === 0) return json({ error: "Invalid input.", issues: [{ path: "calendarId", message: "At least one calendarId is required." }] }, 400);
        return json(await getAvailability(credentials(env), calendarIds, params.data.start, params.data.end));
      }

      case "POST /api/events": {
        const parsed = createEventSchema.safeParse(await readJson(request));
        if (!parsed.success) return invalid(parsed.error);
        const { calendarId, ...draft } = parsed.data;
        return json({ event: await createEvent(credentials(env), calendarId, draft) }, 201);
      }

      case "GET /api/reminders": {
        if (!env.REMINDERS_KV) throw new Error("REMINDERS_KV is not bound on the Worker.");
        const snapshot = await readSnapshot(env.REMINDERS_KV);
        if (!snapshot) throw new Error("Reminders are not available: the iPhone sync Shortcut has not posted a snapshot yet.");
        const list = url.searchParams.get("list") ?? undefined;
        const query = url.searchParams.get("query")?.trim().toLowerCase() || undefined;
        const reminders = snapshot.items.filter((item) =>
          (!list || item.list === list) &&
          (!query || item.title.toLowerCase().includes(query) || (item.notes ?? "").toLowerCase().includes(query)));
        return json({
          syncedAt: snapshot.syncedAt,
          ageMinutes: ageMinutes(snapshot),
          lists: [...new Set(snapshot.items.map((item) => item.list))].sort(),
          total: reminders.length,
          reminders,
          pendingChanges: (await readCommands(env.REMINDERS_KV)).length,
        });
      }

      case "POST /api/reminders": {
        if (!env.REMINDERS_KV) throw new Error("REMINDERS_KV is not bound on the Worker.");
        const parsed = createReminderSchema.safeParse(await readJson(request));
        if (!parsed.success) return invalid(parsed.error);
        const command = await queueCreate(env.REMINDERS_KV, parsed.data, new Date(), env.CALENDAR_TIME_ZONE);
        return json({ queued: true, id: command.id, appliesOn: "the iPhone's next Reminders sync" }, 202);
      }

      default: {
        const known = API_SPEC.routes.some((entry) => entry.path === url.pathname.replace(/\/$/, ""));
        return known
          ? new Response("Method not allowed", { status: 405 })
          : json({ error: "Unknown route. GET /api lists the routes." }, 404);
      }
    }
  } catch (error) {
    const message = publicError(error);
    const status = /Invalid|must be|required|too large/i.test(message) ? 400 : 502;
    return json({ error: message }, status);
  }
}
