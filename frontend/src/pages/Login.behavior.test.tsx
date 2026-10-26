// @vitest-environment jsdom
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@cqu-moe/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupUi, renderUi, setInputValue, settleUi, click } from "../lib/api/quicklogin.testbots";
import type { TurnstileOptions } from "../lib/turnstile";
import Login from "./Login";

const authClient = vi.hoisted(() => ({
  useSession: () => ({ refetch: async () => undefined }),
  signIn: { email: vi.fn(), passkey: vi.fn() },
}));
vi.mock("../lib/auth-client", () => ({ authClient }));

let widgets: TurnstileOptions[];
let remove: ReturnType<typeof vi.fn>;

beforeEach(() => {
  widgets = [];
  remove = vi.fn();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("turnstile", {
    ready: () => { throw new Error("Remove async/defer before using turnstile.ready()"); },
    render: (_container: HTMLElement, options: TurnstileOptions) => { widgets.push(options); return String(widgets.length); },
    remove,
  });
  authClient.signIn.email.mockResolvedValue({ error: { message: "邮箱或密码错误" } });
});

afterEach(async () => {
  await cleanupUi();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderLogin() {
  const ui = await renderUi(createElement(ThemeProvider, null,
    createElement(MemoryRouter, { initialEntries: ["/login"] }, createElement(Login))));
  await setInputValue(ui.querySelector<HTMLInputElement>("#email")!, "user@example.com");
  await setInputValue(ui.querySelector<HTMLInputElement>("#password")!, "password-for-test");
  return ui;
}

async function submit(ui: HTMLElement) {
  await act(async () => { ui.querySelector("form")!.requestSubmit(); });
  await settleUi();
}

describe("password login safety verification", () => {
  it("waits for a slow challenge, announces manual interaction, and submits one captured form once", async () => {
    const ui = await renderLogin();
    expect(widgets[0].appearance).toBe("interaction-only");
    expect(Array.from(ui.querySelectorAll('[role="status"]')).some(node => node.textContent?.trim())).toBe(false);
    await act(async () => {
      ui.querySelector("form")!.requestSubmit();
      ui.querySelector("form")!.requestSubmit();
    });
    expect(authClient.signIn.email).not.toHaveBeenCalled();
    expect(ui.textContent).not.toContain("网络较慢");
    expect(ui.textContent).not.toContain("取消等待");
    expect(ui.querySelector('button[type="submit"]')?.getAttribute("aria-label")).toBe("正在完成安全验证…");
    expect(ui.querySelector<HTMLInputElement>("#email")!.readOnly).toBe(true);
    await act(async () => widgets[0]["before-interactive-callback"]());
    expect(ui.textContent).toContain("请完成下方的安全验证");
    await act(async () => widgets[0].callback("fresh-token"));
    expect(authClient.signIn.email).toHaveBeenCalledExactlyOnceWith(
      { email: "user@example.com", password: "password-for-test" },
      { headers: { "x-turnstile-token": "fresh-token" } },
    );
    expect(ui.textContent).toContain("邮箱或密码错误");
    expect(ui.querySelector<HTMLInputElement>("#password")!.value).toBe("password-for-test");
    expect(remove).toHaveBeenCalled();
    await submit(ui);
    expect(authClient.signIn.email).toHaveBeenCalledTimes(1);
    await act(async () => widgets[widgets.length - 1].callback("new-token"));
    expect(authClient.signIn.email).toHaveBeenCalledTimes(2);
  });

  it("preserves input on failure and retries verification and login through the single submit button", async () => {
    const ui = await renderLogin();
    await submit(ui);
    await act(async () => widgets[0]["error-callback"]());
    expect(authClient.signIn.email).not.toHaveBeenCalled();
    expect(ui.textContent).toContain("安全验证加载失败，请重试后再次提交");
    expect(Array.from(ui.querySelectorAll("button")).some(button => button.textContent === "重试验证")).toBe(false);
    expect(ui.querySelector<HTMLInputElement>("#password")!.readOnly).toBe(false);
    await click(ui.querySelector<HTMLButtonElement>('button[aria-label="重试登录"]')!);
    expect(authClient.signIn.email).not.toHaveBeenCalled();
    await act(async () => widgets[widgets.length - 1].callback("retry-token"));
    expect(authClient.signIn.email).toHaveBeenCalledExactlyOnceWith(
      { email: "user@example.com", password: "password-for-test" },
      { headers: { "x-turnstile-token": "retry-token" } },
    );
  });

  it("abandons a pending submit when the user leaves the form", async () => {
    const ui = await renderLogin();
    await submit(ui);
    const removed = widgets[widgets.length - 1];
    await cleanupUi();
    await act(async () => removed.callback("completed-after-leaving"));
    expect(authClient.signIn.email).not.toHaveBeenCalled();
  });

  it("does not reuse an expired token when browser timers were suspended", async () => {
    const ui = await renderLogin();
    await act(async () => widgets[0].callback("old-token"));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_000);
    await submit(ui);
    expect(authClient.signIn.email).not.toHaveBeenCalled();
    await act(async () => widgets[widgets.length - 1].callback("refreshed-token"));
    expect(authClient.signIn.email).toHaveBeenCalledExactlyOnceWith(expect.anything(),
      { headers: { "x-turnstile-token": "refreshed-token" } });
    vi.restoreAllMocks();
  });

  it("lets Passkey authenticate while Turnstile is still loading", async () => {
    const ui = await renderLogin();
    authClient.signIn.passkey.mockResolvedValue({ error: { message: "cancelled" } });
    await click(Array.from(ui.querySelectorAll("button")).find(button => button.textContent?.includes("使用 Passkey 登录"))!);
    expect(authClient.signIn.passkey).toHaveBeenCalledTimes(1);
    expect(authClient.signIn.email).not.toHaveBeenCalled();
  });

  it("stops waiting after a bounded timeout and keeps the form editable", async () => {
    const ui = await renderLogin();
    vi.useFakeTimers();
    await act(async () => { ui.querySelector("form")!.requestSubmit(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(authClient.signIn.email).not.toHaveBeenCalled();
    expect(ui.textContent).toContain("请重试后再次提交");
    expect(ui.querySelector<HTMLInputElement>("#email")!.readOnly).toBe(false);
    vi.useRealTimers();
  });

  it("recovers from a blocked async script without losing the pending form data", async () => {
    vi.stubGlobal("turnstile", undefined);
    const ui = await renderLogin();
    await submit(ui);
    const script = document.querySelector<HTMLScriptElement>('script[src*="challenges.cloudflare.com"]')!;
    await act(async () => script.dispatchEvent(new Event("error")));
    expect(ui.textContent).toContain("安全验证加载失败");
    expect(authClient.signIn.email).not.toHaveBeenCalled();
    expect(ui.querySelector<HTMLInputElement>("#email")!.value).toBe("user@example.com");
    await submit(ui);
    const retried = document.querySelector<HTMLScriptElement>('script[src*="challenges.cloudflare.com"]')!;
    expect(retried).not.toBe(script);
    vi.stubGlobal("turnstile", {
      ready: () => { throw new Error("Remove async/defer before using turnstile.ready()"); },
      render: (_container: HTMLElement, options: TurnstileOptions) => { widgets.push(options); return "reloaded"; },
      remove,
    });
    await act(async () => retried.dispatchEvent(new Event("load")));
    await act(async () => widgets[widgets.length - 1].callback("after-script-retry"));
    expect(authClient.signIn.email).toHaveBeenCalledTimes(1);
    retried.remove();
  });
});
