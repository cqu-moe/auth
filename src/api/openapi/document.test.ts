import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { listHttpOperations } from "../operations";
import { buildOpenApiDocument } from "./document";
import { createHttpFixture } from "../../test-utils/http";

describe("complete API document", () => {
  it("matches the runtime method/path set without phantom get-session POST", () => {
    const operations = listHttpOperations(createApp());
    const document = buildOpenApiDocument(operations);
    const documented = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`)
    ).sort();
    const runtime = operations.map(({ method, path }) =>
      `${method} ${path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`
    ).sort();
    expect(documented).toEqual(runtime);
    expect(documented).not.toContain("POST /api/v1/auth/get-session");
    const ids = Object.values(document.paths).flatMap((item) =>
      Object.values(item).map((operation) => (operation as { operationId: string }).operationId)
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(document.components.schemas)).toEqual(expect.arrayContaining([
      "ApiProblem", "PageInfo", "CquSessionStatus", "BindingSnapshot", "EntitlementItem",
      "EntitlementPreset", "RegistrationInvitation", "OAuthClientView",
    ]));
  });

  it("serves the document object without a data envelope", async () => {
    const fixture = createHttpFixture();
    try {
      const response = await createApp().request("/api/v1/openapi.json", {}, fixture.env);
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.openapi).toBe("3.1.1");
      expect(body).toHaveProperty("paths");
      expect(body).not.toHaveProperty("data");
    } finally {
      await fixture.close();
    }
  });
});
