import { describe, expect, it } from "vitest";
import { classifyAuthFlowResponse, readResponseShape } from "./auth-telemetry";

const login = { flow: "login", operation: "email_password", stage: "first_factor", finish: true } as const;
const authorization = { flow: "authorization", operation: "authorize", stage: "authorize", finish: true } as const;

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("Auth flow terminal classification", () => {
  it("distinguishes fresh login, MFA input, cancellation, and redirect continuation", async () => {
    const freshLogin = jsonResponse({ user: { id: "user-1" }, session: { id: "session-1" } });
    expect(freshLogin.ok).toBe(true);
    const freshLoginPayload = await readResponseShape(freshLogin);
    expect(classifyAuthFlowResponse(
      login,
      freshLogin,
      freshLoginPayload
    )).toBe("success");
    const mfaRequired = jsonResponse({ twoFactorRedirect: true });
    expect(classifyAuthFlowResponse(login, mfaRequired, await readResponseShape(mfaRequired))).toBe("needs_input");
    const failedLogin = jsonResponse({ user: { id: "user-1" } }, 401);
    expect(classifyAuthFlowResponse(login, failedLogin, await readResponseShape(failedLogin))).toBe("failure");
    const canceled = jsonResponse({ redirect: true, url: "https://schedule.cqu.moe/?error=access_denied" });
    expect(classifyAuthFlowResponse(
      authorization,
      canceled,
      await readResponseShape(canceled)
    )).toBe("canceled");
    const authorized = jsonResponse({ redirect: true, url: "https://schedule.cqu.moe/?code=secret-code" });
    expect(classifyAuthFlowResponse(
      authorization,
      authorized,
      await readResponseShape(authorized)
    )).toBe("success");
    expect(classifyAuthFlowResponse(
      authorization,
      new Response(null, { status: 302, headers: { location: "/api/auth/sign-in/email" } }),
      null
    )).toBe("needs_input");
  });
});
