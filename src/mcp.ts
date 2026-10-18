// Defines the scoped Apple Calendar MCP tools and binds each request to the Worker's iCloud secrets.

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import {
  batchGetEvents,
  createEvent,
  deleteEvent,
  getAccountProfile,
  getAvailability,
  getEvent,
  listCalendars,
  listEvents,
  respondToInvitation,
  searchEvents,
  updateEvent,
} from "./calendar";
import { ageMinutes, queueCreate, readCommands, readSnapshot } from "./reminders";
import { normalizeConfiguredHostname, publicError } from "./security";
import { isIanaTimeZone } from "./ical";

type ToolEnv = Pick<Env, "ICLOUD_USERNAME" | "ICLOUD_APP_PASSWORD" | "CALENDAR_TIME_ZONE"> & Pick<Env, "MCP_HOSTNAME" | "REMINDERS_KV">;

const calendarSchema = z.object({
  id: z.string().describe("Opaque calendar ID to pass to event tools."),
  name: z.string(),
  color: z.string().optional(),
  description: z.string().optional(),
  components: z.array(z.string()),
  timeZone: z.string().describe("IANA time zone used by this calendar, such as America/New_York."),
});

const attendeeSchema = z.object({
  email: z.string(),
  name: z.string().optional(),
  role: z.enum(["required", "optional", "chair", "non-participant"]).optional(),
  status: z.enum(["needs-action", "accepted", "declined", "tentative", "delegated"]),
  isSelf: z.boolean(),
});

const attendeeInputSchema = z.object({
  email: z.email().describe("Email address to invite."),
  name: z.string().min(1).max(200).optional(),
  role: z.enum(["required", "optional", "chair", "non-participant"]).default("required"),
}).strict();

const reminderSchema = z.object({
  action: z.enum(["display", "email", "audio"]),
  minutesBefore: z.number().int().nonnegative(),
  description: z.string().optional(),
});

const reminderInputSchema = z.object({
  minutesBefore: z.number().int().min(0).max(60 * 24 * 28),
  description: z.string().max(500).optional(),
}).strict();

const structuredLocationSchema = z.object({
  title: z.string().optional(),
  address: z.string().optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radius: z.number().nonnegative().optional().describe("Apple location radius in meters."),
});

const structuredLocationInputSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  address: z.string().min(1).max(2000).optional(),
  latitude: z.number().min(-90).max(90).describe("Verified WGS84 latitude. Together with longitude, this enables Apple Calendar's map preview."),
  longitude: z.number().min(-180).max(180).describe("Verified WGS84 longitude. Resolve coordinates from a reliable location source; never infer or invent them."),
  radius: z.number().min(0).max(1_000_000).optional().describe("Location radius in meters."),
}).strict();

const eventSchema = z.object({
  id: z.string().describe("Opaque event resource ID to pass to read and mutation tools."),
  calendarId: z.string(),
  uid: z.string(),
  title: z.string(),
  start: z.string().describe("RFC3339 timestamp, or YYYY-MM-DD for an all-day event."),
  end: z.string().describe("RFC3339 timestamp, or the exclusive YYYY-MM-DD end date for an all-day event."),
  timeZone: z.string().optional().describe("IANA time zone used for the event's wall-clock time."),
  startLocal: z.string().optional().describe("Event start expressed in timeZone with its UTC offset."),
  endLocal: z.string().optional().describe("Event end expressed in timeZone with its UTC offset."),
  allDay: z.boolean(),
  availability: z.enum(["busy", "free"]),
  status: z.enum(["confirmed", "tentative", "cancelled"]),
  attendees: z.array(attendeeSchema),
  reminders: z.array(reminderSchema),
  recurrence: z.array(z.string()),
  location: z.string().optional().describe("Human-readable Apple Calendar location field."),
  structuredLocation: structuredLocationSchema.optional().describe("Apple structured location metadata when the event contains it."),
  description: z.string().optional().describe("Apple Calendar Notes field."),
  url: z.string().optional().describe("Apple Calendar URL field; this is not an attachment or Calendar deep link."),
  color: z.string().optional(),
  organizer: z.object({ email: z.string(), name: z.string().optional() }).optional(),
  recurrenceId: z.string().optional(),
  sequence: z.number().int().optional(),
  created: z.iso.datetime().optional(),
  updated: z.iso.datetime().optional(),
  etag: z.string().optional().describe("Concurrency token required by update, delete, and invitation-response tools."),
});

const selectorSchema = {
  calendarId: z.string().min(1).describe("Opaque calendar ID returned by calendar_list_calendars."),
  eventId: z.string().min(1).describe("Opaque event ID returned by a read or search tool."),
};

const mutationSelectorSchema = {
  ...selectorSchema,
  etag: z.string().min(1).describe("Exact ETag returned by calendar_get_event. Stale writes are rejected."),
};

const recurrenceIdSchema = z.union([
  z.iso.datetime({ offset: true }),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
]).describe("Original occurrence start returned as recurrenceId by an event search.");

const recurrenceMutationShape = {
  updateScope: z.enum(["entire_series", "this_instance", "this_and_following"]).default("entire_series"),
  recurrenceId: recurrenceIdSchema.optional(),
};

function requireOccurrenceId<T extends { updateScope: "entire_series" | "this_instance" | "this_and_following"; recurrenceId?: string | undefined }>(value: T, context: z.RefinementCtx): void {
  if (value.updateScope !== "entire_series" && !value.recurrenceId) {
    context.addIssue({ code: "custom", message: "recurrenceId is required unless updateScope is entire_series.", path: ["recurrenceId"] });
  }
  if (value.updateScope === "entire_series" && value.recurrenceId) {
    context.addIssue({ code: "custom", message: "recurrenceId must be omitted when updateScope is entire_series.", path: ["recurrenceId"] });
  }
}

const recurrenceSchema = z.array(z.string().min(1).max(500)).max(20);

const eventDraftShape = {
  title: z.string().min(1).max(500),
  start: z.string().min(1).describe("RFC3339 timestamp with an offset, or YYYY-MM-DD when allDay is true."),
  end: z.string().min(1).describe("RFC3339 timestamp with an offset, or the exclusive YYYY-MM-DD end date when allDay is true."),
  timeZone: z.string().min(1).optional().describe("IANA time zone for wall-clock and recurring-event semantics, such as America/New_York. Defaults to the target calendar's time zone. The server supplies timezone rules when iCloud omits them."),
  allDay: z.boolean().default(false),
  availability: z.enum(["busy", "free"]).default("busy"),
  status: z.enum(["confirmed", "tentative", "cancelled"]).default("confirmed"),
  attendees: z.array(attendeeInputSchema).max(100).default([]).describe("Adding attendees may send invitations through iCloud."),
  reminders: z.array(reminderInputSchema).max(10).default([]).describe("Display alerts relative to the event start. Delivery follows the user's Calendar notification settings."),
  recurrence: recurrenceSchema.default([]).describe("Complete RFC 5545 RRULE, RDATE, or EXDATE lines, such as RRULE:FREQ=WEEKLY;BYDAY=MO."),
  location: z.string().max(1000).optional().describe("Human-readable Apple Calendar location."),
  structuredLocation: structuredLocationInputSchema.optional().describe("Apple structured location. Verified latitude and longitude enable Calendar's map preview. Resolve coordinates from a reliable source; never guess them. If coordinates are unavailable, use the plain location field instead. When location is omitted, the address or title also becomes the plain location."),
  description: z.string().max(20_000).optional().describe("Apple Calendar Notes field."),
  url: z.url().optional().describe("Apple Calendar URL field; unrelated to attachments."),
};

const eventPatchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  start: z.string().min(1).optional(),
  end: z.string().min(1).optional(),
  timeZone: z.string().min(1).optional().describe("IANA time zone for wall-clock and recurring-event semantics. Changing it requires start and end. The server supplies timezone rules when iCloud omits them."),
  allDay: z.boolean().optional(),
  availability: z.enum(["busy", "free"]).optional(),
  status: z.enum(["confirmed", "tentative", "cancelled"]).optional(),
  attendees: z.array(attendeeInputSchema).max(100).nullable().optional().describe("Complete replacement list; null removes all attendees."),
  reminders: z.array(reminderInputSchema).max(10).nullable().optional().describe("Complete replacement list of display alerts; null removes all alerts. Delivery follows the user's Calendar notification settings."),
  recurrence: recurrenceSchema.nullable().optional().describe("Complete replacement list; null removes recurrence."),
  location: z.string().max(1000).nullable().optional().describe("Human-readable location; null clears it. Changing it alone preserves structuredLocation, so clear or replace structuredLocation when the physical place changes."),
  structuredLocation: structuredLocationInputSchema.nullable().optional().describe("Set Apple structured location metadata, or null to remove it without changing the plain location. Verified coordinates enable Calendar's map preview; never guess coordinates. If only an address is known, use location instead."),
  description: z.string().max(20_000).nullable().optional().describe("Apple Calendar Notes field; null clears it."),
  url: z.url().nullable().optional().describe("Apple Calendar URL field; null clears it."),
}).strict().refine((patch) => Object.values(patch).some((value) => value !== undefined), "Provide at least one event field to update.");

function credentials(env: ToolEnv) {
  if (!env.ICLOUD_USERNAME || !env.ICLOUD_APP_PASSWORD) throw new Error("iCloud credentials are not configured.");
  if (!isIanaTimeZone(env.CALENDAR_TIME_ZONE)) throw new Error("CALENDAR_TIME_ZONE must be a valid IANA time zone.");
  return { username: env.ICLOUD_USERNAME, password: env.ICLOUD_APP_PASSWORD, defaultTimeZone: env.CALENDAR_TIME_ZONE };
}

function toolSuccess<T extends Record<string, unknown>>(output: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function toolFailure(error: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: publicError(error) }],
  };
}

export function createCalendarServer(env: ToolEnv, scopes: readonly string[] = ["calendar:read"]) {
  const server = new McpServer({ name: "apple-calendar-mcp-server", version: "0.3.1" });
  const granted = new Set(scopes);

  if (granted.has("calendar:read")) {
    server.registerTool(
      "calendar_get_profile",
      {
        title: "Get Apple Calendar account",
        description: "Return the configured iCloud Calendar account identity and default IANA time zone. Use this time zone when interpreting the user's local-time requests.",
        inputSchema: z.object({}).strict(),
        outputSchema: z.object({ profile: z.object({ email: z.string(), provider: z.literal("iCloud"), timeZone: z.string() }) }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => {
        try {
          return toolSuccess({ profile: await getAccountProfile(credentials(env)) });
        } catch (error) {
          return toolFailure(error);
        }
      },
    );

    server.registerTool(
      "calendar_list_calendars",
      {
        title: "List Apple calendars",
        description: "List calendars visible to the configured iCloud account with each calendar's effective IANA time zone. Use returned IDs in event tools.",
        inputSchema: z.object({}).strict(),
        outputSchema: z.object({ calendars: z.array(calendarSchema) }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async () => {
        try {
          return toolSuccess({ calendars: await listCalendars(credentials(env)) });
        } catch (error) {
          return toolFailure(error);
        }
      },
    );

    server.registerTool(
      "calendar_search_events",
      {
        title: "Search Apple calendar events",
        description: "Search one, several, or all visible calendars in a bounded time window. Timed results include canonical UTC start/end plus local wall-clock values and an IANA timeZone. Results include recurring instances and can be filtered by title, notes, plain or structured location, organizer, or attendee text.",
        inputSchema: z.object({
          calendarIds: z.array(z.string().min(1)).min(1).max(20).optional().describe("Omit to search every visible event calendar."),
          start: z.iso.datetime({ offset: true }),
          end: z.iso.datetime({ offset: true }),
          query: z.string().max(500).optional(),
          limit: z.number().int().min(1).max(200).default(50),
          offset: z.number().int().min(0).max(10_000).default(0),
        }).strict(),
        outputSchema: z.object({
          events: z.array(eventSchema),
          total: z.number().int().nonnegative(),
          offset: z.number().int().nonnegative(),
          hasMore: z.boolean(),
          nextOffset: z.number().int().nonnegative().optional(),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async (input) => {
        try {
          return toolSuccess({ ...(await searchEvents(credentials(env), input)) });
        } catch (error) {
          return toolFailure(error);
        }
      },
    );

    server.registerTool(
      "calendar_list_events",
      {
        title: "List Apple calendar events",
        description: "List events from one calendar in a bounded time range. Use calendar_search_events for text search or multiple calendars.",
        inputSchema: z.object({
          calendarId: z.string().min(1),
          start: z.iso.datetime({ offset: true }),
          end: z.iso.datetime({ offset: true }),
          limit: z.number().int().min(1).max(200).default(100),
        }).strict(),
        outputSchema: z.object({ events: z.array(eventSchema) }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ calendarId, start, end, limit }) => {
        try {
          return toolSuccess({ events: await listEvents(credentials(env), calendarId, start, end, limit) });
        } catch (error) {
          return toolFailure(error);
        }
      },
    );

    server.registerTool(
      "calendar_get_event",
      {
        title: "Get an Apple calendar event",
        description: "Read full event details, including canonical UTC and local times, structured Apple location metadata, attendees, recurrence, display alerts, and the ETag required for mutations.",
        inputSchema: z.object({ ...selectorSchema, recurrenceId: recurrenceIdSchema.optional() }).strict(),
        outputSchema: z.object({ event: eventSchema }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ calendarId, eventId, recurrenceId }) => {
        try {
          return toolSuccess({ event: await getEvent(credentials(env), calendarId, eventId, fetch, recurrenceId) });
        } catch (error) {
          return toolFailure(error);
        }
      },
    );

    server.registerTool(
      "calendar_batch_get_events",
      {
        title: "Read Apple calendar events in a batch",
        description: "Read up to 20 events. Each response contains the event or a per-event error.",
        inputSchema: z.object({ events: z.array(z.object(selectorSchema).strict()).min(1).max(20) }).strict(),
        outputSchema: z.object({ responses: z.array(z.object({ eventId: z.string(), event: eventSchema.optional(), error: z.string().optional() })) }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ events }) => {
        try {
          return toolSuccess({ responses: await batchGetEvents(credentials(env), events) });
        } catch (error) {
          return toolFailure(error);
        }
      },
    );

    server.registerTool(
      "calendar_get_availability",
      {
        title: "Get Apple calendar availability",
        description: "Return merged busy windows for one or more calendars without exposing event titles or descriptions.",
        inputSchema: z.object({
          calendarIds: z.array(z.string().min(1)).min(1).max(20),
          start: z.iso.datetime({ offset: true }),
          end: z.iso.datetime({ offset: true }),
        }).strict(),
        outputSchema: z.object({ calendars: z.array(z.object({ calendarId: z.string(), busy: z.array(z.object({ start: z.string(), end: z.string() })) })) }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ calendarIds, start, end }) => {
        try {
          return toolSuccess({ ...(await getAvailability(credentials(env), calendarIds, start, end)) });
        } catch (error) {
          return toolFailure(error);
        }
      },
    );
  }

  if (granted.has("calendar:write")) {
    server.registerTool(
      "calendar_create_event",
      {
        title: "Create an Apple calendar event",
        description: "Create an event. Timed start/end require explicit offsets; timeZone accepts an IANA zone, defaults to the target calendar, and keeps recurring wall-clock time stable across DST. All-day end dates are exclusive. Use structuredLocation with verified coordinates for Apple map previews; if only an address is known, use location and never guess coordinates. Alerts are delivered by Calendar according to the user's OS settings. Adding attendees may cause iCloud to send invitations.",
        inputSchema: z.object({ calendarId: z.string().min(1), ...eventDraftShape }).strict(),
        outputSchema: z.object({ event: eventSchema }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ calendarId, ...draft }) => {
        try {
          return toolSuccess({ event: await createEvent(credentials(env), calendarId, draft) });
        } catch (error) {
          return toolFailure(error);
        }
      },
    );

    server.registerTool(
      "calendar_update_event",
      {
        title: "Update an Apple calendar event",
        description: "Update one occurrence, this and later occurrences, or an entire event series after reading it. Requires the latest ETag and preserves unmodeled iCalendar fields, including attachments and unsupported alarms. Timed start/end remain canonical instants while an IANA timeZone controls wall-clock and DST semantics. Use structuredLocation only with verified coordinates; if only an address is known, use location. Attendees, display alerts, and recurrence are complete replacement lists.",
        inputSchema: z.object({ ...mutationSelectorSchema, ...recurrenceMutationShape, patch: eventPatchSchema }).strict().superRefine(requireOccurrenceId),
        outputSchema: z.object({ event: eventSchema }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ calendarId, eventId, etag, updateScope, recurrenceId, patch }) => {
        try {
          return toolSuccess({ event: await updateEvent(credentials(env), { calendarId, eventId, etag }, patch, { scope: updateScope, recurrenceId }) });
        } catch (error) {
          return toolFailure(error);
        }
      },
    );

    server.registerTool(
      "calendar_delete_event",
      {
        title: "Delete an Apple calendar event",
        description: "Delete one occurrence, this and later occurrences, or an entire event series after reading it. Requires the latest ETag and may send cancellation notices for invited events.",
        inputSchema: z.object({ ...mutationSelectorSchema, ...recurrenceMutationShape }).strict().superRefine(requireOccurrenceId),
        outputSchema: z.object({
          deleted: z.literal(true),
          eventId: z.string(),
          scope: z.enum(["entire_series", "this_instance", "this_and_following"]),
          recurrenceId: z.string().optional(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async ({ calendarId, eventId, etag, updateScope, recurrenceId }) => {
        try {
          return toolSuccess(await deleteEvent(credentials(env), { calendarId, eventId, etag }, { scope: updateScope, recurrenceId }));
        } catch (error) {
          return toolFailure(error);
        }
      },
    );

    server.registerTool(
      "calendar_respond_to_invitation",
      {
        title: "Respond to an Apple calendar invitation",
        description: "Accept, decline, or tentatively accept an invitation for the configured iCloud account. Requires the latest ETag and may notify the organizer.",
        inputSchema: z.object({ ...mutationSelectorSchema, status: z.enum(["accepted", "declined", "tentative"]) }).strict(),
        outputSchema: z.object({ event: eventSchema }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ calendarId, eventId, etag, status }) => {
        try {
          return toolSuccess({ event: await respondToInvitation(credentials(env), { calendarId, eventId, etag }, status) });
        } catch (error) {
          return toolFailure(error);
        }
      },
    );
  }

  // Reminders ride on the owner's iPhone: a Shortcut posts a snapshot and applies queued changes.
  const prioritySchema = z.enum(["none", "low", "medium", "high"]);
  const reminderSchema = z.object({
    id: z.string().describe("Stable ID derived from list, title, and due date. Changes if any of those change."),
    title: z.string(),
    list: z.string(),
    due: z.string().optional().describe("ISO 8601 instant when the reminder is due, if any."),
    priority: prioritySchema,
    flagged: z.boolean(),
    completed: z.boolean(),
    notes: z.string().optional(),
  });
  const remindersUnavailable = () =>
    new Error("Reminders are not available: the iPhone sync Shortcut has not posted a snapshot yet. Ask the owner to run the Apple Reminders Sync shortcut once.");

  if (granted.has("calendar:read")) {
    server.registerTool(
      "reminders_list",
      {
        title: "List Apple Reminders",
        description:
          "List the owner's open Apple Reminders from the latest iPhone snapshot. The snapshot is refreshed by an iOS Shortcut a few times a day and whenever the owner closes the Reminders app, so check syncedAt and ageMinutes before treating it as current. Reminders queued by reminders_create appear here only after the next sync.",
        inputSchema: z.object({
          list: z.string().max(200).optional().describe("Only reminders in this list (exact name)."),
          query: z.string().max(200).optional().describe("Case-insensitive match on title or notes."),
          dueBefore: z.string().optional().describe("ISO 8601 instant; only reminders due at or before this moment."),
          dueAfter: z.string().optional().describe("ISO 8601 instant; only reminders due at or after this moment."),
          includeUndated: z.boolean().optional().describe("Include reminders with no due date when a due filter is set. Default true."),
          limit: z.number().int().min(1).max(500).optional().describe("Maximum reminders to return. Default 200."),
        }).strict(),
        outputSchema: z.object({
          syncedAt: z.string(),
          ageMinutes: z.number().int(),
          lists: z.array(z.string()),
          total: z.number().int(),
          reminders: z.array(reminderSchema),
          pendingChanges: z.number().int().describe("Changes queued for the iPhone that have not been applied yet."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (input) => {
        try {
          if (!env.REMINDERS_KV) throw new Error("REMINDERS_KV is not bound on the Worker.");
          const snapshot = await readSnapshot(env.REMINDERS_KV);
          if (!snapshot) throw remindersUnavailable();
          const query = input.query?.trim().toLowerCase();
          const before = input.dueBefore ? new Date(input.dueBefore).getTime() : undefined;
          const after = input.dueAfter ? new Date(input.dueAfter).getTime() : undefined;
          const includeUndated = input.includeUndated ?? true;
          const reminders = snapshot.items.filter((item) => {
            if (input.list && item.list !== input.list) return false;
            if (query && !item.title.toLowerCase().includes(query) && !(item.notes ?? "").toLowerCase().includes(query)) return false;
            if (before !== undefined || after !== undefined) {
              if (!item.due) return includeUndated;
              const due = new Date(item.due).getTime();
              if (before !== undefined && due > before) return false;
              if (after !== undefined && due < after) return false;
            }
            return true;
          });
          const lists = [...new Set(snapshot.items.map((item) => item.list))].sort();
          const pending = await readCommands(env.REMINDERS_KV);
          return toolSuccess({
            syncedAt: snapshot.syncedAt,
            ageMinutes: ageMinutes(snapshot),
            lists,
            total: reminders.length,
            reminders: reminders.slice(0, input.limit ?? 200),
            pendingChanges: pending.length,
          });
        } catch (error) {
          return toolFailure(error);
        }
      },
    );

    server.registerTool(
      "reminders_pending_changes",
      {
        title: "Show reminders waiting for the iPhone",
        description: "List reminder changes that have been queued but not yet applied by the owner's iPhone. Use this to avoid queuing duplicates.",
        inputSchema: z.object({}).strict(),
        outputSchema: z.object({
          pending: z.array(z.object({
            id: z.string(),
            kind: z.literal("create"),
            queuedAt: z.string(),
            title: z.string(),
            list: z.string().optional(),
            due: z.string().optional(),
            notes: z.string().optional(),
            priority: prioritySchema.optional(),
          })),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => {
        try {
          if (!env.REMINDERS_KV) throw new Error("REMINDERS_KV is not bound on the Worker.");
          return toolSuccess({ pending: await readCommands(env.REMINDERS_KV) });
        } catch (error) {
          return toolFailure(error);
        }
      },
    );
  }

  if (granted.has("calendar:write")) {
    server.registerTool(
      "reminders_create",
      {
        title: "Create an Apple Reminder",
        description:
          "Queue a new Apple Reminder. The owner's iPhone creates it on its next sync, usually within a few hours and immediately after the owner closes the Reminders app, so tell the owner it is queued rather than created. Check reminders_pending_changes first to avoid duplicates. Use reminders_list to learn the list names; an unknown list falls back to the default list.",
        inputSchema: z.object({
          title: z.string().min(1).max(1000),
          list: z.string().max(200).optional().describe("Exact list name from reminders_list. Omit for the default list."),
          due: z.string().optional().describe("ISO 8601 date-time for the reminder's alert, in the owner's time zone or with an offset."),
          notes: z.string().max(20_000).optional(),
          priority: prioritySchema.optional(),
        }).strict(),
        outputSchema: z.object({
          queued: z.literal(true),
          id: z.string(),
          appliesOn: z.string(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async (input) => {
        try {
          if (!env.REMINDERS_KV) throw new Error("REMINDERS_KV is not bound on the Worker.");
          const command = await queueCreate(env.REMINDERS_KV, input);
          return toolSuccess({ queued: true as const, id: command.id, appliesOn: "the iPhone's next Reminders sync" });
        } catch (error) {
          return toolFailure(error);
        }
      },
    );
  }

  return server;
}

export function createCalendarMcpHandler(env: ToolEnv, scopes: readonly string[] = ["calendar:read"]) {
  const configuredHostname = normalizeConfiguredHostname(env.MCP_HOSTNAME);
  const options = {
    route: "/mcp",
    legacy: "stateless",
  } as const;
  const defaultHandler = createMcpHandler(() => createCalendarServer(env, scopes), options);
  if (!configuredHostname) return defaultHandler;

  const customDomainHandler = createMcpHandler(() => createCalendarServer(env, scopes), {
    ...options,
    allowedHostnames: [configuredHostname],
    allowedOriginHostnames: [configuredHostname],
  });

  return (request: Request, handlerEnv: Env, context: ExecutionContext) => {
    const requestHostname = new URL(request.url).hostname.toLowerCase();
    const handler = requestHostname === configuredHostname ? customDomainHandler : defaultHandler;
    return handler(request, handlerEnv, context);
  };
}
