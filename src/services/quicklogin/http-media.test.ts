import { describe, expect, it } from "vitest";
import { parseHeartbeat, QuickloginHttpError, readJson } from "./http";

describe("QuickLogin HTTP JSON media contract", () => {
  it.each([
    [undefined, '{"enabled":true}', "INVALID_REQUEST", 415],
    ["text/plain", '{"enabled":true}', "INVALID_REQUEST", 415],
    ["application/json", "{", "INVALID_REQUEST", 400],
  ])("rejects content-type %s before parsing", async (contentType, body, code, status) => {
    const headers = contentType ? { "content-type": contentType } : undefined;
    await expect(readJson(new Request("https://auth.test/device", {
      method: "POST", headers, body,
    }))).rejects.toMatchObject({ code, status });
  });

  it("parses a supported JSON body", async () => {
    await expect(readJson(new Request("https://auth.test/device", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: '{"enabled":true}',
    }))).resolves.toEqual({ enabled: true });
  });

  it("uses the native error type", () => {
    expect(new QuickloginHttpError("INVALID_REQUEST", 400)).toBeInstanceOf(Error);
  });

  it("accepts the v2 observed-generation heartbeat contract", () => {
    expect(parseHeartbeat({
      protocolVersion: 2,
      observedGeneration: 7,
      appliedVersion: 5,
      browserVersion: "152.0.0.0",
    })).toEqual({
      protocolVersion: 2,
      observedGeneration: 7,
      appliedVersion: 5,
      browserVersion: "152.0.0.0",
    });

    expect(() => parseHeartbeat({
      protocolVersion: 1,
      generation: 7,
      appliedVersion: 5,
      browserVersion: "152.0.0.0",
    })).toThrowError(expect.objectContaining({
      code: "PROTOCOL_UNSUPPORTED",
      status: 426,
    }));
  });
});
