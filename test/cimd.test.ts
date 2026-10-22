// Verifies the ChatGPT metadata-document fallback intercepts only chatgpt.com's CIMD URLs.

import { describe, expect, it } from "vitest";
import { createMetadataAwareFetch, isChatGptMetadataUrl, pinnedChatGptMetadata } from "../src/cimd";

describe("ChatGPT CIMD fallback", () => {
  it("recognises only chatgpt.com metadata document URLs", () => {
    expect(isChatGptMetadataUrl("https://chatgpt.com/oauth/client.json")).toBe(true);
    expect(isChatGptMetadataUrl("https://chatgpt.com/oauth/abc_123/client.json")).toBe(true);
    expect(isChatGptMetadataUrl("https://chatgpt.com/oauth/client.json?x=1")).toBe(false);
    expect(isChatGptMetadataUrl("https://evil.example/oauth/client.json")).toBe(false);
    expect(isChatGptMetadataUrl("https://caldav.icloud.com/")).toBe(false);
  });

  it("serves a pinned public-client document when chatgpt.com refuses", async () => {
    const calls: string[] = [];
    const refusing = (async (input: RequestInfo | URL) => {
      calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response("blocked", { status: 404, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    const wrapped = createMetadataAwareFetch(refusing);
    const response = await wrapped("https://chatgpt.com/oauth/client.json");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      client_id: "https://chatgpt.com/oauth/client.json",
      client_name: "ChatGPT",
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      token_endpoint_auth_method: "none",
    });
    expect(calls).toEqual(["https://chatgpt.com/oauth/client.json"]);
  });

  it("passes a live JSON document through and leaves other URLs alone", async () => {
    const live = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://chatgpt.com/")) {
        expect(new Headers(init?.headers).get("user-agent")).toMatch(/Safari/);
        return new Response(JSON.stringify({ client_id: url, client_name: "ChatGPT live" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("other", { status: 200 });
    }) as typeof fetch;
    const wrapped = createMetadataAwareFetch(live);
    expect(((await (await wrapped("https://chatgpt.com/oauth/client.json")).json()) as { client_name: string }).client_name).toBe("ChatGPT live");
    expect(await (await wrapped("https://caldav.icloud.com/")).text()).toBe("other");
  });

  it("adds the per-client redirect for id-scoped documents", () => {
    expect(pinnedChatGptMetadata("https://chatgpt.com/oauth/abc_123/client.json").redirect_uris).toEqual([
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "https://chatgpt.com/connector/oauth/abc_123",
    ]);
  });
});
