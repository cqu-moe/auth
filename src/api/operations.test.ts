import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { allowedMethods, listHttpOperations } from "./operations";

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
});
