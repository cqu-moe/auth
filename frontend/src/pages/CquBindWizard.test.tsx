// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CquBindWizard from "./CquBindWizard";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../components/Layout", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const authState = vi.hoisted(() => ({ userId: "current-user" }));

vi.mock("../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { id: authState.userId } },
      isPending: false,
    }),
  },
}));

let container: HTMLDivElement;
let root: Root;

function json(body: unknown, status = 200) {
  const payload = status >= 200 && status < 300 ? { data: body } : body;
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    bindStatus: "unbound",
    sessionStatus: { status: "idle" },
    ...overrides,
  };
}

async function renderWizard(path = "/cqu/bind", onReturn = vi.fn()) {
  await act(async () => {
    root.render(createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(CquBindWizard, { onReturn }),
    ));
    await Promise.resolve();
  });
  return onReturn;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  authState.userId = "current-user";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  sessionStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CquBindWizard bootstrap", () => {
  it("uses the confirmed account name on a new binding entry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(snapshot())));
    await renderWizard();
    await flush();

    expect(container.textContent).toContain("绑定重庆大学统一认证账号");
    expect(container.textContent).not.toContain("绑定 CQU 账户");
  });

  it("shows the fixed success page for an already-bound standalone visit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(snapshot({ bindStatus: "active" }))));
    await renderWizard();
    await flush();

    expect(container.textContent).toContain("绑定成功");
    expect(container.textContent).toContain("可以返回使用服务了。");
    expect(container.textContent).toContain("前往课表");
    expect(container.textContent).toContain("返回 CQU 集成");
    expect(container.querySelector('a[href="/settings/cqu"]')).not.toBeNull();
  });

  it("returns an already-bound user directly to the validated service", async () => {
    const onReturn = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => json(snapshot({ bindStatus: "active" }))));
    await renderWizard(
      "/cqu/bind?redirect=https%3A%2F%2Fschedule.cqu.moe%2Fdashboard%3Fsetup%3D1",
      onReturn,
    );
    await flush();

    expect(onReturn).toHaveBeenCalledOnce();
    expect(onReturn).toHaveBeenCalledWith("https://schedule.cqu.moe/dashboard?setup=1");
    expect(container.textContent).not.toContain("可以返回使用服务了。");
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) =>
      (init as RequestInit | undefined)?.method === "PUT"
    )).toBe(false);
  });

  it("keeps an active account on the repair flow", async () => {
    const onReturn = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => json(snapshot({
      address: "token@example.test",
      bindStatus: "active",
      kind: "direct",
    }))));
    await renderWizard(
      "/cqu/bind?repair=1&redirect=https%3A%2F%2Fschedule.cqu.moe%2Fdashboard%3Fsetup%3D1",
      onReturn,
    );
    await flush();

    expect(onReturn).not.toHaveBeenCalled();
    expect(container.textContent).toContain("统一身份认证账号");
    expect(container.querySelector("#bind-studentId")).toBeTruthy();
  });

  it("shows a retryable error without a false success state", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: true }, 503))
      .mockResolvedValueOnce(json(snapshot({ bindStatus: "active" })));
    vi.stubGlobal("fetch", fetchMock);
    await renderWizard();
    await flush();

    expect(container.textContent).toContain("暂时无法确认绑定状态");
    expect(container.textContent).not.toContain("绑定成功");

    const retry = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "重试");
    act(() => retry?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("绑定成功");
  });

  it("restores only matching current-user progress to the credential step", async () => {
    sessionStorage.setItem("cqu-bind-progress:current-user", JSON.stringify({
      userId: "current-user",
      address: "token@example.test",
      kind: "forward",
      step: 3,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => json(snapshot({
      address: "token@example.test",
      bindStatus: "pending",
      kind: "forward",
      forwardAddress: "owner@example.com",
    }))));

    await renderWizard();
    await flush();

    expect(container.querySelector("#bind-studentId")).toBeTruthy();
    expect(container.textContent).not.toContain("前往修改密保邮箱");
  });

  it("does not restore another account's saved credential step", async () => {
    sessionStorage.setItem("cqu-bind-progress:current-user", JSON.stringify({
      userId: "current-user",
      address: "token@example.test",
      kind: "forward",
      step: 3,
    }));
    authState.userId = "other-user";
    vi.stubGlobal("fetch", vi.fn(async () => json(snapshot({
      address: "token@example.test",
      bindStatus: "pending",
      kind: "forward",
      forwardAddress: "other@example.com",
    }))));

    await renderWizard();
    await flush();

    expect(container.querySelector("#bind-studentId")).toBeNull();
    expect(container.textContent).toContain("设置邮件转发规则");
  });

  it("polls a durable-object binding state and only completes on active", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(snapshot({
        address: "token@example.test",
        bindStatus: "pending",
        kind: "direct",
        sessionStatus: { status: "binding" },
      })))
      .mockResolvedValueOnce(json(snapshot({
        address: "token@example.test",
        bindStatus: "active",
        kind: "direct",
      })));
    vi.stubGlobal("fetch", fetchMock);

    await renderWizard();
    await flush();
    expect(container.textContent).toContain("正在确认绑定结果");
    expect(container.textContent).not.toContain("绑定成功");

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("绑定成功");
  });

  it("backs off after a temporary polling failure", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(snapshot({
        address: "token@example.test",
        bindStatus: "pending",
        kind: "direct",
        sessionStatus: { status: "binding" },
      })))
      .mockResolvedValueOnce(json({ error: true }, 429))
      .mockResolvedValueOnce(json(snapshot({
        address: "token@example.test",
        bindStatus: "active",
        kind: "direct",
      })));
    vi.stubGlobal("fetch", fetchMock);

    await renderWizard();
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(5999);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("绑定成功");
  });

  it("stops automatic checks after ten minutes without claiming failure", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-09-10T12:00:00Z");
    vi.setSystemTime(startedAt);
    const fetchMock = vi.fn(async () => json(snapshot({
      address: "token@example.test",
      bindStatus: "pending",
      kind: "direct",
      sessionStatus: { status: "binding" },
    })));
    vi.stubGlobal("fetch", fetchMock);

    await renderWizard();
    await flush();
    vi.setSystemTime(new Date(startedAt.getTime() + 10 * 60 * 1000));
    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("尚未确认绑定结果");
    expect(container.textContent).toContain("重新检查");
    expect(container.textContent).not.toContain("绑定失败");
  });
});

describe("CquBindWizard completion confirmation", () => {
  it("uses password-repair copy for an already-bound repair entry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(snapshot({
      address: "token@example.test",
      bindStatus: "active",
      kind: "direct",
    }))));

    await renderWizard("/cqu/bind?repair=1");
    await flush();

    expect(container.textContent).toContain("重新设置 CQU 密码");
    expect(container.textContent).toContain("保存并重新登录");
    expect(container.textContent).not.toContain("首次登录");
  });

  it("reports a repaired password after the new credentials are confirmed", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(snapshot({
        address: "token@example.test",
        bindStatus: "active",
        kind: "direct",
      })))
      .mockResolvedValueOnce(json({ success: true, studentId: "20260001" }))
      .mockResolvedValueOnce(json(snapshot({
        address: "token@example.test",
        bindStatus: "active",
        kind: "direct",
      })));
    vi.stubGlobal("fetch", fetchMock);

    await renderWizard("/cqu/bind?repair=1");
    await flush();
    setInput(container.querySelector<HTMLInputElement>("#bind-studentId")!, "20260001");
    setInput(container.querySelector<HTMLInputElement>("#bind-cquPassword")!, "test-only");
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    await flush();

    expect(container.textContent).toContain("密码已重新设置");
    expect(container.textContent).not.toContain("绑定成功");
  });

  it("shows an in-flight conflict without blaming the account password", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(snapshot({
        address: "token@example.test",
        bindStatus: "active",
        kind: "direct",
      })))
      .mockResolvedValueOnce(json({
        type: "about:blank",
        title: "Conflict",
        status: 409,
        detail: "CQU 登录正在进行中（请勿重复提交）",
        code: "CQU_LOGIN_IN_FLIGHT",
      }, 409));
    vi.stubGlobal("fetch", fetchMock);

    await renderWizard("/cqu/bind?repair=1");
    await flush();
    const studentId = container.querySelector<HTMLInputElement>("#bind-studentId");
    const password = container.querySelector<HTMLInputElement>("#bind-cquPassword");
    setInput(studentId!, "20260001");
    setInput(password!, "test-only");
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    await flush();

    expect(container.textContent).toContain("已有 CQU 登录正在进行，请等待当前登录完成");
    expect(container.textContent).not.toContain("账号和密码是否正确");
  });

  it("does not show success until the post-login GET confirms active", async () => {
    let resolveConfirmation!: (response: Response) => void;
    const confirmation = new Promise<Response>((resolve) => { resolveConfirmation = resolve; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(snapshot({
        address: "token@example.test",
        bindStatus: "pending",
        kind: "direct",
      })))
      .mockResolvedValueOnce(json({ success: true, studentId: "20260001" }))
      .mockImplementationOnce(() => confirmation);
    vi.stubGlobal("fetch", fetchMock);
    sessionStorage.setItem("cqu-bind-progress:current-user", JSON.stringify({
      userId: "current-user",
      address: "token@example.test",
      kind: "direct",
      step: 3,
    }));

    await renderWizard();
    await flush();
    const studentId = container.querySelector<HTMLInputElement>("#bind-studentId");
    const password = container.querySelector<HTMLInputElement>("#bind-cquPassword");
    expect(studentId).toBeTruthy();
    expect(password).toBeTruthy();
    setInput(studentId!, "20260001");
    setInput(password!, "test-only");
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain("正在确认绑定结果");
    expect(container.textContent).not.toContain("绑定成功");
    expect(fetchMock.mock.calls.filter(([url, init]) =>
      url === "/api/v1/cqu/binding/credentials" && (init as RequestInit | undefined)?.method === "PUT"
    )).toHaveLength(1);

    resolveConfirmation(json(snapshot({
      address: "token@example.test",
      bindStatus: "active",
      kind: "direct",
    })));
    await flush();
    expect(container.textContent).toContain("绑定成功");
    expect(container.textContent).toContain("可以返回使用服务了。");
    expect(sessionStorage.getItem("cqu-bind-progress:current-user")).toBeNull();
  });
});
