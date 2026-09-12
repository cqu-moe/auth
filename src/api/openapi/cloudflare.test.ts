import { describe, expect, it } from "vitest";
import { toCloudflareSchema } from "./cloudflare";

describe("Cloudflare OpenAPI 3.0 schema projection", () => {
  it("preserves nullable, const, and numeric exclusive bounds", () => {
    expect(toCloudflareSchema({ type: ["string", "null"] }, "#/Status"))
      .toEqual({ type: "string", nullable: true });
    expect(toCloudflareSchema({ type: "string", const: "active" }, "#/Status"))
      .toEqual({ type: "string", enum: ["active"] });
    expect(toCloudflareSchema({ type: "number", exclusiveMinimum: 0 }, "#/Quota"))
      .toEqual({ type: "number", minimum: 0, exclusiveMinimum: true });
    expect(toCloudflareSchema({
      anyOf: [
        { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        { type: "null" },
      ],
    }, "#/AppliedVersion")).toEqual({
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      nullable: true,
    });
  });

  it("fails with a JSON pointer instead of dropping unsupported semantics", () => {
    expect(() => toCloudflareSchema(
      { type: "object", unevaluatedProperties: false },
      "#/components/schemas/Unsupported"
    )).toThrow("#/components/schemas/Unsupported");
  });

  it("omits patterns because Cloudflare does not document its accepted regex subset", () => {
    expect(toCloudflareSchema(
      { type: "string", minLength: 1, pattern: "^(?!\\s).+$" },
      "#/components/schemas/LookAhead"
    )).toEqual({ type: "string", minLength: 1 });
    expect(toCloudflareSchema(
      { type: "string", pattern: "^[^\\ud800-\\udfff]+$" },
      "#/components/schemas/SurrogateRange"
    )).toEqual({ type: "string" });
    expect(toCloudflareSchema(
      { type: "string", pattern: "^[A-Z0-9]{8}$" },
      "#/components/schemas/InvitationCode"
    )).toEqual({ type: "string" });
  });
});
