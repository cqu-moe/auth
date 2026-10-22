import { expect, it, vi } from "vitest";
import { CquLoginContainer } from "./cqu-login-container";
import type { Env } from "../types";

// Workerd's test pool has no container runtime. Only stub the SDK transport;
// this test covers our idle policy, not Cloudflare's shutdown implementation.
vi.mock("@cloudflare/containers", () => ({
  Container: class {
    env = {};
    renewActivityTimeout() {}
    async schedule() {}
    async fetch() { return new Response("proxied"); }
  },
}));

it("preserves the login handshake window and shortens idle time for browser jobs", async () => {
  const container = new CquLoginContainer({} as DurableObjectState, {} as Env);
  expect(container.sleepAfter).toBe("30s");
  for (const [path, method, idleWindow] of [
    ["/health", "GET", "30s"],
    ["/code-permit", "POST", "30s"],
    ["/run", "POST", "1s"],
    ["/code", "POST", "1s"],
    ["/health", "GET", "30s"],
    ["/code-permit", "POST", "30s"],
    ["/keepalive", "POST", "1s"],
    ["/data-harvest", "POST", "1s"],
  ]) {
    const response = await container.fetch(new Request(`http://container${path}`, { method }));
    expect(await response.text()).toBe("proxied");
    expect(container.sleepAfter).toBe(idleWindow);
  }
});
