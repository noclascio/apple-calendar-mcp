// Verifies rich event parsing and lossless iCalendar mutation without making network requests.

import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import { buildEventCalendar, calendarTimeZoneId, cancelEventOccurrence, parseExpandedIcsEvents, parseIcsEvents, patchEventCalendar, recurringEventTimeZoneId, respondToInvitation } from "../src/ical";

const context = {
  calendarId: "calendar-id",
  eventId: "event-id",
  selfEmail: "owner@example.com",
  etag: '"etag-1"',
};

const newYorkTimeZone = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VTIMEZONE\r
TZID:America/New_York\r
X-LIC-LOCATION:America/New_York\r
BEGIN:DAYLIGHT\r
DTSTART:19700308T020000\r
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r
TZOFFSETFROM:-0500\r
TZOFFSETTO:-0400\r
TZNAME:EDT\r
END:DAYLIGHT\r
BEGIN:STANDARD\r
DTSTART:19701101T020000\r
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r
TZOFFSETFROM:-0400\r
TZOFFSETTO:-0500\r
TZNAME:EST\r
END:STANDARD\r
END:VTIMEZONE\r
END:VCALENDAR`;

describe("iCalendar event model", () => {
  it("creates and parses recurring events with attendees and reminders", () => {
    const built = buildEventCalendar({
      title: "Weekly review",
      start: "2026-08-27T09:00:00-04:00",
      end: "2026-08-27T09:30:00-04:00",
      location: "Studio",
      description: "Review the current cut",
      attendees: [{ email: "editor@example.com", name: "Editor", role: "required" }],
      reminders: [{ minutesBefore: 15 }],
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH"],
      availability: "busy",
    }, "owner@example.com", {
      now: new Date("2026-08-26T17:00:00Z"),
      uid: "event-uid",
      defaultTimeZone: "America/New_York",
      timeZoneData: newYorkTimeZone,
    });

    const event = parseIcsEvents(built.data, { ...context, defaultTimeZone: "America/New_York" })[0];
    expect(built.filename).toBe("event-uid.ics");
    expect(event).toMatchObject({
      uid: "event-uid",
      title: "Weekly review",
      start: "2026-08-27T13:00:00.000Z",
      end: "2026-08-27T13:30:00.000Z",
      timeZone: "America/New_York",
      startLocal: "2026-08-27T09:00:00-04:00",
      endLocal: "2026-08-27T09:30:00-04:00",
      allDay: false,
      availability: "busy",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH"],
      organizer: { email: "owner@example.com" },
      attendees: [{ email: "editor@example.com", name: "Editor", role: "required", status: "needs-action", isSelf: false }],
      reminders: [{ action: "display", minutesBefore: 15, description: "Weekly review" }],
      etag: '"etag-1"',
    });
    expect(built.data).toContain("DTSTART;TZID=America/New_York:20260827T090000");
    expect(built.data).toContain("DTEND;TZID=America/New_York:20260827T093000");
  });

  it("preserves unknown calendar data while patching modeled fields", () => {
    const source = `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Fixture//EN\r
X-WR-CALNAME:Private\r
BEGIN:VTIMEZONE\r
TZID:America/New_York\r
END:VTIMEZONE\r
BEGIN:VEVENT\r
UID:fixture-1\r
DTSTAMP:20260826T120000Z\r
DTSTART:20260827T130000Z\r
DTEND:20260827T140000Z\r
SUMMARY:Old title\r
DESCRIPTION:Old description\r
X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC\r
END:VEVENT\r
END:VCALENDAR`;
    const patched = patchEventCalendar(source, {
      title: "New title",
      description: null,
      location: "Screening room",
      reminders: [{ minutesBefore: 30 }],
    }, "owner@example.com", new Date("2026-08-26T18:00:00Z"));

    expect(patched).toContain("X-WR-CALNAME:Private");
    expect(patched).toContain("BEGIN:VTIMEZONE");
    expect(patched).toContain("X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC");
    expect(patched).toContain("SUMMARY:New title");
    expect(patched).not.toContain("DESCRIPTION:Old description");
    expect(patched).toContain("LOCATION:Screening room");
    expect(patched).toContain("SEQUENCE:1");
    expect(patched).toContain("TRIGGER:-PT30M");
  });

  it("preserves attachments and unsupported alarms during unrelated updates", () => {
    const source = `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Fixture//EN\r
BEGIN:VEVENT\r
UID:fixture-attachments\r
DTSTAMP:20260826T120000Z\r
DTSTART:20260827T130000Z\r
DTEND:20260827T140000Z\r
SUMMARY:Original title\r
ATTACH;FMTTYPE=application/pdf:https://example.com/private/document.pdf\r
BEGIN:VALARM\r
ACTION:AUDIO\r
TRIGGER:-PT10M\r
END:VALARM\r
END:VEVENT\r
END:VCALENDAR`;
    const patched = patchEventCalendar(source, { title: "Updated title" }, "owner@example.com");

    expect(patched).toContain("ATTACH;FMTTYPE=application/pdf:https://example.com/private/document.pdf");
    expect(patched).toContain("ACTION:AUDIO");
    expect(patched).toContain("TRIGGER:-PT10M");
  });

  it("keeps recurring wall-clock time stable across daylight-saving changes", () => {
    const built = buildEventCalendar({
      title: "Weekly review",
      start: "2026-10-29T09:00:00-04:00",
      end: "2026-10-29T09:30:00-04:00",
      timeZone: "America/New_York",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH"],
    }, "owner@example.com", {
      uid: "dst-series",
      defaultTimeZone: "America/New_York",
    });
    const root = ICAL.Component.fromString(built.data);
    const component = root.getFirstSubcomponent("vevent");
    expect(component).not.toBeNull();
    const event = new ICAL.Event(component ?? undefined);
    const iterator = event.iterator();
    iterator.next();
    const afterDst = iterator.next();

    expect(calendarTimeZoneId(newYorkTimeZone)).toBe("America/New_York");
    expect(built.data).toContain("BEGIN:VTIMEZONE");
    expect(built.data).toContain("TZID:America/New_York");
    expect(afterDst?.toString()).toBe("2026-11-05T09:00:00");
    expect(new Date((afterDst?.toUnixTime() ?? 0) * 1000).toISOString()).toBe("2026-11-05T14:00:00.000Z");
  });

  it("supplies timezone definitions for explicit IANA zones", () => {
    const built = buildEventCalendar({
      title: "London call",
      start: "2026-10-22T09:00:00+01:00",
      end: "2026-10-22T09:30:00+01:00",
      timeZone: "Europe/London",
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"],
    }, "owner@example.com", { uid: "london-series" });
    const root = ICAL.Component.fromString(built.data);
    const event = new ICAL.Event(root.getFirstSubcomponent("vevent") ?? undefined);
    const iterator = event.iterator();
    iterator.next();
    const afterDst = iterator.next();

    expect(built.data).toContain("TZID:Europe/London");
    expect(afterDst?.toString()).toBe("2026-10-29T09:00:00");
    expect(new Date((afterDst?.toUnixTime() ?? 0) * 1000).toISOString()).toBe("2026-10-29T09:00:00.000Z");
  });

  it("normalizes iCloud-expanded recurrence wall times using the source timezone", () => {
    const source = buildEventCalendar({
      title: "DST canary",
      start: "2026-10-29T09:00:00-04:00",
      end: "2026-10-29T09:30:00-04:00",
      timeZone: "America/New_York",
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"],
    }, "owner@example.com", { uid: "expanded-series" }).data;
    const expanded = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:expanded-series\r
DTSTART:20261029T090000Z\r
DTEND:20261029T093000Z\r
RECURRENCE-ID:20261029T130000Z\r
SUMMARY:DST canary\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:expanded-series\r
DTSTART:20261105T090000Z\r
DTEND:20261105T093000Z\r
RECURRENCE-ID:20261105T140000Z\r
SUMMARY:DST canary\r
END:VEVENT\r
END:VCALENDAR`;
    const events = parseExpandedIcsEvents(expanded, source, { ...context, defaultTimeZone: "America/New_York" }, "America/New_York");
    const normalizedSource = source
      .replace("DTSTART;TZID=America/New_York:20261029T090000", "DTSTART:20261029T130000Z")
      .replace("DTEND;TZID=America/New_York:20261029T093000", "DTEND:20261029T133000Z");

    expect(recurringEventTimeZoneId(source, "UTC")).toBe("America/New_York");
    expect(recurringEventTimeZoneId(normalizedSource, "UTC")).toBe("America/New_York");
    expect(events.map(({ start, startLocal, recurrenceId }) => ({ start, startLocal, recurrenceId }))).toEqual([
      { start: "2026-10-29T13:00:00.000Z", startLocal: "2026-10-29T09:00:00-04:00", recurrenceId: "2026-10-29T13:00:00.000Z" },
      { start: "2026-11-05T14:00:00.000Z", startLocal: "2026-11-05T09:00:00-05:00", recurrenceId: "2026-11-05T14:00:00.000Z" },
    ]);

    const movedSource = source.replace("END:VCALENDAR", `BEGIN:VEVENT\r
UID:expanded-series\r
DTSTART;TZID=America/New_York:20261105T110000\r
DTEND;TZID=America/New_York:20261105T113000\r
RECURRENCE-ID;TZID=America/New_York:20261105T090000\r
SUMMARY:Moved DST canary\r
END:VEVENT\r
END:VCALENDAR`);
    const movedExpanded = expanded
      .replace("DTSTART:20261105T090000Z", "DTSTART:20261105T110000Z")
      .replace("DTEND:20261105T093000Z", "DTEND:20261105T113000Z");
    const moved = parseExpandedIcsEvents(movedExpanded, movedSource, { ...context, defaultTimeZone: "America/New_York" }, "America/New_York");
    expect(moved[1]).toMatchObject({
      start: "2026-11-05T16:00:00.000Z",
      end: "2026-11-05T16:30:00.000Z",
      startLocal: "2026-11-05T11:00:00-05:00",
      recurrenceId: "2026-11-05T14:00:00.000Z",
    });
  });

  it("reads, writes, clears, and otherwise preserves Apple structured locations", () => {
    const built = buildEventCalendar({
      title: "Appointment",
      start: "2026-08-27T14:30:00-04:00",
      end: "2026-08-27T16:15:00-04:00",
      structuredLocation: {
        title: "Perelman Center for Advanced Medicine",
        address: "3400 Civic Center Blvd, Philadelphia, PA 19104",
        latitude: 39.9474,
        longitude: -75.1936,
        radius: 75,
      },
    }, "owner@example.com", { uid: "location-1" });
    const event = parseIcsEvents(built.data, { ...context, defaultTimeZone: "America/New_York" })[0];

    expect(event).toMatchObject({
      location: "3400 Civic Center Blvd, Philadelphia, PA 19104",
      structuredLocation: {
        title: "Perelman Center for Advanced Medicine",
        address: "3400 Civic Center Blvd, Philadelphia, PA 19104",
        latitude: 39.9474,
        longitude: -75.1936,
        radius: 75,
      },
    });
    expect(built.data).toContain("X-APPLE-STRUCTURED-LOCATION;");
    expect(built.data).toContain("VALUE=URI:geo:39.9474,-75.1936");

    const renamed = patchEventCalendar(built.data, { title: "Renamed appointment" }, "owner@example.com");
    expect(renamed).toContain("X-APPLE-STRUCTURED-LOCATION;");
    const cleared = patchEventCalendar(renamed, { structuredLocation: null }, "owner@example.com");
    expect(cleared).not.toContain("X-APPLE-STRUCTURED-LOCATION;");
    expect(cleared).toContain("LOCATION:3400 Civic Center Blvd\\, Philadelphia\\, PA 19104");
  });

  it("updates only the authenticated attendee when responding", () => {
    const source = `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Fixture//EN\r
BEGIN:VEVENT\r
UID:invite-1\r
DTSTAMP:20260826T120000Z\r
DTSTART:20260827T130000Z\r
DTEND:20260827T140000Z\r
SUMMARY:Invitation\r
ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:owner@example.com\r
ATTENDEE;PARTSTAT=ACCEPTED:mailto:other@example.com\r
END:VEVENT\r
END:VCALENDAR`;
    const updated = respondToInvitation(source, "owner@example.com", "tentative", new Date("2026-08-26T18:00:00Z"));
    const event = parseIcsEvents(updated, context)[0];

    expect(event?.attendees).toEqual([
      { email: "owner@example.com", role: "required", status: "tentative", isSelf: true },
      { email: "other@example.com", role: "required", status: "accepted", isSelf: false },
    ]);
  });

  it("keeps all-day events as exclusive date ranges", () => {
    const built = buildEventCalendar({
      title: "Away",
      start: "2026-09-01",
      end: "2026-09-03",
      allDay: true,
    }, "owner@example.com", { uid: "away-1" });
    expect(parseIcsEvents(built.data, context)[0]).toMatchObject({ start: "2026-09-01", end: "2026-09-03", allDay: true });
  });

  it("updates one occurrence without changing the recurring master", () => {
    const built = buildEventCalendar({
      title: "Weekly review",
      start: "2026-08-27T13:00:00Z",
      end: "2026-08-27T14:00:00Z",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH"],
    }, "owner@example.com", { uid: "series-1" });
    const updated = patchEventCalendar(
      built.data,
      { title: "Moved review", start: "2026-09-03T15:00:00Z", end: "2026-09-03T16:30:00Z" },
      "owner@example.com",
      new Date("2026-08-26T18:00:00Z"),
      "this_instance",
      "2026-09-03T13:00:00Z",
    );
    const [master, exception] = parseIcsEvents(updated, context);

    expect(master).toMatchObject({ title: "Weekly review", start: "2026-08-27T13:00:00.000Z", recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH"] });
    expect(exception).toMatchObject({
      title: "Moved review",
      start: "2026-09-03T15:00:00.000Z",
      end: "2026-09-03T16:30:00.000Z",
      recurrenceId: "2026-09-03T13:00:00.000Z",
      recurrence: [],
    });
  });

  it("cancels this and later occurrences with a range exception", () => {
    const built = buildEventCalendar({
      title: "Weekly review",
      start: "2026-08-27T13:00:00Z",
      end: "2026-08-27T14:00:00Z",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH"],
    }, "owner@example.com", { uid: "series-2" });
    const cancelled = cancelEventOccurrence(
      built.data,
      "2026-09-03T13:00:00Z",
      "this_and_following",
      new Date("2026-08-26T18:00:00Z"),
    );
    const events = parseIcsEvents(cancelled, context);

    expect(events[0]).toMatchObject({ status: "confirmed", recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH"] });
    expect(events[1]).toMatchObject({ status: "cancelled", recurrenceId: "2026-09-03T13:00:00.000Z", recurrence: [] });
    expect(cancelled).toContain("RECURRENCE-ID;RANGE=THISANDFUTURE:20260903T130000Z");
  });

  it("rejects unbounded recurrence input and ambiguous timed values", () => {
    expect(() => buildEventCalendar({ title: "Bad", start: "2026-09-01T09:00:00", end: "2026-09-01T10:00:00" }, "owner@example.com")).toThrow("explicit UTC offset");
    expect(() => buildEventCalendar({
      title: "Bad",
      start: "2026-09-01T09:00:00Z",
      end: "2026-09-01T10:00:00Z",
      recurrence: ["SUMMARY:Injected"],
    }, "owner@example.com")).toThrow("complete RRULE");
  });
});

describe("iCloud expansion edge cases", () => {
  it("keeps all-day occurrences as dates when iCloud emits a date-time RECURRENCE-ID", () => {
    const source = buildEventCalendar({
      title: "Rent due",
      start: "2026-11-01",
      end: "2026-11-02",
      allDay: true,
      recurrence: ["RRULE:FREQ=MONTHLY;COUNT=3"],
    }, "owner@example.com", { uid: "all-day-series" }).data;
    const expanded = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:all-day-series\r
DTSTART;VALUE=DATE:20261201\r
DTEND;VALUE=DATE:20261202\r
RECURRENCE-ID:20261201T050000Z\r
SUMMARY:Rent due\r
END:VEVENT\r
END:VCALENDAR`;
    const context = { calendarId: "cal", eventId: "evt", selfEmail: "owner@example.com", defaultTimeZone: "America/New_York" };
    const [occurrence] = parseExpandedIcsEvents(expanded, source, context, "America/New_York");
    expect(occurrence).toMatchObject({ allDay: true, start: "2026-12-01", end: "2026-12-02" });
  });

  it("falls back to the occurrence's own end instead of throwing on unparseable durations", () => {
    const source = buildEventCalendar({
      title: "Odd series",
      start: "2026-11-03T15:00:00-05:00",
      end: "2026-11-03T15:30:00-05:00",
      timeZone: "America/New_York",
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"],
    }, "owner@example.com", { uid: "odd-series" }).data;
    const expanded = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:odd-series\r
DTSTART;VALUE=DATE:20261110\r
DTEND:20261110T203000Z\r
RECURRENCE-ID:20261110T200000Z\r
SUMMARY:Odd series\r
END:VEVENT\r
END:VCALENDAR`;
    const context = { calendarId: "cal", eventId: "evt", selfEmail: "owner@example.com", defaultTimeZone: "America/New_York" };
    expect(() => parseExpandedIcsEvents(expanded, source, context, "America/New_York")).not.toThrow();
    const [occurrence] = parseExpandedIcsEvents(expanded, source, context, "America/New_York");
    expect(typeof occurrence?.start).toBe("string");
    expect(typeof occurrence?.end).toBe("string");
  });
});

describe("wall-clock times without an embedded time zone", () => {
  const context = { calendarId: "cal", eventId: "evt", selfEmail: "owner@example.com", defaultTimeZone: "America/New_York" };

  it("interprets a TZID with no VTIMEZONE in the object using that zone", () => {
    const data = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART;TZID=America/New_York:20261205T120000\r\nDTEND;TZID=America/New_York:20261205T130000\r\nSUMMARY:Noon\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const [event] = parseIcsEvents(data, context);
    expect(event).toMatchObject({ start: "2026-12-05T17:00:00.000Z", end: "2026-12-05T18:00:00.000Z", startLocal: "2026-12-05T12:00:00-05:00", timeZone: "America/New_York" });
  });

  it("interprets a floating time in the calendar's default zone", () => {
    const data = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:b\r\nDTSTART:20260705T120000\r\nDTEND:20260705T130000\r\nSUMMARY:Summer noon\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const [event] = parseIcsEvents(data, context);
    expect(event).toMatchObject({ start: "2026-07-05T16:00:00.000Z", startLocal: "2026-07-05T12:00:00-04:00" });
  });

  it("leaves UTC and embedded-VTIMEZONE times untouched", () => {
    const utc = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:c\r\nDTSTART:20261205T170000Z\r\nDTEND:20261205T180000Z\r\nSUMMARY:UTC noon\r\nEND:VEVENT\r\nEND:VCALENDAR";
    expect(parseIcsEvents(utc, context)[0]?.start).toBe("2026-12-05T17:00:00.000Z");
    const built = buildEventCalendar({ title: "Built", start: "2026-12-05T12:00:00-05:00", end: "2026-12-05T13:00:00-05:00", timeZone: "America/New_York" }, "owner@example.com", { uid: "d" }).data;
    expect(parseIcsEvents(built, context)[0]?.start).toBe("2026-12-05T17:00:00.000Z");
  });
});
