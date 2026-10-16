// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ThemeProvider } from "@cqu-moe/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRedirectParam } from "../lib/post-login-redirect";
import EmailVerificationGate from "./EmailVerificationGate";
import ProtectedRoute from "./ProtectedRoute";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const authState = vi.hoisted(() => ({
  session: null as null | { user: { id: string; emailVerified: boolean } },
  pending: false,
  error: null as null | { status: number },
  refetch: vi.fn(),
}));

vi.mock("../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: authState.session, isPending: authState.pending, error: authState.error, refetch: authState.refetch }),
  },
}));

const service = "https://schedule.cqu.moe/dashboard?setup=1";
const binding = withRedirectParam("/cqu/bind", service);
let container: HTMLDivElement;
let root: Root;

function LoginDraft() {
  const [value, setValue] = useState("未提交的输入");
  return <input aria-label="登录草稿" value={value} onChange={event => setValue(event.target.value)} />;
}

function LocationProbe({ label }: { label: string }) {
  const location = useLocation();
  return <output data-location>{label}:{location.pathname + location.search}</output>;
}

async function renderFlow(entry: string) {
  await act(async () => {
    root.render(
      <ThemeProvider><MemoryRouter initialEntries={[entry]}>
        <EmailVerificationGate>
          <Routes>
            <Route path="/login" element={<><LocationProbe label="login" /><LoginDraft /></>} />
            <Route path="/verify-email" element={<LocationProbe label="verify" />} />
            <Route path="/two-factor" element={<LocationProbe label="two-factor" />} />
            <Route
              path="/cqu/bind"
              element={<ProtectedRoute><LocationProbe label="bind" /></ProtectedRoute>}
            />
            <Route
              path="/oauth/authorize"
              element={<ProtectedRoute><LocationProbe label="oauth" /></ProtectedRoute>}
            />
          </Routes>
        </EmailVerificationGate>
      </MemoryRouter></ThemeProvider>,
    );
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media, matches: false, addEventListener: () => {}, removeEventListener: () => {},
  }));
  authState.session = null;
  authState.pending = false;
  authState.error = null;
  authState.refetch.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("email verification route integration", () => {
  it("sends a signed-out binding visit to login with the whole binding path", async () => {
    await renderFlow(binding);
    expect(container.querySelector("[data-location]")?.textContent).toBe(
      `login:${withRedirectParam("/login", binding)}`,
    );
  });

  it("sends an unverified binding visit to verification with the whole binding path", async () => {
    authState.session = { user: { id: "current-user", emailVerified: false } };
    await renderFlow(binding);
    expect(container.querySelector("[data-location]")?.textContent).toBe(
      `verify:${withRedirectParam("/verify-email", binding)}`,
    );
  });

  it("returns a verified email page to binding instead of unwrapping Schedule", async () => {
    authState.session = { user: { id: "current-user", emailVerified: true } };
    await renderFlow(withRedirectParam("/verify-email", binding));
    expect(container.querySelector("[data-location]")?.textContent).toBe(`bind:${binding}`);
  });

  it("leaves two-factor and OAuth routes on their own destinations", async () => {
    await renderFlow(withRedirectParam("/two-factor", binding));
    expect(container.querySelector("[data-location]")?.textContent).toBe(
      `two-factor:${withRedirectParam("/two-factor", binding)}`,
    );

    act(() => root.unmount());
    root = createRoot(container);
    authState.session = { user: { id: "current-user", emailVerified: true } };
    await renderFlow("/oauth/authorize?client_id=test-client");
    expect(container.querySelector("[data-location]")?.textContent).toBe(
      "oauth:/oauth/authorize?client_id=test-client",
    );
  });
});


describe("session loading continuity", () => {
  it("keeps the login form mounted while a signed-out session is refreshed", async () => {
    await renderFlow("/login");
    const draft = container.querySelector('input')!;
    draft.focus();
    authState.pending = true;
    await renderFlow("/login");
    expect(container.querySelector('input')).toBe(draft);
    expect(document.activeElement).toBe(draft);
    expect(container.textContent).not.toContain("正在检查邮箱验证状态");
  });

  it("does not expose a protected page or flash a status card during a fast check", async () => {
    vi.useFakeTimers();
    try {
      authState.pending = true;
      await renderFlow(binding);
      expect(container.querySelector('[data-location]')).toBeNull();
      expect(container.querySelector('h2')).toBeNull();
      await act(async () => { vi.advanceTimersByTime(150); });
      expect(container.querySelector('[data-session-feedback]')).toBeNull();
      authState.session = { user: { id: "current-user", emailVerified: true } };
      authState.pending = false;
      await renderFlow(binding);
      expect(container.querySelector('[data-location]')?.textContent).toBe(`bind:${binding}`);
    } finally {
      vi.useRealTimers();
    }
  });
});


it("shows a small status for a slow check and removes it as soon as access is resolved", async () => {
  vi.useFakeTimers();
  try {
    authState.pending = true;
    await renderFlow(binding);
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("正在确认登录状态");
    expect(container.querySelector('[data-location]')).toBeNull();
    authState.pending = false;
    authState.session = { user: { id: "current-user", emailVerified: false } };
    await renderFlow(binding);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[data-location]')?.textContent).toContain("verify:/verify-email");
  } finally { vi.useRealTimers(); }
});


it("offers a retry on a session network failure without exposing protected content", async () => {
  authState.error = { status: 503 };
  await renderFlow(binding);
  expect(container.querySelector('[data-location]')).toBeNull();
  expect(container.textContent).toContain("暂时无法确认登录状态");
  await act(async () => { container.querySelector('button')?.click(); });
  expect(authState.refetch).toHaveBeenCalledTimes(1);
});

it("returns an expired session to login instead of a retry loop", async () => {
  authState.error = { status: 401 };
  await renderFlow(binding);
  expect(container.querySelector('[data-location]')?.textContent).toBe(`login:${withRedirectParam("/login", binding)}`);
});
