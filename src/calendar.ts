// Provides the iCloud CalDAV operations used by the MCP, including conflict-safe event mutations.

import { createDAVClient, type DAVCalendar, type DAVCalendarObject } from "tsdav";
import {
  buildEventCalendar,
  calendarTimeZoneId,
  cancelEventOccurrence,
  type CalendarEvent,
  type EventDraft,
  type EventPatch,
  parseExpandedIcsEvents,
  parseIcsEvents,
  patchEventCalendar,
  recurringEventTimeZoneId,
  type RecurrenceMutationScope,
  respondToInvitation as patchInvitationResponse,
} from "./ical";
import { assertAppleCalDavUrl, createAppleFetch, decodeDavId, encodeDavId, publicError } from "./security";

export interface CalendarSummary {
  id: string;
  name: string;
  color?: string;
  description?: string;
  components: string[];
  timeZone: string;
}

export interface AccountProfile {
  email: string;
  provider: "iCloud";
  timeZone: string;
}

export interface EventSearchResult {
  events: CalendarEvent[];
  total: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
}

export interface AvailabilityResult {
  calendars: Array<{
    calendarId: string;
    busy: Array<{ start: string; end: string }>;
  }>;
}

export interface BatchEventResult {
  eventId: string;
  event?: CalendarEvent;
  error?: string;
}

export interface Credentials {
  username: string;
  password: string;
  defaultTimeZone: string;
}

interface EventSelector {
  calendarId: string;
  eventId: string;
}

interface EventMutationSelector extends EventSelector {
  etag: string;
}

interface RecurrenceMutationTarget {
  scope?: RecurrenceMutationScope | undefined;
  recurrenceId?: string | undefined;
}

interface EventSearchOptions {
  calendarIds?: string[] | undefined;
  start: string;
  end: string;
  query?: string | undefined;
  limit: number;
  offset: number;
}

const MAX_QUERY_RANGE_MS = 1000 * 60 * 60 * 24 * 366;

function createClient(credentials: Credentials, baseFetch: typeof fetch = fetch) {
  return createDAVClient({
    serverUrl: "https://caldav.icloud.com",
    credentials: { username: credentials.username, password: credentials.password },
    authMethod: "Basic",
    defaultAccountType: "caldav",
    fetch: createAppleFetch(baseFetch),
  });
}

async function getCalendars(credentials: Credentials, baseFetch: typeof fetch = fetch) {
  const client = await createClient(credentials, baseFetch);
  const calendars = await client.fetchCalendars();
  for (const calendar of calendars) assertAppleCalDavUrl(calendar.url);
  return { client, calendars };
}

function requireDiscoveredCalendar(calendars: DAVCalendar[], calendarId: string): DAVCalendar {
  const requestedUrl = decodeDavId(calendarId);
  const calendar = calendars.find((candidate) => new URL(candidate.url).href === requestedUrl);
  if (!calendar) throw new Error("Calendar identifier is no longer available.");
  if (calendar.components && !calendar.components.includes("VEVENT")) throw new Error("This calendar does not contain events.");
  return calendar;
}

function requireEventUrl(calendar: DAVCalendar, eventId: string): string {
  const requestedUrl = decodeDavId(eventId);
  if (!requestedUrl.startsWith(new URL(calendar.url).href) || !new URL(requestedUrl).pathname.endsWith(".ics")) {
    throw new Error("Event does not belong to this calendar.");
  }
  return requestedUrl;
}

function requireTimeRange(start: string, end: string): { start: string; end: string } {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || startDate >= endDate) {
    throw new Error("start and end must be valid ISO timestamps with start before end.");
  }
  if (endDate.getTime() - startDate.getTime() > MAX_QUERY_RANGE_MS) throw new Error("Event queries are limited to 366 days.");
  return { start: startDate.toISOString(), end: endDate.toISOString() };
}

function calendarTimeZone(calendar: DAVCalendar, fallback: string): string {
  return calendarTimeZoneId(calendar.timezone) ?? fallback;
}

function eventFromObject(object: DAVCalendarObject, calendarId: string, username: string, defaultTimeZone: string): CalendarEvent[] {
  if (typeof object.data !== "string") return [];
  return parseIcsEvents(object.data, {
    calendarId,
    eventId: encodeDavId(object.url),
    selfEmail: username,
    defaultTimeZone,
    ...(object.etag ? { etag: object.etag } : {}),
  });
}

async function fetchEventsForCalendar(
  client: Awaited<ReturnType<typeof createClient>>,
  calendar: DAVCalendar,
  calendarId: string,
  username: string,
  fallbackTimeZone: string,
  range: { start: string; end: string },
): Promise<CalendarEvent[]> {
  const calendarUrl = new URL(calendar.url).href;
  const objects = await client.fetchCalendarObjects({
    calendar,
    timeRange: range,
    expand: true,
    useMultiGet: false,
    urlFilter: (url) => {
      try {
        const eventUrl = assertAppleCalDavUrl(url);
        return eventUrl.href.startsWith(calendarUrl) && eventUrl.pathname.endsWith(".ics");
      } catch {
        return false;
      }
    },
  });
  const defaultTimeZone = calendarTimeZone(calendar, fallbackTimeZone);
  const objectUrls = objects.flatMap((object) => typeof object.data === "string" && /^RECURRENCE-ID[;:]/mi.test(object.data)
    ? [new URL(object.url).href]
    : []);
  const originals = objectUrls.length > 0
    ? await client.fetchCalendarObjects({
      calendar,
      objectUrls,
      useMultiGet: true,
      urlFilter: (url) => objectUrls.includes(new URL(url).href),
    })
    : [];
  const originalsByPath = new Map(originals.flatMap((object) => typeof object.data === "string"
    ? [[new URL(object.url).pathname, object.data] as const]
    : []));
  return objects.flatMap((object) => parseCalendarObjectSafely(object, {
    calendarId,
    username,
    defaultTimeZone,
    originalData: originalsByPath.get(new URL(object.url).pathname),
  }));
}

// Parses one CalDAV object into events. A single malformed object must never fail a whole window,
// so parse errors are logged by identifier only and the object is skipped.
export function parseCalendarObjectSafely(
  object: Pick<DAVCalendarObject, "url" | "data" | "etag">,
  options: { calendarId: string; username: string; defaultTimeZone: string; originalData?: string | undefined },
): CalendarEvent[] {
  if (typeof object.data !== "string") return [];
  const context = {
    calendarId: options.calendarId,
    eventId: encodeDavId(object.url),
    selfEmail: options.username,
    defaultTimeZone: options.defaultTimeZone,
    ...(object.etag ? { etag: object.etag } : {}),
  };
  try {
    const recurringTimeZone = recurringEventTimeZoneId(options.originalData, options.defaultTimeZone);
    return options.originalData && recurringTimeZone
      ? parseExpandedIcsEvents(object.data, options.originalData, context, recurringTimeZone)
      : parseIcsEvents(object.data, context);
  } catch (error) {
    console.warn("event_parse_skipped", { calendarId: options.calendarId, eventId: context.eventId, reason: publicError(error) });
    return [];
  }
}

async function loadEventObject(
  credentials: Credentials,
  selector: EventSelector,
  baseFetch: typeof fetch = fetch,
): Promise<{
  calendar: DAVCalendar;
  client: Awaited<ReturnType<typeof createClient>>;
  object: DAVCalendarObject;
}> {
  const { client, calendars } = await getCalendars(credentials, baseFetch);
  const calendar = requireDiscoveredCalendar(calendars, selector.calendarId);
  const requestedUrl = requireEventUrl(calendar, selector.eventId);
  const objects = await client.fetchCalendarObjects({
    calendar,
    objectUrls: [requestedUrl],
    useMultiGet: true,
    urlFilter: (url) => new URL(url).href === requestedUrl,
  });
  const object = objects.find((candidate) => new URL(candidate.url).href === requestedUrl);
  if (!object || typeof object.data !== "string") throw new Error("Event was not found.");
  return { calendar, client, object };
}

function requireMatchingEtag(object: DAVCalendarObject, expectedEtag: string): void {
  if (!object.etag) throw new Error("Apple did not return an ETag for this event; the write was stopped.");
  if (object.etag !== expectedEtag) throw new Error("The event changed since it was read. Read it again before retrying the write.");
}

function requireDavSuccess(response: Response, action: string): void {
  if (response.ok) return;
  if (response.status === 409 || response.status === 412) throw new Error(`The event changed before ${action}. Read it again and retry.`);
  if (response.status === 401) throw new Error("iCloud rejected the app-specific password.");
  if (response.status === 403) throw new Error(`iCloud does not allow ${action} in this calendar.`);
  if (response.status === 404) throw new Error("The event or calendar no longer exists.");
  throw new Error(`iCloud could not ${action} the event (HTTP ${response.status}).`);
}

function primaryEvent(events: CalendarEvent[]): CalendarEvent {
  const event = events.find((candidate) => !candidate.recurrenceId) ?? events[0];
  if (!event) throw new Error("Calendar object does not contain an event.");
  return event;
}

function selectedEvent(events: CalendarEvent[], recurrenceId?: string): CalendarEvent {
  if (!recurrenceId) return primaryEvent(events);
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(recurrenceId);
  const target = allDay ? recurrenceId : new Date(recurrenceId).toISOString();
  const event = events.find((candidate) => candidate.recurrenceId === target);
  if (!event) throw new Error("The requested recurring occurrence was not found.");
  return event;
}

export async function getAccountProfile(credentials: Credentials): Promise<AccountProfile> {
  return { email: credentials.username, provider: "iCloud", timeZone: credentials.defaultTimeZone };
}

export async function listCalendars(credentials: Credentials, baseFetch: typeof fetch = fetch): Promise<CalendarSummary[]> {
  const { calendars } = await getCalendars(credentials, baseFetch);
  return calendars.map((calendar) => ({
    id: encodeDavId(calendar.url),
    name: typeof calendar.displayName === "string" && calendar.displayName ? calendar.displayName : "Untitled calendar",
    components: calendar.components ?? [],
    timeZone: calendarTimeZone(calendar, credentials.defaultTimeZone),
    ...(calendar.calendarColor ? { color: calendar.calendarColor } : {}),
    ...(calendar.description ? { description: calendar.description } : {}),
  }));
}

export async function searchEvents(
  credentials: Credentials,
  options: EventSearchOptions,
  baseFetch: typeof fetch = fetch,
): Promise<EventSearchResult> {
  const range = requireTimeRange(options.start, options.end);
  const { client, calendars } = await getCalendars(credentials, baseFetch);
  const targets = options.calendarIds?.length
    ? options.calendarIds.map((calendarId) => ({ calendarId, calendar: requireDiscoveredCalendar(calendars, calendarId) }))
    : calendars.filter((calendar) => !calendar.components || calendar.components.includes("VEVENT")).map((calendar) => ({ calendarId: encodeDavId(calendar.url), calendar }));
  const eventGroups = await Promise.all(targets.map(({ calendar, calendarId }) => fetchEventsForCalendar(client, calendar, calendarId, credentials.username, credentials.defaultTimeZone, range)));
  const query = options.query?.trim().toLowerCase();
  const matches = eventGroups
    .flat()
    .filter((event) => !query || [event.title, event.description, event.location, event.structuredLocation?.title, event.structuredLocation?.address, event.organizer?.email, ...event.attendees.flatMap((attendee) => [attendee.name, attendee.email])].some((value) => value?.toLowerCase().includes(query)))
    .sort((left, right) => left.start.localeCompare(right.start));
  const events = matches.slice(options.offset, options.offset + options.limit);
  const hasMore = options.offset + events.length < matches.length;
  return {
    events,
    total: matches.length,
    offset: options.offset,
    hasMore,
    ...(hasMore ? { nextOffset: options.offset + events.length } : {}),
  };
}

export async function listEvents(
  credentials: Credentials,
  calendarId: string,
  start: string,
  end: string,
  limit: number,
  baseFetch: typeof fetch = fetch,
): Promise<CalendarEvent[]> {
  const result = await searchEvents(credentials, { calendarIds: [calendarId], start, end, limit, offset: 0 }, baseFetch);
  return result.events;
}

export async function getEvent(
  credentials: Credentials,
  calendarId: string,
  eventId: string,
  baseFetch: typeof fetch = fetch,
  recurrenceId?: string,
): Promise<CalendarEvent> {
  const { calendar, object } = await loadEventObject(credentials, { calendarId, eventId }, baseFetch);
  return selectedEvent(eventFromObject(object, calendarId, credentials.username, calendarTimeZone(calendar, credentials.defaultTimeZone)), recurrenceId);
}

export async function batchGetEvents(
  credentials: Credentials,
  selectors: EventSelector[],
  baseFetch: typeof fetch = fetch,
): Promise<BatchEventResult[]> {
  const { client, calendars } = await getCalendars(credentials, baseFetch);
  const prepared = selectors.map((selector) => {
    try {
      const calendar = requireDiscoveredCalendar(calendars, selector.calendarId);
      return { selector, calendar, url: requireEventUrl(calendar, selector.eventId) };
    } catch (error) {
      return { selector, error: publicError(error) };
    }
  });
  const groups = new Map<string, { calendar: DAVCalendar; urls: string[] }>();
  for (const item of prepared) {
    if (!("url" in item) || !item.url || !item.calendar) continue;
    const group = groups.get(item.selector.calendarId) ?? { calendar: item.calendar, urls: [] };
    if (!group.urls.includes(item.url)) group.urls.push(item.url);
    groups.set(item.selector.calendarId, group);
  }
  const objectsByUrl = new Map<string, DAVCalendarObject>();
  await Promise.all([...groups.values()].map(async ({ calendar, urls }) => {
    const objects = await client.fetchCalendarObjects({
      calendar,
      objectUrls: urls,
      useMultiGet: true,
      urlFilter: (url) => urls.includes(new URL(url).href),
    });
    for (const object of objects) objectsByUrl.set(new URL(object.url).href, object);
  }));
  return prepared.map((item) => {
    if (!("url" in item) || !item.url) return { eventId: item.selector.eventId, error: item.error ?? "Invalid event selector." };
    const object = objectsByUrl.get(item.url);
    if (!object) return { eventId: item.selector.eventId, error: "Event was not found." };
    try {
      return { eventId: item.selector.eventId, event: primaryEvent(eventFromObject(object, item.selector.calendarId, credentials.username, calendarTimeZone(item.calendar, credentials.defaultTimeZone))) };
    } catch (error) {
      return { eventId: item.selector.eventId, error: publicError(error) };
    }
  });
}

function mergeBusyWindows(events: CalendarEvent[]): Array<{ start: string; end: string }> {
  const windows = events
    .filter((event) => event.availability === "busy" && event.status !== "cancelled")
    .map(({ start, end }) => ({ start, end }))
    .sort((left, right) => left.start.localeCompare(right.start));
  const merged: Array<{ start: string; end: string }> = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous && window.start <= previous.end) previous.end = previous.end > window.end ? previous.end : window.end;
    else merged.push({ ...window });
  }
  return merged;
}

export async function getAvailability(
  credentials: Credentials,
  calendarIds: string[],
  start: string,
  end: string,
  baseFetch: typeof fetch = fetch,
): Promise<AvailabilityResult> {
  const range = requireTimeRange(start, end);
  const { client, calendars } = await getCalendars(credentials, baseFetch);
  const results = await Promise.all(calendarIds.map(async (calendarId) => {
    const calendar = requireDiscoveredCalendar(calendars, calendarId);
    const events = await fetchEventsForCalendar(client, calendar, calendarId, credentials.username, credentials.defaultTimeZone, range);
    return { calendarId, busy: mergeBusyWindows(events) };
  }));
  return { calendars: results };
}

export async function createEvent(
  credentials: Credentials,
  calendarId: string,
  draft: EventDraft,
  baseFetch: typeof fetch = fetch,
): Promise<CalendarEvent> {
  const { client, calendars } = await getCalendars(credentials, baseFetch);
  const calendar = requireDiscoveredCalendar(calendars, calendarId);
  const built = buildEventCalendar(draft, credentials.username, {
    defaultTimeZone: credentials.defaultTimeZone,
    ...(calendar.timezone ? { timeZoneData: calendar.timezone } : {}),
  });
  const response = await client.createCalendarObject({ calendar, iCalString: built.data, filename: built.filename });
  requireDavSuccess(response, "create");
  const eventId = encodeDavId(new URL(built.filename, calendar.url).href);
  return getEvent(credentials, calendarId, eventId, baseFetch);
}

export async function updateEvent(
  credentials: Credentials,
  selector: EventMutationSelector,
  patch: EventPatch,
  target: RecurrenceMutationTarget = {},
  baseFetch: typeof fetch = fetch,
): Promise<CalendarEvent> {
  const { calendar, client, object } = await loadEventObject(credentials, selector, baseFetch);
  requireMatchingEtag(object, selector.etag);
  const scope = target.scope ?? "entire_series";
  object.data = patchEventCalendar(String(object.data), patch, credentials.username, new Date(), scope, target.recurrenceId, {
    defaultTimeZone: credentials.defaultTimeZone,
    ...(calendar.timezone ? { timeZoneData: calendar.timezone } : {}),
  });
  const response = await client.updateCalendarObject({ calendarObject: object });
  requireDavSuccess(response, "update");
  return getEvent(credentials, selector.calendarId, selector.eventId, baseFetch, scope === "entire_series" ? undefined : target.recurrenceId);
}

export async function deleteEvent(
  credentials: Credentials,
  selector: EventMutationSelector,
  target: RecurrenceMutationTarget = {},
  baseFetch: typeof fetch = fetch,
): Promise<{ deleted: true; eventId: string; scope: RecurrenceMutationScope; recurrenceId?: string }> {
  const { client, object } = await loadEventObject(credentials, selector, baseFetch);
  requireMatchingEtag(object, selector.etag);
  const scope = target.scope ?? "entire_series";
  const response = scope === "entire_series"
    ? await client.deleteCalendarObject({ calendarObject: object })
    : await client.updateCalendarObject({
      calendarObject: {
        ...object,
        data: cancelEventOccurrence(String(object.data), target.recurrenceId ?? "", scope),
      },
    });
  requireDavSuccess(response, "delete");
  return {
    deleted: true,
    eventId: selector.eventId,
    scope,
    ...(target.recurrenceId ? { recurrenceId: target.recurrenceId } : {}),
  };
}

export async function respondToInvitation(
  credentials: Credentials,
  selector: EventMutationSelector,
  status: "accepted" | "declined" | "tentative",
  baseFetch: typeof fetch = fetch,
): Promise<CalendarEvent> {
  const { client, object } = await loadEventObject(credentials, selector, baseFetch);
  requireMatchingEtag(object, selector.etag);
  object.data = patchInvitationResponse(String(object.data), credentials.username, status);
  const response = await client.updateCalendarObject({ calendarObject: object });
  requireDavSuccess(response, "respond to");
  return getEvent(credentials, selector.calendarId, selector.eventId, baseFetch);
}
