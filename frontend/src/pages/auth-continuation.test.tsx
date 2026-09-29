// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { ThemeProvider } from "@cqu-moe/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRedirectParam } from "../lib/post-login-redirect";
import Login from "./Login";
import Register from "./Register";
import ResetPassword from "./ResetPassword";
import ResetPasswordConfirm from "./ResetPasswordConfirm";
import VerifyEmail from "./VerifyEmail";

// ThemeProvider 监听系统主题偏好，node/jsdom 测试环境没有 matchMedia。
vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const authMocks = vi.hoisted(() => ({
  refetch: vi.fn(async () => undefined),
  requestPasswordReset: vi.fn(async () => ({ error: null })),
  resetPassword: vi.fn(async () => ({ error: null })),
  signOut: vi.fn(async () => ({ error: null })),
}));

vi.mock("../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { id: "current-user", email: "user@example.com", emailVerified: false } },
      refetch: authMocks.refetch,
    }),
    requestPasswordReset: authMocks.requestPasswordReset,
    resetPassword: authMocks.resetPassword,
    signOut: authMocks.signOut,
    sendVerificationEmail: vi.fn(async () => ({ error: null })),
    signIn: { email: vi.fn() },
    signUp: { email: vi.fn() },
  },
}));

const service = "https://schedule.cqu.moe/dashboard?setup=1";
const binding = withRedirectParam("/cqu/bind", service);

let container: HTMLDivElement;
let root: Root;

function LocationProbe() {
  const location = useLocation();
  return <output data-location>{location.pathname + location.search}</output>;
}

async function renderPage(element: React.ReactElement, entry: string) {
  await act(async () => {
    root.render(
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          {element}
          <LocationProbe />
        </MemoryRouter>
      </ThemeProvider>,
    );
    await Promise.resolve();
  });
}

function anchor(label: string) {
  return Array.from(container.querySelectorAll("a"))
    .find((item) => item.textContent?.trim() === label);
}

function setInput(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector);
  expect(input).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("authentication continuation links", () => {
  it("keeps the nested binding target through login, register, and password recovery", async () => {
    const loginEntry = withRedirectParam("/login", binding);
    await renderPage(createElement(Login), loginEntry);
    expect(container.textContent).toContain("继续使用重庆大学课表");
    expect(anchor("立即注册")?.getAttribute("href")).toBe(withRedirectParam("/register", binding));
    expect(anchor("忘记密码？")?.getAttribute("href")).toBe(withRedirectParam("/reset-password", binding));

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderPage(createElement(Register), withRedirectParam("/register", binding));
    expect(container.textContent).toContain("继续使用重庆大学课表");
    expect(anchor("立即登录")?.getAttribute("href")).toBe(withRedirectParam("/login", binding));
  });

  it("does not show the Schedule source on ordinary auth pages", async () => {
    await renderPage(createElement(Login), "/login");
    expect(container.textContent).not.toContain("继续使用重庆大学课表");
    expect(anchor("忘记密码？")?.getAttribute("href")).toBe("/reset-password");
  });

  it("uses the nested binding target for the password reset callback and return link", async () => {
    await renderPage(createElement(ResetPassword), withRedirectParam("/reset-password", binding));
    setInput("#email", "user@example.com");
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(authMocks.requestPasswordReset).toHaveBeenCalledWith({
      email: "user@example.com",
      redirectTo: withRedirectParam("/reset-password/confirm", binding),
    });
    expect(anchor("返回登录")?.getAttribute("href")).toBe(withRedirectParam("/login", binding));
  });

  it("returns a successful password reset to login with the nested target", async () => {
    const entry = `${withRedirectParam("/reset-password/confirm", binding)}&token=test-token`;
    await renderPage(createElement(ResetPasswordConfirm), entry);
    setInput("#password", "password-123");
    setInput("#confirmPassword", "password-123");
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(authMocks.resetPassword).toHaveBeenCalledWith({
      newPassword: "password-123",
      token: "test-token",
    });
    expect(container.querySelector("[data-location]")?.textContent).toBe(withRedirectParam("/login", binding));
  });
});

describe("VerifyEmail return handling", () => {
  it("refetches the session when the original tab becomes active and cleans up", async () => {
    await renderPage(createElement(VerifyEmail), withRedirectParam("/verify-email", binding));
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(authMocks.refetch).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("重新发送验证码");

    act(() => root.unmount());
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(authMocks.refetch).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });

  it("preserves the binding target when signing out from verification", async () => {
    await renderPage(createElement(VerifyEmail), withRedirectParam("/verify-email", binding));
    const signOut = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "退出当前账户");
    await act(async () => {
      signOut?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.querySelector("[data-location]")?.textContent).toBe(withRedirectParam("/login", binding));
  });
});
