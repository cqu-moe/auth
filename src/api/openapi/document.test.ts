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
      const paths = body.paths as Record<string, any>;
      expect(Object.keys(paths["/api/v1/auth/get-session"])).toEqual(["get"]);
      expect(paths["/api/v1/auth/get-session"].get.responses["200"].content["application/json"].schema.properties)
        .toHaveProperty("caps");
      expect(paths["/api/v1/auth/sign-up/email"].post.requestBody.content["application/json"].schema.properties.code)
        .toMatchObject({ type: "string", pattern: "^[A-Z0-9]{8}$" });
      expect(paths["/api/v1/auth/error"].get.responses).toHaveProperty("302");
      expect(JSON.stringify(body)).not.toContain('"nullable"');
    } finally {
      await fixture.close();
    }
  });
});
