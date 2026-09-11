// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import CopyButton from "./CopyButton";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

describe("CopyButton", () => {
  it("copies, resets its label, and clears its timer on unmount", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(CopyButton, { text: "local-code" })));
    const button = container.querySelector("button")!;
    await act(async () => button.click());
    expect(writeText).toHaveBeenCalledWith("local-code");
    expect(button.textContent).toContain("已复制");
    act(() => vi.advanceTimersByTime(2000));
    expect(button.textContent).toContain("复制");
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});
