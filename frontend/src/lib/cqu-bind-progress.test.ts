import { describe, expect, it } from "vitest";
import {
  bindScreen,
  clearBindProgress,
  parseBindingSnapshot,
  readBindProgress,
  writeBindProgress,
  type BindingSnapshot,
  type SavedBindProgress,
} from "./cqu-bind-progress";

const base: BindingSnapshot = {
  bindStatus: "pending",
  sessionStatus: { status: "idle" },
};

const saved: SavedBindProgress = {
  userId: "current-user",
  address: "token@example.test",
  kind: "direct",
  step: 3,
};

describe("bindScreen", () => {
  it.each([
    ["legacy active credential without an address", { ...base, bindStatus: "active" }, null, false, "complete"],
    ["pending durable-object login", { ...base, address: saved.address, sessionStatus: { status: "binding" } }, null, false, "waiting"],
    ["matching saved credential step", { ...base, address: saved.address, kind: "direct" }, saved, false, "credentials"],
    ["saved progress for another user", { ...base, address: saved.address, kind: "direct" }, { ...saved, userId: "other-user" }, false, "address"],
    ["saved progress for another address", { ...base, address: saved.address, kind: "direct" }, { ...saved, address: "other@example.test" }, false, "address"],
    ["saved progress for another kind", { ...base, address: saved.address, kind: "forward" }, saved, false, "address"],
    ["no binding record", { ...base, bindStatus: "unbound" }, null, false, "intro"],
    ["revoked binding", { ...base, address: saved.address, bindStatus: "revoked", kind: "direct" }, null, false, "address"],
    ["active repair with an address", { ...base, address: saved.address, bindStatus: "active", kind: "direct" }, null, true, "credentials"],
    ["active repair without an address", { ...base, bindStatus: "active" }, null, true, "intro"],
  ] as const)("chooses %s", (_name, snapshot, progress, repair, expected) => {
    expect(bindScreen(snapshot, progress, "current-user", repair)).toBe(expected);
  });
});

describe("binding progress storage", () => {
  it("stores and restores only the resumable fields for the current user", () => {
    let stored = "";
    const storage = {
      getItem: () => stored || null,
      setItem: (_key: string, value: string) => { stored = value; },
      removeItem: () => { stored = ""; },
    };

    writeBindProgress(storage, saved);
    expect(JSON.parse(stored)).toEqual(saved);
    expect(stored).not.toContain("password");
    expect(readBindProgress(storage, "current-user")).toEqual(saved);

    clearBindProgress(storage, "current-user");
    expect(stored).toBe("");
  });

  it("rejects malformed or cross-user saved progress", () => {
    const value = { ...saved, userId: "other-user" };
    const storage = { getItem: () => JSON.stringify(value) };
    expect(readBindProgress(storage, "current-user")).toBeNull();
    expect(readBindProgress({ getItem: () => "not-json" }, "current-user")).toBeNull();
  });

  it("continues safely when session storage is unavailable", () => {
    const denied = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
    };
    expect(readBindProgress(denied, "current-user")).toBeNull();
    expect(() => writeBindProgress(denied, saved)).not.toThrow();
    expect(() => clearBindProgress(denied, "current-user")).not.toThrow();
  });
});

describe("parseBindingSnapshot", () => {
  it("accepts the public recovery fields", () => {
    expect(parseBindingSnapshot({
      address: "token@example.test",
      bindStatus: "pending",
      kind: "forward",
      forwardAddress: "owner@example.com",
      sessionStatus: { status: "idle" },
    })).toEqual({
      address: "token@example.test",
      bindStatus: "pending",
      kind: "forward",
      forwardAddress: "owner@example.com",
      sessionStatus: { status: "idle" },
    });
  });

  it.each([
    null,
    {},
    { bindStatus: "unknown", sessionStatus: {} },
    { bindStatus: "active", address: 7, sessionStatus: {} },
    { bindStatus: "active", kind: "other", sessionStatus: {} },
    { bindStatus: "active", forwardAddress: false, sessionStatus: {} },
  ])("rejects an invalid binding response: %j", (value) => {
    expect(() => parseBindingSnapshot(value)).toThrow("Invalid binding response");
  });
});
