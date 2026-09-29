// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../components/Layout", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("../components/AccountProfileSection", () => ({ default: () => <span>账户信息</span> }));
vi.mock("../components/SecuritySection", () => ({ default: () => null }));
const quickloginProps = vi.hoisted(() => vi.fn());
vi.mock("../components/quicklogin/QuickloginSettings", () => ({
  default: (props: unknown) => { quickloginProps(props); return null; },
}));

vi.mock("../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { id: "current-user", email: "user@example.com", name: "User", emailVerified: true } },
      refetch: vi.fn(),
    }),
  },
}));

vi.mock("../lib/posthog", () => ({ syncPostHogIdentity: vi.fn(), syncPostHogReplay: vi.fn() }));

let container: HTMLDivElement;
let root: Root;

function bindingResponse(bindStatus: "active" | "unbound" = "active") {
  return new Response(JSON.stringify({
    data: {
      address: bindStatus === "active" ? "token@cquotp.com" : undefined,
      bindStatus,
      sessionStatus: bindStatus === "active"
        ? { status: "active", studentId: "20260001" }
        : { status: "idle" },
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function renderSettings(path = "/settings/cqu") {
  await act(async () => {
    window.history.replaceState({}, "", path);
    root.render(createElement(App));
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function actionLink(label: string) {
  return Array.from(container.querySelectorAll("a"))
    .find((link) => link.textContent?.includes(label));
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal("fetch", vi.fn(async () => bindingResponse()));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CQU binding settings actions", () => {
  it("offers the three recovery choices for a bound account", async () => {
    await renderSettings();

    const actionGroup = container.querySelector('[aria-label="CQU 绑定操作"]');
    expect(actionGroup?.classList.contains("flex-nowrap")).toBe(true);
    expect(actionGroup?.querySelectorAll(":scope > a, :scope > button")).toHaveLength(3);
    expect(actionGroup?.querySelector("p")).toBeNull();

    const emailLink = actionLink("重新绑定邮箱");
    expect(emailLink?.getAttribute("href")).toBe(
      "https://self.cqu.edu.cn/cas-success/safe-center/email-bind-way/rebind",
    );
    expect(emailLink?.getAttribute("target")).toBe("_blank");

    const passwordLink = actionLink("重新设置密码");
    expect(passwordLink?.getAttribute("href")).toBe("/cqu/bind?repair=1");

    expect(Array.from(container.querySelectorAll("button")).some(
      (button) => button.textContent?.includes("解除绑定"),
    )).toBe(true);
    expect(container.textContent).not.toContain("绑定新账号");
    expect(container.textContent).toContain("Auth 服务端会话");
  });

  it("keeps the binding when the user cancels the destructive action", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    await renderSettings();

    const unbindButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("解除绑定"));
    await act(async () => {
      unbindButton?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("重新绑定邮箱");
    expect(container.textContent).not.toContain("已成功解除 CQU 账户绑定");
  });
});

it.each([["bind", "/cqu/bind"], ["repair", "/cqu/bind?repair=1"], ["verify", "/cqu/bind?repair=1"]])("routes cqu=%s to an explicit recovery link without mutating", async (hint, target) => {
  await renderSettings(`/settings?cqu=${hint}`);
  const link = container.querySelector('[data-cqu-action]');
  expect(link?.getAttribute("href")).toBe(target);
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
});


it.each([
  ["/settings?quickloginDevice=device-a&quickloginReconnect=1", "device-a"],
  ["/settings?quickloginDevice=device-a", undefined],
  ["/settings?quickloginDevice=device-a&quickloginReconnect=0", undefined],
  ["/settings?quickloginReconnect=1", undefined],
])("passes a reconnect device hint only for an explicit plugin reconnect entry: %s", async (path, expected) => {
  await renderSettings(path);
  expect(quickloginProps.mock.lastCall?.[0].reconnectDeviceHint).toBe(expected);
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
});


it("keeps the ordinary settings entry on the account page", async () => {
  await renderSettings("/settings");
  expect(container.textContent).toContain("账户信息");
  expect(quickloginProps).not.toHaveBeenCalled();
});

it("preserves the query and fragment when opening the legacy QuickLogin entry", async () => {
  await renderSettings("/settings?quicklogin=1&quickloginDevice=device-a#devices");
  expect(window.location.pathname + window.location.search + window.location.hash)
    .toBe("/settings/cqu?quicklogin=1&quickloginDevice=device-a#devices");
  expect(quickloginProps.mock.lastCall?.[0].currentDeviceHint).toBe("device-a");
});
