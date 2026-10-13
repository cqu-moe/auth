import { describe, expect, it } from "vitest";
import { authFlowDescriptor, classifyAuthFlowResponse, responseUserId } from "./auth-telemetry";

describe("observable authentication results", () => {
  const login = authFlowDescriptor("POST", "/sign-in/email")!;
  const authorize = authFlowDescriptor("GET", "/oauth2/authorize")!;
  it("does not count a first factor or an empty HTTP 200 as a completed login", () => {
    expect(classifyAuthFlowResponse(login, new Response(), { twoFactorRedirect: true })).toBe("needs_input");
    expect(classifyAuthFlowResponse(login, new Response(), {})).toBe("unverified");
    expect(classifyAuthFlowResponse(login, new Response(), { user: { id: "central-user" } })).toBe("success");
    expect(classifyAuthFlowResponse(login, new Response(null, { status: 401 }), {})).toBe("failure");
  });
  it("starts passkey measurement at verification, without orphan option requests", () => {
    expect(authFlowDescriptor("GET", "/passkey/generate-authenticate-options")).toBeUndefined();
    expect(authFlowDescriptor("POST", "/passkey/verify-authentication")?.operation).toBe("passkey");
  });
  it.each([
    ["https://schedule.cqu.moe/callback?code=private", "success"],
    ["https://schedule.cqu.moe/callback?error=access_denied", "canceled"],
    ["https://schedule.cqu.moe/callback?error=server_error", "failure"],
    ["/login?returnTo=private", "needs_input"],
  ])("classifies an authorization redirect without capturing its URL", (location, outcome) => {
    expect(classifyAuthFlowResponse(authorize, new Response(null, { status: 302, headers: { location } }), null)).toBe(outcome);
  });
  it("only extracts the authenticated response user ID", () => {
    expect(responseUserId({ user: { id: "central-user", email: "private@example.test" } })).toBe("central-user");
    expect(responseUserId({ user: { email: "private@example.test" } })).toBeUndefined();
  });
});
