// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRedirectParam } from "../lib/post-login-redirect";
import EmailVerificationGate from "./EmailVerificationGate";
import ProtectedRoute from "./ProtectedRoute";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const authState = vi.hoisted(() => ({
  session: null as null | { user: { id: string; emailVerified: boolean } },
  pending: false,
}));

vi.mock("../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: authState.session, isPending: authState.pending }),
  },
}));

const service = "https://schedule.cqu.moe/dashboard?setup=1";
const binding = withRedirectParam("/cqu/bind", service);
let container: HTMLDivElement;
let root: Root;

function LocationProbe({ label }: { label: string }) {
  const location = useLocation();
  return <output data-location>{label}:{location.pathname + location.search}</output>;
}

async function renderFlow(entry: string) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <EmailVerificationGate>
          <Routes>
            <Route path="/login" element={<LocationProbe label="login" />} />
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
      </MemoryRouter>,
    );
    await Promise.resolve();
  });
}

beforeEach(() => {
  authState.session = null;
  authState.pending = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
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
