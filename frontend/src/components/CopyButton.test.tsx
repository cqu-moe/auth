// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import CopyButton from "./CopyButton";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

describe("CopyButton", () => {
  it.each([false, true])("copies with iconOnly=%s, resets its label, and clears its timer on unmount", async (iconOnly) => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(CopyButton, { text: "local-code", iconOnly })));
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("复制到剪贴板");
    await act(async () => button.click());
    expect(writeText).toHaveBeenCalledWith("local-code");
    expect(button.textContent).toContain("已复制");
    expect(button.getAttribute("aria-label")).toBe("已复制");
    act(() => vi.advanceTimersByTime(2000));
    expect(button.textContent).toContain("复制");
    expect(button.getAttribute("aria-label")).toBe("复制到剪贴板");
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});
