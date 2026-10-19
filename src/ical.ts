// Parses, creates, and patches iCalendar data while preserving fields the MCP does not explicitly model.

import ICAL from "ical.js";
import { tzlib_get_ical_block } from "timezones-ical-library";

export type AttendanceStatus = "needs-action" | "accepted" | "declined" | "tentative" | "delegated";
export type EventAvailability = "busy" | "free";
export type EventStatus = "confirmed" | "tentative" | "cancelled";
export type RecurrenceMutationScope = "entire_series" | "this_instance" | "this_and_following";

export interface EventAttendee {
  email: string;
  name?: string;
  role?: "required" | "optional" | "chair" | "non-participant";
  status: AttendanceStatus;
  isSelf: boolean;
}

export interface EventOrganizer {
  email: string;
  name?: string;
}

export interface EventReminder {
  action: "display" | "email" | "audio";
  minutesBefore: number;
  description?: string;
}

export interface StructuredLocation {
  title?: string | undefined;
  address?: string | undefined;
  latitude: number;
  longitude: number;
  radius?: number | undefined;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  uid: string;
  title: string;
  start: string;
  end: string;
  timeZone?: string;
  startLocal?: string;
  endLocal?: string;
  allDay: boolean;
  availability: EventAvailability;
  status: EventStatus;
  attendees: EventAttendee[];
  reminders: EventReminder[];
  recurrence: string[];
  location?: string;
  structuredLocation?: StructuredLocation;
  description?: string;
  url?: string;
  color?: string;
  organizer?: EventOrganizer;
  recurrenceId?: string;
  sequence?: number;
  created?: string;
  updated?: string;
  etag?: string;
}

export interface EventAttendeeInput {
  email: string;
  name?: string | undefined;
  role?: "required" | "optional" | "chair" | "non-participant" | undefined;
}

export interface EventReminderInput {
  minutesBefore: number;
  description?: string | undefined;
}

export interface EventDraft {
  title: string;
  start: string;
  end: string;
  timeZone?: string | undefined;
  allDay?: boolean | undefined;
  availability?: EventAvailability | undefined;
  status?: EventStatus | undefined;
  attendees?: EventAttendeeInput[] | undefined;
  reminders?: EventReminderInput[] | undefined;
  recurrence?: string[] | undefined;
  location?: string | undefined;
  structuredLocation?: StructuredLocation | undefined;
  description?: string | undefined;
  url?: string | undefined;
}

export interface EventPatch {
  title?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  timeZone?: string | undefined;
  allDay?: boolean | undefined;
  availability?: EventAvailability | undefined;
  status?: EventStatus | undefined;
  attendees?: EventAttendeeInput[] | null | undefined;
  reminders?: EventReminderInput[] | null | undefined;
  recurrence?: string[] | null | undefined;
  location?: string | null | undefined;
  structuredLocation?: StructuredLocation | null | undefined;
  description?: string | null | undefined;
  url?: string | null | undefined;
}

interface ParseContext {
  calendarId: string;
  eventId: string;
  selfEmail: string;
  etag?: string;
  defaultTimeZone?: string;
}

interface BuildOptions {
  now?: Date;
  uid?: string;
  defaultTimeZone?: string;
  timeZoneData?: string;
}

interface PatchOptions {
  defaultTimeZone?: string;
  timeZoneData?: string;
}

const roleFromIcal = {
  "REQ-PARTICIPANT": "required",
  "OPT-PARTICIPANT": "optional",
  CHAIR: "chair",
  "NON-PARTICIPANT": "non-participant",
} as const;

const roleToIcal = {
  required: "REQ-PARTICIPANT",
  optional: "OPT-PARTICIPANT",
  chair: "CHAIR",
  "non-participant": "NON-PARTICIPANT",
} as const;

const statusFromIcal: Record<string, AttendanceStatus> = {
  "NEEDS-ACTION": "needs-action",
  ACCEPTED: "accepted",
  DECLINED: "declined",
  TENTATIVE: "tentative",
  DELEGATED: "delegated",
};

function normalizeEmail(value: string): string {
  return value.replace(/^mailto:/i, "").trim().toLowerCase();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function isIanaTimeZone(value: string | undefined): value is string {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return value.includes("/") || value === "UTC";
  } catch {
    return false;
  }
}

function timeZoneComponents(data: string | undefined): ICAL.Component[] {
  if (!data) return [];
  try {
    const root = ICAL.Component.fromString(data);
    return root.name === "vtimezone" ? [root] : root.getAllSubcomponents("vtimezone");
  } catch {
    return [];
  }
}

export function calendarTimeZoneId(data: string | undefined): string | undefined {
  for (const component of timeZoneComponents(data)) {
    const candidates = [
      stringValue(component.getFirstPropertyValue("tzid")),
      stringValue(component.getFirstPropertyValue("x-lic-location")),
    ];
    const match = candidates.find(isIanaTimeZone);
    if (match) return match;
  }
  return undefined;
}

export function recurringEventTimeZoneId(data: string | undefined, fallback: string): string | undefined {
  if (!data) return undefined;
  try {
    const root = ICAL.Component.fromString(data);
    const component = primaryEvent(root);
    if (!new ICAL.Event(component).isRecurring()) return undefined;
    const property = component.getFirstProperty("dtstart");
    const parameter = stringValue(property?.getFirstParameter("tzid"));
    if (isIanaTimeZone(parameter)) return parameter;
    const embeddedTimeZone = calendarTimeZoneId(data);
    if (embeddedTimeZone) return embeddedTimeZone;
    const value = property?.getFirstValue();
    if (value instanceof ICAL.Time && value.zone.tzid === "UTC") return "UTC";
    return isIanaTimeZone(fallback) ? fallback : undefined;
  } catch {
    return undefined;
  }
}

function matchingTimeZoneComponent(data: string | undefined, timeZone: string): ICAL.Component | undefined {
  return timeZoneComponents(data).find((component) => {
    const tzid = stringValue(component.getFirstPropertyValue("tzid"));
    const location = stringValue(component.getFirstPropertyValue("x-lic-location"));
    return tzid === timeZone || location === timeZone;
  });
}

function libraryTimeZoneComponent(timeZone: string): ICAL.Component | undefined {
  const result = tzlib_get_ical_block(timeZone);
  if (!Array.isArray(result) || !result[0]) return undefined;
  return timeZoneComponents(result[0])[0];
}

function formatLocalTime(value: ICAL.Time, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(value.toUnixTime() * 1000));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? "";
  const offsetName = part("timeZoneName");
  const offset = offsetName === "GMT" ? "+00:00" : offsetName.replace(/^GMT/, "");
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}${offset}`;
}

function formatTime(value: ICAL.Time): string {
  if (value.isDate) {
    return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
  }
  return new Date(value.toUnixTime() * 1000).toISOString();
}

function eventTimeZone(component: ICAL.Component, context: ParseContext): string | undefined {
  const property = component.getFirstProperty("dtstart");
  const propertyTimeZone = stringValue(property?.getFirstParameter("tzid"));
  if (isIanaTimeZone(propertyTimeZone)) return propertyTimeZone;
  return isIanaTimeZone(context.defaultTimeZone) ? context.defaultTimeZone : undefined;
}

function parseTimeProperty(component: ICAL.Component, name: string): string | undefined {
  const value = component.getFirstPropertyValue(name);
  return value instanceof ICAL.Time ? formatTime(value) : undefined;
}

function parseAttendee(property: ICAL.Property, selfEmail: string): EventAttendee | undefined {
  const rawEmail = stringValue(property.getFirstValue());
  if (!rawEmail) return undefined;
  const email = normalizeEmail(rawEmail);
  const role = roleFromIcal[String(property.getFirstParameter("role") ?? "REQ-PARTICIPANT").toUpperCase() as keyof typeof roleFromIcal] ?? "required";
  const status = statusFromIcal[String(property.getFirstParameter("partstat") ?? "NEEDS-ACTION").toUpperCase()] ?? "needs-action";
  const name = stringValue(property.getFirstParameter("cn"));
  return {
    email,
    role,
    status,
    isSelf: email === normalizeEmail(selfEmail),
    ...(name ? { name } : {}),
  };
}

function parseOrganizer(component: ICAL.Component): EventOrganizer | undefined {
  const property = component.getFirstProperty("organizer");
  const rawEmail = stringValue(property?.getFirstValue());
  if (!property || !rawEmail) return undefined;
  const name = stringValue(property.getFirstParameter("cn"));
  return { email: normalizeEmail(rawEmail), ...(name ? { name } : {}) };
}

function parseReminder(component: ICAL.Component): EventReminder | undefined {
  const trigger = component.getFirstPropertyValue("trigger");
  if (!(trigger instanceof ICAL.Duration) || !trigger.isNegative) return undefined;
  const actionValue = String(component.getFirstPropertyValue("action") ?? "DISPLAY").toLowerCase();
  const action = actionValue === "email" || actionValue === "audio" ? actionValue : "display";
  const description = stringValue(component.getFirstPropertyValue("description"));
  return {
    action,
    minutesBefore: Math.max(0, Math.round(Math.abs(trigger.toSeconds()) / 60)),
    ...(description ? { description } : {}),
  };
}

function parseRecurrence(component: ICAL.Component): string[] {
  return ["rrule", "rdate", "exdate"].flatMap((name) => component.getAllProperties(name).map((property) => property.toICALString().replace(/\r?\n[ \t]/g, "")));
}

function numberParameter(property: ICAL.Property, name: string): number | undefined {
  const value = Number(property.getFirstParameter(name));
  return Number.isFinite(value) ? value : undefined;
}

function parseStructuredLocation(component: ICAL.Component): StructuredLocation | undefined {
  const property = component.getFirstProperty("x-apple-structured-location");
  const value = stringValue(property?.getFirstValue());
  if (!property || !value) return undefined;
  const match = /^geo:([-+]?\d+(?:\.\d+)?),([-+]?\d+(?:\.\d+)?)/i.exec(value);
  if (!match?.[1] || !match[2]) return undefined;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  const title = stringValue(property.getFirstParameter("x-title"));
  const address = stringValue(property.getFirstParameter("x-address"));
  const radius = numberParameter(property, "x-apple-radius");
  return {
    latitude,
    longitude,
    ...(title ? { title } : {}),
    ...(address ? { address } : {}),
    ...(radius !== undefined ? { radius } : {}),
  };
}

function parseEventComponent(component: ICAL.Component, context: ParseContext): CalendarEvent {
  const event = new ICAL.Event(component);
  const start = formatTime(event.startDate);
  const end = formatTime(event.endDate);
  const timeZone = event.startDate.isDate ? undefined : eventTimeZone(component, context);
  const location = stringValue(component.getFirstPropertyValue("location"));
  const description = stringValue(component.getFirstPropertyValue("description"));
  const url = stringValue(component.getFirstPropertyValue("url"));
  const color = stringValue(component.getFirstPropertyValue("color"));
  const recurrenceId = parseTimeProperty(component, "recurrence-id");
  const created = parseTimeProperty(component, "created");
  const updated = parseTimeProperty(component, "last-modified") ?? parseTimeProperty(component, "dtstamp");
  const sequenceValue = component.getFirstPropertyValue("sequence");
  const organizer = parseOrganizer(component);
  const structuredLocation = parseStructuredLocation(component);
  const transparency = String(component.getFirstPropertyValue("transp") ?? "OPAQUE").toUpperCase();
  const statusValue = String(component.getFirstPropertyValue("status") ?? "CONFIRMED").toLowerCase();
  const status: EventStatus = statusValue === "tentative" || statusValue === "cancelled" ? statusValue : "confirmed";
  return {
    id: context.eventId,
    calendarId: context.calendarId,
    uid: event.uid,
    title: event.summary || "Untitled event",
    start,
    end,
    ...(timeZone ? { timeZone, startLocal: formatLocalTime(event.startDate, timeZone), endLocal: formatLocalTime(event.endDate, timeZone) } : {}),
    allDay: event.startDate.isDate,
    availability: transparency === "TRANSPARENT" ? "free" : "busy",
    status,
    attendees: component.getAllProperties("attendee").map((property) => parseAttendee(property, context.selfEmail)).filter((attendee): attendee is EventAttendee => Boolean(attendee)),
    reminders: component.getAllSubcomponents("valarm").map(parseReminder).filter((reminder): reminder is EventReminder => Boolean(reminder)),
    recurrence: parseRecurrence(component),
    ...(location ? { location } : {}),
    ...(structuredLocation ? { structuredLocation } : {}),
    ...(description ? { description } : {}),
    ...(url ? { url } : {}),
    ...(color ? { color } : {}),
    ...(organizer ? { organizer } : {}),
    ...(recurrenceId ? { recurrenceId } : {}),
    ...(typeof sequenceValue === "number" ? { sequence: sequenceValue } : {}),
    ...(created ? { created } : {}),
    ...(updated ? { updated } : {}),
    ...(context.etag ? { etag: context.etag } : {}),
  };
}

export function parseIcsEvents(data: string, context: ParseContext): CalendarEvent[] {
  const root = ICAL.Component.fromString(data);
  return root.getAllSubcomponents("vevent").map((component) => parseEventComponent(component, context));
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Parses either a plain date or a timestamp to epoch milliseconds, or NaN when it is neither.
function instantOf(value: string | undefined): number {
  if (!value) return Number.NaN;
  return new Date(DATE_ONLY.test(value) ? `${value}T00:00:00Z` : value).getTime();
}

// Derives an occurrence's end from the master's duration. iCloud's expansion occasionally mixes
// date and date-time forms, so every step is guarded and the occurrence's own end is the fallback
// rather than a thrown "Invalid time value".
function expandedOccurrenceEnd(event: CalendarEvent, start: string): string {
  const duration = instantOf(event.end) - instantOf(event.start);
  const startInstant = instantOf(start);
  if (!Number.isFinite(duration) || !Number.isFinite(startInstant)) return event.end;
  const end = new Date(startInstant + duration);
  return event.allDay ? end.toISOString().slice(0, 10) : end.toISOString();
}

// Picks the start for an expanded occurrence. The RECURRENCE-ID carries the true instant for timed
// series (iCloud's expanded DTSTART can drift across DST), but an all-day series must keep a plain
// date, so a date-time RECURRENCE-ID falls back to the occurrence's own DTSTART.
function expandedOccurrenceStart(event: CalendarEvent, exception: CalendarEvent | undefined): string {
  if (exception?.start) return exception.start;
  const recurrenceId = event.recurrenceId ?? event.start;
  if (event.allDay) return DATE_ONLY.test(recurrenceId) ? recurrenceId : event.start;
  return Number.isFinite(instantOf(recurrenceId)) ? recurrenceId : event.start;
}

export function parseExpandedIcsEvents(data: string, sourceData: string, context: ParseContext, sourceTimeZone?: string): CalendarEvent[] {
  const expanded = parseIcsEvents(data, context);
  const source = parseIcsEvents(sourceData, context);
  const master = source.find((event) => !event.recurrenceId);
  const exceptions = new Map(source.flatMap((event) => event.recurrenceId ? [[event.recurrenceId, event] as const] : []));
  return expanded.map((event) => {
    if (!event.recurrenceId) return event;
    const exception = exceptions.get(event.recurrenceId);
    const start = expandedOccurrenceStart(event, exception);
    const end = exception?.end ?? expandedOccurrenceEnd(event, start);
    const timeZone = sourceTimeZone ?? exception?.timeZone ?? master?.timeZone ?? event.timeZone;
    return {
      ...event,
      start,
      end,
      ...(timeZone && !event.allDay ? {
        timeZone,
        startLocal: formatLocalTime(ICAL.Time.fromJSDate(new Date(start), true), timeZone),
        endLocal: formatLocalTime(ICAL.Time.fromJSDate(new Date(end), true), timeZone),
      } : {}),
    };
  });
}

function parseInputTime(value: string, allDay: boolean, zone?: ICAL.Timezone): ICAL.Time {
  if (allDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("All-day event times must use YYYY-MM-DD dates.");
    return ICAL.Time.fromDateString(value);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error("Timed events require RFC3339 timestamps with Z or an explicit UTC offset.");
  }
  const utc = ICAL.Time.fromJSDate(date, true);
  return zone ? utc.convertToZone(zone) : utc;
}

function validateTimeRange(start: string, end: string, allDay: boolean, zone?: ICAL.Timezone): { start: ICAL.Time; end: ICAL.Time } {
  const startTime = parseInputTime(start, allDay, zone);
  const endTime = parseInputTime(end, allDay, zone);
  if (endTime.toUnixTime() <= startTime.toUnixTime()) throw new Error("Event end must be after event start.");
  return { start: startTime, end: endTime };
}

function attachTimeZone(root: ICAL.Component, data: string | undefined, timeZone: string | undefined): ICAL.Timezone | undefined {
  if (!timeZone) return undefined;
  if (timeZone === "UTC") return ICAL.Timezone.utcTimezone;
  const existing = root.getTimeZoneByID(timeZone);
  if (existing) return existing;
  const source = matchingTimeZoneComponent(data, timeZone) ?? libraryTimeZoneComponent(timeZone);
  if (!source) return undefined;
  const component = new ICAL.Component(structuredClone(source.toJSON()));
  root.addSubcomponent(component);
  return root.getTimeZoneByID(String(component.getFirstPropertyValue("tzid")));
}

function addAttendee(
  component: ICAL.Component,
  attendee: EventAttendeeInput,
  participation?: { status?: string | undefined; rsvp?: string | undefined },
): void {
  const property = new ICAL.Property("attendee");
  property.setValue(`mailto:${normalizeEmail(attendee.email)}`);
  property.setParameter("role", roleToIcal[attendee.role ?? "required"]);
  property.setParameter("partstat", participation?.status ?? "NEEDS-ACTION");
  property.setParameter("rsvp", participation?.rsvp ?? "TRUE");
  if (attendee.name) property.setParameter("cn", attendee.name);
  component.addProperty(property);
}

function addReminder(component: ICAL.Component, reminder: EventReminderInput, title: string): void {
  const alarm = new ICAL.Component("valarm");
  alarm.addPropertyWithValue("action", "DISPLAY");
  alarm.addPropertyWithValue("trigger", ICAL.Duration.fromData({ minutes: reminder.minutesBefore, isNegative: true }));
  alarm.addPropertyWithValue("description", reminder.description ?? title);
  component.addSubcomponent(alarm);
}

function addRecurrence(component: ICAL.Component, recurrence: string[]): void {
  for (const line of recurrence) {
    if (!/^(?:RRULE|RDATE|EXDATE)(?:;[^:\r\n]+)?:[^\r\n]+$/i.test(line)) {
      throw new Error("Recurrence entries must be complete RRULE, RDATE, or EXDATE lines.");
    }
    component.addProperty(ICAL.Property.fromString(line));
  }
}

function setOptionalText(component: ICAL.Component, name: string, value: string | null | undefined): void {
  if (value === undefined) return;
  if (value === null || value === "") component.removeAllProperties(name);
  else component.updatePropertyWithValue(name, value);
}

function setStructuredLocation(component: ICAL.Component, value: StructuredLocation | null | undefined): void {
  if (value === undefined) return;
  component.removeAllProperties("x-apple-structured-location");
  if (value === null) return;
  const parameters: Record<string, string> = {};
  if (value.address) parameters["x-address"] = value.address;
  if (value.radius !== undefined) parameters["x-apple-radius"] = String(value.radius);
  if (value.title) parameters["x-title"] = value.title;
  component.addProperty(new ICAL.Property([
    "x-apple-structured-location",
    parameters,
    "uri",
    `geo:${value.latitude},${value.longitude}`,
  ]));
}

function setAttendees(component: ICAL.Component, attendees: EventAttendeeInput[], selfEmail: string): void {
  const participationByEmail = new Map(component.getAllProperties("attendee").flatMap((property) => {
    const email = stringValue(property.getFirstValue());
    if (!email) return [];
    return [[normalizeEmail(email), {
      status: stringValue(property.getFirstParameter("partstat")),
      rsvp: stringValue(property.getFirstParameter("rsvp")),
    }] as const];
  }));
  component.removeAllProperties("attendee");
  if (attendees.length === 0) return;
  if (!component.hasProperty("organizer")) component.addPropertyWithValue("organizer", `mailto:${normalizeEmail(selfEmail)}`);
  for (const attendee of attendees) addAttendee(component, attendee, participationByEmail.get(normalizeEmail(attendee.email)));
}

function setReminders(component: ICAL.Component, reminders: EventReminderInput[], title: string): void {
  component.removeAllSubcomponents("valarm");
  for (const reminder of reminders) addReminder(component, reminder, title);
}

function updateTimestamps(component: ICAL.Component, now: Date): void {
  const timestamp = ICAL.Time.fromJSDate(now, true);
  component.updatePropertyWithValue("dtstamp", timestamp);
  component.updatePropertyWithValue("last-modified", timestamp);
}

export function buildEventCalendar(draft: EventDraft, selfEmail: string, options: BuildOptions = {}): { data: string; filename: string; uid: string } {
  const allDay = draft.allDay ?? false;
  const now = options.now ?? new Date();
  const uid = options.uid ?? crypto.randomUUID();
  const root = new ICAL.Component("vcalendar");
  root.addPropertyWithValue("prodid", "-//Apple Calendar MCP//EN");
  root.addPropertyWithValue("version", "2.0");
  root.addPropertyWithValue("calscale", "GREGORIAN");
  const calendarTimeZone = calendarTimeZoneId(options.timeZoneData);
  const timeZone = allDay ? undefined : draft.timeZone ?? calendarTimeZone ?? options.defaultTimeZone;
  if (draft.timeZone && !isIanaTimeZone(draft.timeZone)) throw new Error("timeZone must be a valid IANA time zone such as America/New_York.");
  const zone = timeZone ? attachTimeZone(root, options.timeZoneData, timeZone) : undefined;
  if (draft.timeZone && !zone) throw new Error(`No VTIMEZONE definition is available for ${draft.timeZone}.`);
  if (draft.recurrence?.length && timeZone && !zone) throw new Error(`No VTIMEZONE definition is available for ${timeZone}.`);
  const range = validateTimeRange(draft.start, draft.end, allDay, zone);
  const component = new ICAL.Component("vevent");
  root.addSubcomponent(component);
  const event = new ICAL.Event(component);
  event.uid = uid;
  event.summary = draft.title;
  event.startDate = range.start;
  event.endDate = range.end;
  event.sequence = 0;
  const timestamp = ICAL.Time.fromJSDate(now, true);
  component.addPropertyWithValue("created", timestamp);
  updateTimestamps(component, now);
  component.addPropertyWithValue("transp", draft.availability === "free" ? "TRANSPARENT" : "OPAQUE");
  component.addPropertyWithValue("status", (draft.status ?? "confirmed").toUpperCase());
  setOptionalText(component, "location", draft.location ?? draft.structuredLocation?.address ?? draft.structuredLocation?.title);
  setStructuredLocation(component, draft.structuredLocation);
  setOptionalText(component, "description", draft.description);
  setOptionalText(component, "url", draft.url);
  if (draft.recurrence) addRecurrence(component, draft.recurrence);
  if (draft.attendees) setAttendees(component, draft.attendees, selfEmail);
  if (draft.reminders) setReminders(component, draft.reminders, draft.title);
  return { data: root.toString(), filename: `${uid}.ics`, uid };
}

function primaryEvent(root: ICAL.Component): ICAL.Component {
  const events = root.getAllSubcomponents("vevent");
  const component = events.find((candidate) => !candidate.hasProperty("recurrence-id")) ?? events[0];
  if (!component) throw new Error("Calendar object does not contain an event.");
  return component;
}

function patchEventComponent(root: ICAL.Component, component: ICAL.Component, patch: EventPatch, selfEmail: string, now: Date, options: PatchOptions): void {
  const event = new ICAL.Event(component);
  if (patch.title !== undefined) event.summary = patch.title;
  if (patch.timeZone !== undefined && (patch.start === undefined || patch.end === undefined)) {
    throw new Error("Changing timeZone requires both start and end.");
  }
  if (patch.start !== undefined || patch.end !== undefined || patch.allDay !== undefined) {
    if (patch.start === undefined || patch.end === undefined) throw new Error("Changing event time requires both start and end.");
    const allDay = patch.allDay ?? event.startDate.isDate;
    if (patch.timeZone && !isIanaTimeZone(patch.timeZone)) throw new Error("timeZone must be a valid IANA time zone such as America/New_York.");
    const existingTimeZone = isIanaTimeZone(event.startDate.zone.tzid) ? event.startDate.zone.tzid : undefined;
    const timeZone = allDay ? undefined : patch.timeZone ?? existingTimeZone ?? calendarTimeZoneId(options.timeZoneData) ?? options.defaultTimeZone;
    const zone = timeZone ? attachTimeZone(root, options.timeZoneData, timeZone) : undefined;
    if (patch.timeZone && !zone) throw new Error(`No VTIMEZONE definition is available for ${patch.timeZone}.`);
    if (event.isRecurring() && timeZone && !zone) throw new Error(`No VTIMEZONE definition is available for ${timeZone}.`);
    const range = validateTimeRange(patch.start, patch.end, allDay, zone);
    event.startDate = range.start;
    event.endDate = range.end;
  }
  const location = patch.location === undefined && patch.structuredLocation
    ? patch.structuredLocation.address ?? patch.structuredLocation.title
    : patch.location;
  setOptionalText(component, "location", location);
  setStructuredLocation(component, patch.structuredLocation);
  setOptionalText(component, "description", patch.description);
  setOptionalText(component, "url", patch.url);
  if (patch.availability !== undefined) component.updatePropertyWithValue("transp", patch.availability === "free" ? "TRANSPARENT" : "OPAQUE");
  if (patch.status !== undefined) component.updatePropertyWithValue("status", patch.status.toUpperCase());
  if (patch.recurrence !== undefined) {
    component.removeAllProperties("rrule");
    component.removeAllProperties("rdate");
    component.removeAllProperties("exdate");
    if (patch.recurrence) addRecurrence(component, patch.recurrence);
  }
  if (patch.attendees !== undefined) setAttendees(component, patch.attendees ?? [], selfEmail);
  if (patch.reminders !== undefined) setReminders(component, patch.reminders ?? [], event.summary || "Calendar event");
  event.sequence = (event.sequence || 0) + 1;
  updateTimestamps(component, now);
}

function sameRecurrenceTime(component: ICAL.Component, target: ICAL.Time): boolean {
  const value = component.getFirstPropertyValue("recurrence-id");
  return value instanceof ICAL.Time && (value.isDate ? value.toString() === target.toString() : value.toUnixTime() === target.toUnixTime());
}

function requireRecurringMaster(root: ICAL.Component): { component: ICAL.Component; event: ICAL.Event } {
  const component = primaryEvent(root);
  const event = new ICAL.Event(component);
  if (!event.isRecurring()) throw new Error("Occurrence-scoped changes require a recurring event.");
  return { component, event };
}

function occurrenceComponent(
  root: ICAL.Component,
  recurrenceId: string,
  scope: Exclude<RecurrenceMutationScope, "entire_series">,
): ICAL.Component {
  const { component: master, event: masterEvent } = requireRecurringMaster(root);
  if (!recurrenceId) throw new Error("recurrenceId is required for an occurrence-scoped change.");
  const parsedStart = parseInputTime(recurrenceId, masterEvent.startDate.isDate);
  const originalStart = parsedStart.isDate ? parsedStart : parsedStart.convertToZone(masterEvent.startDate.zone);
  const existing = root.getAllSubcomponents("vevent").find((candidate) => sameRecurrenceTime(candidate, originalStart));
  const component = existing ?? new ICAL.Component(structuredClone(master.toJSON()));
  if (!existing) root.addSubcomponent(component);

  component.removeAllProperties("rrule");
  component.removeAllProperties("rdate");
  component.removeAllProperties("exdate");
  const event = new ICAL.Event(component);
  event.recurrenceId = originalStart;
  event.startDate = originalStart.clone();
  const end = originalStart.clone();
  end.addDuration(masterEvent.duration);
  event.endDate = end;
  const recurrenceProperty = component.getFirstProperty("recurrence-id");
  if (scope === "this_and_following") recurrenceProperty?.setParameter("range", "THISANDFUTURE");
  else recurrenceProperty?.removeParameter("range");
  return component;
}

export function patchEventCalendar(
  data: string,
  patch: EventPatch,
  selfEmail: string,
  now = new Date(),
  scope: RecurrenceMutationScope = "entire_series",
  recurrenceId?: string,
  options: PatchOptions = {},
): string {
  const root = ICAL.Component.fromString(data);
  if (scope !== "entire_series" && patch.recurrence !== undefined) {
    throw new Error("Recurrence rules can only be changed for the entire series.");
  }
  const component = scope === "entire_series" ? primaryEvent(root) : occurrenceComponent(root, recurrenceId ?? "", scope);
  patchEventComponent(root, component, patch, selfEmail, now, options);
  return root.toString();
}

export function cancelEventOccurrence(
  data: string,
  recurrenceId: string,
  scope: Exclude<RecurrenceMutationScope, "entire_series">,
  now = new Date(),
): string {
  const root = ICAL.Component.fromString(data);
  const component = occurrenceComponent(root, recurrenceId, scope);
  const event = new ICAL.Event(component);
  component.updatePropertyWithValue("status", "CANCELLED");
  event.sequence = (event.sequence || 0) + 1;
  updateTimestamps(component, now);
  return root.toString();
}

export function respondToInvitation(data: string, selfEmail: string, status: Exclude<AttendanceStatus, "needs-action" | "delegated">, now = new Date()): string {
  const root = ICAL.Component.fromString(data);
  const component = primaryEvent(root);
  const self = component.getAllProperties("attendee").find((property) => {
    const value = stringValue(property.getFirstValue());
    return value ? normalizeEmail(value) === normalizeEmail(selfEmail) : false;
  });
  if (!self) throw new Error("The iCloud account is not an attendee on this event.");
  self.setParameter("partstat", status.toUpperCase());
  self.setParameter("rsvp", "FALSE");
  updateTimestamps(component, now);
  return root.toString();
}
