import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { allowedMethods, listHttpOperations } from "./operations";
import { createApp } from "../app";
import { AUTH_OPERATIONS } from "./auth-operations.generated";

describe("HTTP operation inventory", () => {
  it("derives concrete methods and matches one-segment parameters", () => {
    const app = new Hono();
    app.get("/api/v1/users/:id", (c) => c.json({ id: c.req.param("id") }));
    app.patch("/api/v1/users/:id", (c) => c.body(null, 204));

    const operations = listHttpOperations(app);

    expect(operations).toEqual([
      { method: "GET", path: "/api/v1/users/:id" },
      { method: "PATCH", path: "/api/v1/users/:id" },
    ]);
    expect(allowedMethods(operations, "/api/v1/users/local-user"))
      .toEqual(["GET", "HEAD", "PATCH", "OPTIONS"]);
    expect(allowedMethods(operations, "/api/v1/users/a/b")).toEqual([]);
  });

  it("does not derive HEAD for a websocket event route", () => {
    const app = new Hono();
    app.get("/api/v1/cqu/binding/events", (c) => c.body(null, 426));
    const operations = listHttpOperations(app);
    expect(allowedMethods(operations, "/api/v1/cqu/binding/events"))
      .toEqual(["GET", "OPTIONS"]);
  });

  it("mounts every generated auth operation canonically with no legacy operations", () => {
    const operations = listHttpOperations(createApp());
    const keys = new Set(operations.map(({ method, path }) => `${method} ${path}`));
    for (const { method, path } of AUTH_OPERATIONS) {
      expect(keys.has(`${method} /api/v1/auth${path}`), `canonical ${method} ${path}`).toBe(true);
    }
    expect(keys.has("GET /api/auth/oauth2/authorize")).toBe(false);
    expect(keys.has("POST /api/auth/oauth2/token")).toBe(false);
    expect(keys.has("GET /api/auth/reset-password/:token")).toBe(false);
    expect(keys.has("GET /api/auth/get-session")).toBe(false);
    expect(keys.has("POST /api/auth/email-otp/send-verification-otp")).toBe(false);
    expect(keys.has("GET /api/cqu/quicklogin/devices")).toBe(false);
    expect(keys.has("POST /api/cqu/quicklogin/devices/:id/export")).toBe(false);
    expect(keys.has("POST /api/v1/auth/get-session")).toBe(false);
    expect(keys.has("POST /api/auth/get-session")).toBe(false);
    expect(keys.has("GET /api/v1/auth/token")).toBe(false);
    expect(keys.has("POST /api/v1/auth/sign-in/email-otp")).toBe(false);
  });

  it("exposes only canonical QuickLogin operations", () => {
    const operations = listHttpOperations(createApp());
    const quicklogin = operations
      .filter(({ path }) => path.includes("quicklogin"))
      .map(({ method, path }) => `${method} ${path}`)
      .sort();

    expect(quicklogin).toEqual([
      "GET /api/v1/cqu/quicklogin/capabilities",
      "GET /api/v1/cqu/quicklogin/overview",
      "GET /api/v1/cqu/quicklogin/devices/:id/operations/:operationId",
      "POST /api/v1/cqu/quicklogin/registrations",
      "POST /api/v1/cqu/quicklogin/devices/:id/reconcile",
      "POST /api/v1/cqu/quicklogin/devices/:id/operations",
      "POST /api/v1/cqu/quicklogin/devices/:id/exports",
      "POST /api/v1/cqu/quicklogin/devices/:id/receipts",
      "POST /api/v1/cqu/quicklogin/devices/:id/resume-ticket",
      "OPTIONS /api/v1/cqu/quicklogin/capabilities",
      "OPTIONS /api/v1/cqu/quicklogin/registrations",
      "OPTIONS /api/v1/cqu/quicklogin/overview",
      "OPTIONS /api/v1/cqu/quicklogin/devices/:id/reconcile",
      "OPTIONS /api/v1/cqu/quicklogin/devices/:id/operations",
      "OPTIONS /api/v1/cqu/quicklogin/devices/:id/operations/:operationId",
      "OPTIONS /api/v1/cqu/quicklogin/devices/:id/exports",
      "OPTIONS /api/v1/cqu/quicklogin/devices/:id/receipts",
      "OPTIONS /api/v1/cqu/quicklogin/devices/:id/resume-ticket",
      "DELETE /api/v1/cqu/quicklogin/devices/:id",
      "GET /api/v1/cqu/quicklogin",
      "GET /api/v1/cqu/quicklogin/devices",
      "OPTIONS /api/v1/cqu/quicklogin/devices",
      "OPTIONS /api/v1/cqu/quicklogin/devices/:id",
      "OPTIONS /api/v1/cqu/quicklogin/devices/:id/export",
      "OPTIONS /api/v1/cqu/quicklogin/devices/:id/refresh",
      "OPTIONS /api/v1/cqu/quicklogin/devices/:id/status",
      "POST /api/v1/admin/users/:id/quicklogin-policy/preview",
      "POST /api/v1/admin/users/:id/quicklogin-quota/preview",
      "POST /api/v1/cqu/quicklogin/devices",
      "POST /api/v1/cqu/quicklogin/devices/:id/export",
      "POST /api/v1/cqu/quicklogin/devices/:id/refresh",
      "POST /api/v1/cqu/quicklogin/devices/:id/status",
      "PUT /api/v1/admin/users/:id/quicklogin-policy/initialize",
      "PUT /api/v1/admin/users/:id/quicklogin-quota",
      "PUT /api/v1/cqu/quicklogin",
      "PUT /api/v1/cqu/quicklogin/devices/:id",
    ].sort());
    expect(quicklogin.some((entry) => entry.includes("*"))).toBe(false);
    expect(quicklogin).not.toContain("GET /api/cqu/quicklogin");
  });
});
