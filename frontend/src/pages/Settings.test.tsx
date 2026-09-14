// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Settings from "./Settings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../components/Layout", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("../components/AccountProfileSection", () => ({ default: () => null }));
vi.mock("../components/SecuritySection", () => ({ default: () => null }));
vi.mock("../components/quicklogin/QuickloginSettings", () => ({ default: () => null }));

vi.mock("../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { id: "current-user", email: "user@example.com", name: "User" } },
      refetch: vi.fn(),
    }),
  },
}));

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

async function renderSettings() {
  await act(async () => {
    root.render(createElement(
      MemoryRouter,
      { initialEntries: ["/settings"] },
      createElement(Settings),
    ));
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
