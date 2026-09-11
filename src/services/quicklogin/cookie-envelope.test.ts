import { describe, expect, it } from "vitest";
import type { SsoCookie } from "./contracts";
import {
  digestSsoCookies,
  extractSsoCookies,
  validateSsoCookies,
} from "./cookie-envelope";

const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = NOW_MS / 1_000;

function cookie(overrides: Partial<SsoCookie> = {}): SsoCookie {
  return {
    name: "SOURCEID_TGC",
    value: "synthetic-tgc",
    domain: "sso.cqu.edu.cn",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    expires: NOW_SECONDS + 3_600,
    ...overrides,
  };
}

describe("validateSsoCookies", () => {
  it("accepts the two exact SSO domains and session cookies", () => {
    const cookies = [
      cookie(),
      cookie({
        name: "SESSION",
        value: "synthetic-session",
        domain: ".sso.cqu.edu.cn",
        expires: -1,
      }),
    ];

    expect(validateSsoCookies(cookies, NOW_MS)).toEqual(cookies);
  });

  it("rejects a parent-domain suffix match", () => {
    expect(() =>
      validateSsoCookies([cookie({ domain: ".cqu.edu.cn" as never })], NOW_MS)
    ).toThrowError("INVALID_REQUEST");
  });

  it.each([
    cookie({ value: "" }),
    cookie({ expires: NOW_SECONDS }),
    cookie({ expires: NOW_SECONDS - 1 }),
  ])("rejects an empty or expired SOURCEID_TGC", (tgc) => {
    expect(() => validateSsoCookies([tgc], NOW_MS)).toThrowError(
      "INVALID_REQUEST"
    );
  });

  it("rejects duplicate domain/path/name keys", () => {
    expect(() =>
      validateSsoCookies(
        [cookie(), cookie({ value: "conflicting-value" })],
        NOW_MS
      )
    ).toThrowError("INVALID_REQUEST");
  });

  it("rejects more than 64 cookies", () => {
    const cookies = [cookie()];
    for (let index = 1; index < 65; index += 1) {
      cookies.push(cookie({ name: `cookie-${index}` }));
    }

    expect(() => validateSsoCookies(cookies, NOW_MS)).toThrowError(
      "INVALID_REQUEST"
    );
  });

  it("rejects a cookie payload larger than 256 KiB", () => {
    expect(() =>
      validateSsoCookies([cookie({ value: "x".repeat(256 * 1_024) })], NOW_MS)
    ).toThrowError("INVALID_REQUEST");
  });

  it("rejects partitioned cookie metadata as an unsupported protocol", () => {
    const partitioned = {
      ...cookie(),
      partitionKey: "https://example.edu",
    };

    expect(() => validateSsoCookies([partitioned], NOW_MS)).toThrowError(
      "PROTOCOL_UNSUPPORTED"
    );
  });
});

describe("extractSsoCookies", () => {
  it("exports only unexpired SSO-domain cookies", () => {
    const storageState = JSON.stringify({
      cookies: [
        cookie(),
        cookie({ name: "expired", expires: NOW_SECONDS - 1 }),
        cookie({
          name: "business",
          domain: "my.cqu.edu.cn",
          expires: NOW_SECONDS + 3_600,
        }),
      ],
      origins: [
        {
          origin: "https://sso.cqu.edu.cn",
          localStorage: [{ name: "secret", value: "not-exported" }],
        },
      ],
    });

    expect(extractSsoCookies(storageState, NOW_MS)).toEqual([cookie()]);
  });

  it("omits empty non-TGC placeholders from the exported envelope", () => {
    const storageState = JSON.stringify({
      cookies: [
        cookie(),
        cookie({ name: "clientThemeKey", value: "", expires: -1 }),
      ],
      origins: [],
    });

    expect(extractSsoCookies(storageState, NOW_MS)).toEqual([cookie()]);
  });

  it("does not treat the parent CQU domain as an SSO allowlist match", () => {
    const storageState = JSON.stringify({
      cookies: [cookie({ domain: ".cqu.edu.cn" as never })],
      origins: [],
    });

    expect(() => extractSsoCookies(storageState, NOW_MS)).toThrowError(
      "INVALID_REQUEST"
    );
  });
});

describe("digestSsoCookies", () => {
  it("is stable across input order and changes when an exported value changes", async () => {
    const first = cookie();
    const second = cookie({
      name: "SESSION",
      value: "synthetic-session",
      domain: ".sso.cqu.edu.cn",
      expires: -1,
    });

    const digest = await digestSsoCookies([first, second]);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(digestSsoCookies([second, first])).resolves.toBe(digest);
    await expect(
      digestSsoCookies([first, { ...second, value: "rotated-session" }])
    ).resolves.not.toBe(digest);
  });
});
