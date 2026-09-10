// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { refetchOnReturn } from "./refetch-on-return";

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}

afterEach(() => setVisibility("visible"));

describe("refetchOnReturn", () => {
  it("does not refetch while the document is hidden", async () => {
    setVisibility("hidden");
    const refetch = vi.fn();
    const cleanup = refetchOnReturn(refetch);

    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(refetch).not.toHaveBeenCalled();
    cleanup();
  });

  it("coalesces focus and visibility events while a refetch is running", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    const refetch = vi.fn(() => pending);
    const cleanup = refetchOnReturn(refetch);

    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(refetch).toHaveBeenCalledTimes(1);

    resolve();
    await pending;
    cleanup();
  });

  it("removes both listeners during cleanup", async () => {
    const refetch = vi.fn();
    const cleanup = refetchOnReturn(refetch);
    cleanup();

    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(refetch).not.toHaveBeenCalled();
  });

  it("allows a later focus refetch after a rejected request", async () => {
    const refetch = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    const cleanup = refetchOnReturn(refetch);

    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    await Promise.resolve();
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();

    expect(refetch).toHaveBeenCalledTimes(2);
    cleanup();
  });
});
