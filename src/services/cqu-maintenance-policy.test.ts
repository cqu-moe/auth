import { afterEach, expect, it, vi } from "vitest";
import { sampleCquReloginAt } from "./cqu-maintenance-policy";

afterEach(() => vi.restoreAllMocks());

it("spreads renewal deadlines across the promised ranges with a 1% early tail", () => {
  const loginAt = 1_800_000_000_000;
  const hour = 3_600_000;
  const count = 10_000;
  let draw = 0;
  // Stratified entropy makes the probability contract deterministic, not a flaky random test.
  vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
    (array as Uint32Array)[0] = Math.floor(((draw++ + 0.5) / count) * 2 ** 32);
    return array;
  });
  const delays = Array.from({ length: count }, () => sampleCquReloginAt(loginAt) - loginAt);
  expect(delays.every(delay => Number.isSafeInteger(delay) && delay >= 4 * hour && delay < 7 * hour)).toBe(true);
  expect(delays.filter(delay => delay < 6 * hour)).toHaveLength(100);
  expect(new Set(delays).size).toBe(count);
  expect(Math.abs(delays.reduce((sum, delay) => sum + delay, 0) / count - 6.485 * hour)).toBeLessThan(1);
});

it.each([[0, 4 * 3_600_000], [0xffffffff, 7 * 3_600_000 - 1]])(
  "keeps endpoint entropy %d inside the hard time bounds", (entropy, expectedDelay) => {
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint32Array)[0] = entropy;
      return array;
    });
    expect(sampleCquReloginAt(1_800_000_000_000)).toBe(1_800_000_000_000 + expectedDelay);
  }
);
