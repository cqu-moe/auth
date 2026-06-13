import { describe, it, expect } from "vitest";
import { localPart } from "./address";

describe("localPart", () => {
  it("extracts local part, lowercased", () => {
    expect(localPart("AbC123@bind.cqu.moe")).toBe("abc123");
  });
  it("strips +subaddressing", () => {
    expect(localPart("tok+anything@bind.cqu.moe")).toBe("tok");
  });
  it("returns empty for malformed", () => {
    expect(localPart("not-an-email")).toBe("");
  });
});
