export type CquBindingEvent = {
  type: "login_2fa" | "bind_code";
  code: string;
  ts?: number;
  remainingMs?: number;
};

export function parseCquBindingEvent(value: unknown): CquBindingEvent | null {
  if (value === "pong") return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const event = parsed as Record<string, unknown>;
  if ((event.type !== "login_2fa" && event.type !== "bind_code") || typeof event.code !== "string" || !event.code) {
    return null;
  }
  return {
    type: event.type,
    code: event.code,
    ...(typeof event.ts === "number" ? { ts: event.ts } : {}),
    ...(typeof event.remainingMs === "number" ? { remainingMs: event.remainingMs } : {}),
  };
}
