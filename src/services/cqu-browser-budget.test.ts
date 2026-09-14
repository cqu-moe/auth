import { describe, expect, it } from "vitest";
import {
  BROWSER_CLEANUP_MARGIN_MS,
  BROWSER_INVOCATION_BUDGET_MS,
  CONTAINER_BROWSER_DEADLINE_MS,
  CONTAINER_HARVEST_DEADLINE_MS,
  remainingBrowserBudget,
  resolveBrowserDeadline,
} from "./cqu-browser-budget";

describe("budget constants", () => {
  it("matches the agreed invocation/deadline/cleanup values", () => {
    expect(BROWSER_INVOCATION_BUDGET_MS).toBe(13 * 60_000);
    expect(CONTAINER_BROWSER_DEADLINE_MS).toBe(210_000);
    expect(CONTAINER_HARVEST_DEADLINE_MS).toBe(380_000);
    expect(BROWSER_CLEANUP_MARGIN_MS).toBe(20_000);
  });
});

describe("resolveBrowserDeadline", () => {
  const now = 1_000_000;

  it("uses the full invocation budget when no deadline is provided", () => {
    expect(resolveBrowserDeadline(undefined, now)).toBe(now + 13 * 60_000);
  });

  it("rejects an already-elapsed deadline", () => {
    expect(() => resolveBrowserDeadline(now, now)).toThrowError(
      expect.objectContaining({ code: "BROWSER_DEADLINE" })
    );
    expect(() => resolveBrowserDeadline(now - 1, now)).toThrowError(
      expect.objectContaining({ code: "BROWSER_DEADLINE" })
    );
  });

  it("accepts the first millisecond boundary after now", () => {
    expect(resolveBrowserDeadline(now + 1, now)).toBe(now + 1);
  });

  it.each([NaN, Infinity, -Infinity, 1.5, "1200", null, true])
  ("rejects non-safe-integer input %p", (value) => {
    expect(() => resolveBrowserDeadline(value, now)).toThrowError(
      expect.objectContaining({ code: "INVALID_BROWSER_DEADLINE" })
    );
  });

  it("keeps a deadline that exactly matches the invocation budget", () => {
    expect(resolveBrowserDeadline(now + 13 * 60_000, now)).toBe(now + 13 * 60_000);
  });

  it("clamps an overly distant deadline to the invocation budget", () => {
    expect(resolveBrowserDeadline(now + 60 * 60_000, now)).toBe(now + 13 * 60_000);
    expect(resolveBrowserDeadline(now + 13 * 60_000 + 1, now)).toBe(now + 13 * 60_000);
  });
});

describe("remainingBrowserBudget", () => {
  it("returns the remaining milliseconds", () => {
    expect(remainingBrowserBudget(2_000_000, 1_000_000)).toBe(1_000_000);
  });

  it("rejects when less than 30 seconds remain but accepts exactly 30 seconds", () => {
    expect(() => remainingBrowserBudget(1_029_999, 1_000_000)).toThrowError(
      expect.objectContaining({ code: "BROWSER_DEADLINE" })
    );
    expect(remainingBrowserBudget(1_030_000, 1_000_000)).toBe(30_000);
  });

  it("reduces as the clock advances", () => {
    const deadlineAt = resolveBrowserDeadline(undefined, 1_000_000);
    expect(remainingBrowserBudget(deadlineAt, 1_000_000)).toBe(13 * 60_000);
    expect(remainingBrowserBudget(deadlineAt, 1_000_000 + 60_000)).toBe(12 * 60_000);
    expect(() => remainingBrowserBudget(deadlineAt, deadlineAt - 29_999)).toThrowError(
      expect.objectContaining({ code: "BROWSER_DEADLINE" })
    );
  });
});
