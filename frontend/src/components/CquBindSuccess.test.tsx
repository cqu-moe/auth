// @vitest-environment jsdom

import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CquBindSuccess from "./CquBindSuccess";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function renderSuccess(
  props: { returnTo: string | null; autoReturn: boolean; onReturn?: (url: string) => void },
  strict = false,
) {
  const child = createElement(CquBindSuccess, props);
  const routed = createElement(MemoryRouter, null, child);
  act(() => root.render(strict ? createElement(StrictMode, null, routed) : routed));
}

function advance(seconds: number) {
  for (let index = 0; index < seconds; index += 1) {
    act(() => vi.advanceTimersByTime(1000));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("CquBindSuccess", () => {
  it("returns to Schedule once after three seconds", () => {
    const onReturn = vi.fn();
    const returnTo = "https://schedule.cqu.moe/dashboard?setup=1";
    renderSuccess({ returnTo, autoReturn: true, onReturn }, true);

    expect(container.textContent).toContain("绑定成功");
    expect(container.textContent).toContain("可以返回使用服务了。");
    expect(container.textContent).toContain("返回课表");
    expect(container.textContent).toContain("3 秒后自动返回");

    advance(2);
    expect(onReturn).not.toHaveBeenCalled();
    advance(3);
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(onReturn).toHaveBeenCalledWith(returnTo);
  });

  it("cancels automatic return when the user stays on the page", () => {
    const onReturn = vi.fn();
    renderSuccess({
      returnTo: "https://schedule.cqu.moe/dashboard?setup=1",
      autoReturn: true,
      onReturn,
    });

    const stay = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "留在此页");
    expect(stay).toBeTruthy();
    act(() => stay?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    advance(5);

    expect(onReturn).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("秒后自动返回");
  });

  it("cleans up the timer when unmounted", () => {
    const onReturn = vi.fn();
    renderSuccess({
      returnTo: "https://schedule.cqu.moe/dashboard?setup=1",
      autoReturn: true,
      onReturn,
    });
    advance(1);
    act(() => root.unmount());
    advance(5);
    expect(onReturn).not.toHaveBeenCalled();

    root = createRoot(container);
  });

  it("does not schedule a return for a standalone account-center visit", () => {
    const onReturn = vi.fn();
    renderSuccess({ returnTo: null, autoReturn: false, onReturn });
    advance(5);

    expect(onReturn).not.toHaveBeenCalled();
    expect(container.textContent).toContain("前往课表");
    expect(container.textContent).toContain("返回 CQU 集成");
    expect(container.querySelector('a[href="/settings/cqu"]')).not.toBeNull();
    expect(container.textContent).not.toContain("秒后自动返回");
  });

  it("labels another approved first-party destination as the service", () => {
    renderSuccess({ returnTo: "https://example.cqu.moe/path", autoReturn: false });
    expect(container.textContent).toContain("返回服务");
    expect(container.textContent).not.toContain("返回课表");
  });
});
