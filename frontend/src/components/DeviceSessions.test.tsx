// @vitest-environment jsdom

import { StrictMode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ThemeProvider } from "@cqu-moe/ui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupUi, click, renderUi, setInputValue, submit } from "../lib/api/quicklogin.testbots";
import Login from "../pages/Login";
import TwoFactorChallenge from "../pages/TwoFactorChallenge";
import DeviceSessions from "./DeviceSessions";
import EmailVerificationGate from "./EmailVerificationGate";

const auth = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getSession: vi.fn(),
  email: vi.fn(),
  passkey: vi.fn(),
  refetch: vi.fn(),
  verifyTotp: vi.fn(),
}));

vi.mock("../lib/auth-client", () => ({
  authClient: {
    listSessions: auth.listSessions,
    getSession: auth.getSession,
    signIn: { email: auth.email, passkey: auth.passkey },
    twoFactor: { verifyTotp: auth.verifyTotp },
    useSession: () => ({
      data: { user: { emailVerified: true } },
      isPending: false,
      refetch: auth.refetch,
    }),
  },
}));

vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false, media: query, onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  dispatchEvent: () => false,
}));
vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const staleSession = { error: { code: "SESSION_NOT_FRESH", message: "Session is not fresh", status: 403 } };

function Location() {
  const location = useLocation();
  return <output aria-label="当前地址">{location.pathname}{location.search}{location.hash}</output>;
}

async function renderFlow(entry = "/settings/security") {
  return renderUi(
    <StrictMode>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Location />
          <EmailVerificationGate>
            <Routes>
              <Route path="/settings/security" element={<DeviceSessions />} />
              <Route path="/login" element={<Login />} />
              <Route path="/two-factor" element={<TwoFactorChallenge />} />
            </Routes>
          </EmailVerificationGate>
        </MemoryRouter>
      </ThemeProvider>
    </StrictMode>,
  );
}

function button(container: HTMLElement, text: string) {
  const element = Array.from(container.querySelectorAll("button")).find(button => button.textContent === text);
  expect(element, `missing button: ${text}`).toBeDefined();
  return element!;
}

beforeEach(() => {
  auth.listSessions.mockReset().mockResolvedValue({ data: [{ token: "fixture-session", userAgent: "Test browser", createdAt: new Date() }], error: null });
  auth.getSession.mockResolvedValue({ data: { session: { token: "fixture-session" } } });
  auth.email.mockResolvedValue({ data: { user: { emailVerified: true } }, error: null });
  auth.passkey.mockResolvedValue({ data: { user: { emailVerified: true } }, error: null });
  auth.refetch.mockResolvedValue(undefined);
  auth.verifyTotp.mockResolvedValue({ data: {}, error: null });
});

afterEach(async () => {
  await cleanupUi();
  vi.clearAllMocks();
});

it.each(["password", "passkey"])("returns from %s login and opens devices when the existing session is not fresh", async (method) => {
  auth.listSessions.mockResolvedValueOnce(staleSession);
  const container = await renderFlow();
  await click(button(container, "查看登录设备"));

  expect(container.textContent).toContain("为了确保安全，请重新登录后查看登录设备。");
  expect(container.textContent).not.toContain("Session is not fresh");
  const address = container.querySelector("output")!.textContent!;
  const loginUrl = new URL(address, "https://auth.cqu.moe");
  expect(loginUrl.pathname).toBe("/login");
  expect(loginUrl.searchParams.get("redirect")).toBe("/settings/security?devices=1#login-devices");

  if (method === "password") {
    await setInputValue(container.querySelector<HTMLInputElement>("#email")!, "user@example.com");
    await setInputValue(container.querySelector<HTMLInputElement>("#password")!, "fixture-password");
    await submit(container.querySelector("form")!);
  } else {
    await click(button(container, "使用 Passkey 登录"));
  }

  expect(container.querySelector("output")!.textContent).toBe("/settings/security?devices=1#login-devices");
  expect(container.textContent).toContain("当前设备：Test browser");
  expect(auth.listSessions).toHaveBeenCalledTimes(2);
});

it("opens devices after completing the second-factor challenge with the return URL", async () => {
  const container = await renderFlow("/two-factor?reason=session-not-fresh&redirect=%2Fsettings%2Fsecurity%3Fdevices%3D1%23login-devices");
  await setInputValue(container.querySelector<HTMLInputElement>("#twoFactorCode")!, "123456");
  await submit(container.querySelector("form")!);

  expect(container.querySelector("output")!.textContent).toBe("/settings/security?devices=1#login-devices");
  expect(container.textContent).toContain("当前设备：Test browser");
  expect(auth.listSessions).toHaveBeenCalledOnce();
});

it("keeps other API failures on the devices page so the user can retry", async () => {
  auth.listSessions.mockResolvedValueOnce({ error: { code: "INTERNAL_SERVER_ERROR", message: "服务暂不可用", status: 500 } });
  const container = await renderFlow();
  await click(button(container, "查看登录设备"));
  expect(container.querySelector("output")!.textContent).toBe("/settings/security");
  expect(container.textContent).toContain("服务暂不可用");
  await click(button(container, "查看登录设备"));
  expect(container.textContent).toContain("当前设备：Test browser");
});

it("stops redirecting if the returned session is still not fresh, and permits an explicit retry", async () => {
  auth.listSessions.mockResolvedValue(staleSession);
  const container = await renderFlow("/settings/security?devices=1#login-devices");
  expect(container.querySelector("output")!.textContent).toBe("/settings/security?devices=1#login-devices");
  expect(container.textContent).toContain("仍需重新登录才能查看登录设备");
  expect(auth.listSessions).toHaveBeenCalledOnce();
  await click(button(container, "查看登录设备"));
  expect(container.textContent).toContain("为了确保安全，请重新登录后查看登录设备。");
});
