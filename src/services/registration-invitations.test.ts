import { describe, expect, it } from "vitest";
import {
  generateInvitationCode,
  normalizeInvitationCode,
} from "./registration-invitations";

describe("registration invitation codes", () => {
  it("normalizes surrounding whitespace and letter case", () => {
    expect(normalizeInvitationCode("  abcd2efg  ")).toBe("ABCD2EFG");
  });

  it.each(["", "ABC", "ABCD0EFG", "ABCDOEFG", "ABCD1EFG", "ABCDIEFG", "ABCD-EFG"])(
    "rejects malformed or ambiguous code %s",
    (value) => {
      expect(normalizeInvitationCode(value)).toBe(null);
    }
  );

  it("generates an eight-character code without ambiguous characters", () => {
    for (let i = 0; i < 100; i++) {
      expect(generateInvitationCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });
});
