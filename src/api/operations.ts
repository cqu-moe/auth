import type { Hono } from "hono";

export interface HttpOperation {
  method: string;
  path: string;
}

export function listHttpOperations(
  app: Hono<any, any, any>,
  authEndpoints: readonly HttpOperation[] = []
): HttpOperation[] {
  const operations = app.routes
    .filter((route) => route.method !== "ALL" && route.path.startsWith("/api"))
    .map((route) => ({ method: route.method, path: route.path }));
  const seen = new Set<string>();
  return [...operations, ...authEndpoints].filter((operation) => {
    const key = `${operation.method} ${operation.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pathMatches(template: string, pathname: string): boolean {
  const expected = template.split("/");
  const actual = pathname.split("/");
  return expected.length === actual.length && expected.every((segment, index) =>
    segment.startsWith(":") || segment === actual[index]
  );
}

export function allowedMethods(
  operations: readonly HttpOperation[],
  pathname: string
): string[] {
  const methods = new Set(
    operations.filter((operation) => pathMatches(operation.path, pathname))
      .map((operation) => operation.method)
  );
  if (methods.has("GET") && !pathname.endsWith("/events")) methods.add("HEAD");
  if (methods.size) methods.add("OPTIONS");
  const order = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
  return order.filter((method) => methods.has(method));
}
