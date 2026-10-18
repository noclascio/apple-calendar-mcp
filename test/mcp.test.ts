// Verifies the scoped tool catalog and advertised schemas through an in-memory MCP connection.

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { createCalendarMcpHandler, createCalendarServer } from "../src/mcp";

async function listTools(scopes: string[]) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createCalendarServer({
    ICLOUD_USERNAME: "owner@example.com",
    ICLOUD_APP_PASSWORD: "test-password",
    CALENDAR_TIME_ZONE: "America/New_York",
  }, scopes);
  const client = new Client({ name: "tool-catalog-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("MCP tool scopes", () => {
  it("adds one configured custom domain without losing the safe workers.dev default", async () => {
    const env = {
      ICLOUD_USERNAME: "owner@example.com",
      ICLOUD_APP_PASSWORD: "test-password",
      CALENDAR_TIME_ZONE: "UTC",
      MCP_HOSTNAME: "calendar.example.com",
    } as Env;
    const context = {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
    const handler = createCalendarMcpHandler(env);

    async function status(url: string) {
      const hostname = new URL(url).hostname;
      const request = new Request(url, { method: "GET", headers: { Host: hostname, Origin: `https://${hostname}` } });
      return (await handler(request, env, context)).status;
    }

    expect(await status("https://calendar.example.com/mcp")).toBe(405);
    expect(await status("https://example.account.workers.dev/mcp")).toBe(405);
    expect(await status("https://other.example.com/mcp")).toBe(403);
  });

  it("keeps existing read grants read-only", async () => {
    const tools = await listTools(["calendar:read"]);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "calendar_batch_get_events",
      "calendar_get_availability",
      "calendar_get_event",
      "calendar_get_profile",
      "calendar_list_calendars",
      "calendar_list_events",
      "calendar_search_events",
      "reminders_list",
      "reminders_pending_changes",
    ]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("adds conflict-safe mutation tools only with write scope", async () => {
    const tools = await listTools(["calendar:read", "calendar:write"]);
    const create = tools.find((tool) => tool.name === "calendar_create_event");
    const update = tools.find((tool) => tool.name === "calendar_update_event");
    const remove = tools.find((tool) => tool.name === "calendar_delete_event");

    expect(tools).toHaveLength(14);
    expect(tools.find((tool) => tool.name === "reminders_create")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(create?.outputSchema).toMatchObject({
      type: "object",
      properties: { event: { type: "object", properties: { attendees: { type: "array" }, timeZone: { type: "string" }, structuredLocation: { type: "object" }, etag: { type: "string" } } } },
    });
    expect(create?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(update?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        updateScope: { enum: ["entire_series", "this_instance", "this_and_following"] },
        recurrenceId: {},
        patch: { properties: { timeZone: { type: "string" }, structuredLocation: {} } },
      },
    });
    expect(create?.inputSchema).toMatchObject({
      properties: {
        reminders: { items: { properties: { minutesBefore: { type: "integer" } }, additionalProperties: false } },
        structuredLocation: { properties: { latitude: { type: "number" }, longitude: { type: "number" } } },
      },
    });
    expect(create?.description).toContain("All-day end dates are exclusive");
    expect(JSON.stringify(create?.inputSchema)).toContain("recurring-event semantics");
    expect(JSON.stringify(create?.inputSchema)).toContain("never guess them");
    expect(JSON.stringify(create?.inputSchema)).toContain("map preview");
    expect(JSON.stringify(create?.inputSchema)).toContain("Apple Calendar Notes field");
    expect(JSON.stringify(create?.inputSchema)).toContain("unrelated to attachments");
    expect(remove?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});
