import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateSsoCookies } from "./cookie-envelope";
import type { CookieEnvelope, DeviceStatus } from "./contracts";

async function fixture() {
  return JSON.parse(await readFile(
    new URL("./fixtures/protocol-v2.json", import.meta.url), "utf8"
  )) as { status: DeviceStatus; envelope: CookieEnvelope };
}

function validateStatus(status: DeviceStatus): void {
  if (status.protocolVersion !== 2 || !status.deviceId ||
      !Number.isSafeInteger(status.generation) || status.generation < 0 ||
      !Number.isSafeInteger(status.sessionVersion) || status.sessionVersion < 0 ||
      !Number.isSafeInteger(status.deviceLimit) || status.deviceLimit < 0 ||
      !Number.isSafeInteger(status.used) || status.used < 0) {
    throw new Error("INVALID_STATUS");
  }
}

function validateEnvelope(envelope: CookieEnvelope): void {
  if (envelope.protocolVersion !== 2 || !envelope.deviceId ||
      !Number.isSafeInteger(envelope.generation) ||
      !Number.isSafeInteger(envelope.sessionVersion) ||
      new TextEncoder().encode(JSON.stringify(envelope)).length > 256 * 1024) {
    throw new Error("INVALID_ENVELOPE");
  }
  validateSsoCookies(envelope.cookies, envelope.createdAt);
}

describe("shared protocol v2 fixture", () => {
  it("accepts the same synthetic status and envelope as the extension", async () => {
    const value = await fixture();
    expect(() => validateStatus(value.status)).not.toThrow();
    expect(() => validateEnvelope(value.envelope)).not.toThrow();
    expect(value.status).toMatchObject({ generation: 4, sessionVersion: 7 });
  });

  it("rejects protocol drift, parent-domain cookies and oversized payloads", async () => {
    const value = await fixture();
    expect(() => validateStatus({ ...value.status, protocolVersion: 1 as 2 })).toThrow();
    expect(() => validateEnvelope({
      ...value.envelope,
      cookies: value.envelope.cookies.map((cookie) => ({
        ...cookie,
        domain: ".cqu.edu.cn" as "sso.cqu.edu.cn",
      })),
    })).toThrow();
    expect(() => validateEnvelope({
      ...value.envelope,
      cookies: [{ ...value.envelope.cookies[0], value: "x".repeat(260 * 1024) }],
    })).toThrow();
  });
});
