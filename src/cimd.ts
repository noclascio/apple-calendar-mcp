// Keeps ChatGPT sign-ins working when chatgpt.com refuses to serve its client metadata document.
//
// ChatGPT identifies itself with a Client ID Metadata Document URL on chatgpt.com. The OAuth provider
// must fetch that document to recognise the client, and chatgpt.com rejects that fetch when it comes
// from a Cloudflare Worker, which killed every ChatGPT and Dots authorization once the provider's
// cached copy expired. This module wraps the global fetch: for those exact URLs it first tries the real
// document with a browser-like User-Agent, and if chatgpt.com still refuses, it answers with a pinned
// public-client document whose client_id matches the requested URL. Nothing else is intercepted.

const CHATGPT_CIMD = /^https:\/\/chatgpt\.com\/oauth\/(?:([A-Za-z0-9_-]+)\/)?client\.json$/;
const BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

export function isChatGptMetadataUrl(url: string): boolean {
  return CHATGPT_CIMD.test(url);
}

export function pinnedChatGptMetadata(url: string): Record<string, unknown> {
  const id = CHATGPT_CIMD.exec(url)?.[1];
  const redirectUris = ["https://chatgpt.com/connector_platform_oauth_redirect"];
  if (id) redirectUris.push(`https://chatgpt.com/connector/oauth/${id}`);
  return {
    client_id: url,
    client_name: "ChatGPT",
    client_uri: "https://chatgpt.com",
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    token_endpoint_auth_methods_supported: ["none"],
  };
}

function pinnedResponse(url: string): Response {
  return new Response(JSON.stringify(pinnedChatGptMetadata(url)), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "max-age=3600", "x-pinned-cimd": "1" },
  });
}

export function createMetadataAwareFetch(baseFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!isChatGptMetadataUrl(url)) return baseFetch(input, init);
    try {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set("user-agent", BROWSER_USER_AGENT);
      headers.set("accept", "application/json");
      const live = await baseFetch(url, { ...init, headers, redirect: "manual" });
      if (live.ok && (live.headers.get("content-type") ?? "").includes("json")) return live;
      console.warn("cimd_live_fetch_rejected", { status: live.status });
    } catch (error) {
      console.warn("cimd_live_fetch_failed", { reason: error instanceof Error ? error.message : String(error) });
    }
    return pinnedResponse(url);
  };
}

let installed = false;

// Installs the wrapper once per isolate. Safe to call on every request.
export function installChatGptMetadataFallback(): void {
  if (installed) return;
  installed = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = createMetadataAwareFetch(original) as typeof fetch;
}
