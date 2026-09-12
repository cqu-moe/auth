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

  it("mounts every generated auth operation canonically and only the legacy transition bridge", () => {
    const operations = listHttpOperations(createApp());
    const keys = new Set(operations.map(({ method, path }) => `${method} ${path}`));
    for (const { method, path } of AUTH_OPERATIONS) {
      expect(keys.has(`${method} /api/v1/auth${path}`), `canonical ${method} ${path}`).toBe(true);
    }
    expect(keys.has("GET /api/auth/oauth2/authorize")).toBe(true);
    expect(keys.has("POST /api/auth/oauth2/token")).toBe(true);
    expect(keys.has("GET /api/auth/reset-password/:token")).toBe(true);
    expect(keys.has("GET /api/auth/get-session")).toBe(false);
    expect(keys.has("POST /api/auth/email-otp/send-verification-otp")).toBe(false);
    expect(keys.has("GET /api/cqu/quicklogin/devices")).toBe(true);
    expect(keys.has("POST /api/cqu/quicklogin/devices/:id/export")).toBe(true);
    expect(keys.has("POST /api/v1/auth/get-session")).toBe(false);
    expect(keys.has("POST /api/auth/get-session")).toBe(false);
    expect(keys.has("GET /api/v1/auth/token")).toBe(false);
    expect(keys.has("POST /api/v1/auth/sign-in/email-otp")).toBe(false);
  });
});
