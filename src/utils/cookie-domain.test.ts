import { describe, it, expect } from "vitest";
import { isCquMoeHost } from "./cookie-domain";

describe("isCquMoeHost (cross-subdomain cookie gating)", () => {
  it("auth.cqu.moe → true", () => {
    expect(isCquMoeHost("https://auth.cqu.moe")).toBe(true);
  });
  it("calendar.cqu.moe → true", () => {
    expect(isCquMoeHost("https://calendar.cqu.moe")).toBe(true);
  });
  it("apex cqu.moe → true", () => {
    expect(isCquMoeHost("https://cqu.moe")).toBe(true);
  });
  it("localhost dev URL → false (else browser rejects Domain=cqu.moe)", () => {
    expect(isCquMoeHost("http://localhost:8787")).toBe(false);
  });
  it("127.0.0.1 → false", () => {
    expect(isCquMoeHost("http://127.0.0.1")).toBe(false);
  });
  it("malformed URL → false", () => {
    expect(isCquMoeHost("not a url")).toBe(false);
  });
  it("look-alike attacker host (hostname is attacker.com) → false", () => {
    expect(isCquMoeHost("https://evil-cqu.moe.attacker.com")).toBe(false);
  });
  it("substring-but-not-suffix (cqu.moe.attacker) → false", () => {
    expect(isCquMoeHost("https://cqu.moe.attacker.com")).toBe(false);
  });
  it("empty string → false", () => {
    expect(isCquMoeHost("")).toBe(false);
  });
});
