// Verifies the approval guard, password comparison, and user-facing OAuth consent content.

import { describe, expect, it } from "vitest";
import { approvalPage, authorizationGuard, secretsEqual, supportedAuthorizationScopes } from "../src/authorize";

describe("authorization guard", () => {
  it("fails closed without a configured guard", () => {
    expect(authorizationGuard({})).toBe("disabled");
  });

  it("recognizes built-in, external, and layered protection", () => {
    expect(authorizationGuard({ APPROVAL_PASSWORD: "secret" })).toBe("password");
    expect(authorizationGuard({ EXTERNAL_AUTHORIZATION: "true" })).toBe("external");
    expect(authorizationGuard({ EXTERNAL_AUTHORIZATION: "true", APPROVAL_PASSWORD: "secret" })).toBe("external-and-password");
  });
});

describe("approval password", () => {
  it("matches only the exact password", async () => {
    await expect(secretsEqual("correct horse", "correct horse")).resolves.toBe(true);
    await expect(secretsEqual("correct", "correct horse")).resolves.toBe(false);
  });
});

describe("approval page", () => {
  it("explains the permission and the client-owned completion step", async () => {
    const response = approvalPage({ action: "/authorize?request=1", clientName: "Codex <Desktop>", redirectOrigin: "http://127.0.0.1:62502", passwordRequired: true });
    const html = await response.text();

    expect(html).toContain("Codex &lt;Desktop&gt;");
    expect(html).toContain("cannot create, edit, or delete");
    expect(html).toContain("Share Apple Calendar with Codex &lt;Desktop&gt;?");
    expect(html).toContain("Returning…");
    expect(html).toContain("font:400 .9375rem/1.5");
    expect(html).not.toContain("Connection request");
    expect(html).not.toContain("Requesting client");
    expect(html).toContain('name="decision" value="deny"');
    expect(html).toContain('name="password" type="password"');
    expect(html).toContain(":active{transform:scale(.975)}");
    expect(html).toContain("prefers-reduced-motion:reduce");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'nonce-");
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self' http://127.0.0.1:62502");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("omits the password field behind an external guard", async () => {
    const response = approvalPage({ action: "/authorize?request=1", clientName: "Claude", passwordRequired: false });
    expect(await response.text()).not.toContain('name="password"');
  });

  it("states the external effects of write access", async () => {
    const response = approvalPage({ action: "/authorize?request=1", clientName: "Claude", passwordRequired: false, writeRequested: true });
    const html = await response.text();
    expect(html).toContain("Read and edit calendars, events, and reminders");
    expect(html).toContain("Invitations and responses may notify other people.");
  });
});

describe("authorization scopes", () => {
  it("grants supported read and write scopes without reflecting unknown scopes", () => {
    expect(supportedAuthorizationScopes(["calendar:read", "admin", "calendar:write"])).toEqual(["calendar:read", "calendar:write"]);
  });
});
