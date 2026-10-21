// Verifies that one malformed CalDAV object is skipped instead of failing the whole event window.

import { describe, expect, it } from "vitest";
import { parseCalendarObjectSafely } from "../src/calendar";

const url = "https://p01-caldav.icloud.com/123/calendars/home/abc.ics";
const options = { calendarId: "cal", username: "owner@example.com", defaultTimeZone: "America/New_York" };

describe("parseCalendarObjectSafely", () => {
  it("parses a healthy object", () => {
    const data = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:ok\r\nDTSTART:20261105T140000Z\r\nDTEND:20261105T143000Z\r\nSUMMARY:Fine\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const events = parseCalendarObjectSafely({ url, data, etag: "\"1\"" }, options);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ title: "Fine", etag: "\"1\"" });
  });

  it("skips an object whose data cannot be parsed and keeps going", () => {
    const garbage = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:bad\r\nDTSTART:not-a-date\r\nDTEND:also-bad\r\nSUMMARY:Broken\r\nEND:VEVENT\r\nEND:VCALENDAR";
    expect(() => parseCalendarObjectSafely({ url, data: garbage }, options)).not.toThrow();
    expect(parseCalendarObjectSafely({ url, data: "this is not ics at all" }, options)).toEqual([]);
    expect(parseCalendarObjectSafely({ url, data: undefined as unknown as string }, options)).toEqual([]);
  });
});

describe("holdsEvents", () => {
  it("keeps calendars with no declared component set, as iCloud shared calendars often are", async () => {
    const { holdsEvents } = await import("../src/calendar");
    expect(holdsEvents({ components: [] })).toBe(true);
    expect(holdsEvents({ components: undefined as unknown as string[] })).toBe(true);
    expect(holdsEvents({ components: ["VEVENT", "VTODO"] })).toBe(true);
    expect(holdsEvents({ components: ["VTODO"] })).toBe(false);
  });
});
