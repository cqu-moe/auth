type Surface = "web" | "worker";
type Fields = Record<string, unknown>;

const ERROR_TYPES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "DOMException", "AbortError", "AggregateError"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fields(value: unknown): Fields {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
}

function label(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value) ? value : fallback;
}

function frameFilename(value: unknown, surface: Surface): string | undefined {
  if (typeof value !== "string") return;
  if (surface === "worker") {
    if (/^(?:index|worker|cqu-moe-auth)\.m?js$/.test(value)) return value;
    return;
  }
  try {
    const url = new URL(value);
    if (url.origin === "https://auth.cqu.moe" && !url.username && !url.password && /^\/assets\/[A-Za-z0-9_-]+\.js$/.test(url.pathname)) {
      return url.origin + url.pathname;
    }
  } catch { /* Ignore eval, local files and browser-extension frames. */ }
}

export function sanitizedExceptionProperties(source: Fields, surface: Surface): Fields {
  const first = fields(Array.isArray(source.$exception_list) ? source.$exception_list[0] : undefined);
  const type = typeof first.type === "string" && ERROR_TYPES.has(first.type) ? first.type : "Error";
  const stack = fields(first.stacktrace);
  const frames: Fields[] = [];
  for (const input of Array.isArray(stack.frames) ? stack.frames.slice(-50) : []) {
    const raw = fields(input);
    const filename = frameFilename(raw.filename, surface);
    if (!filename || !Number.isSafeInteger(raw.lineno) || Number(raw.lineno) <= 0) continue;
    const frame: Fields = { platform: surface === "web" ? "web:javascript" : "node:javascript", filename, lineno: raw.lineno, in_app: true };
    if (Number.isSafeInteger(raw.colno) && Number(raw.colno) > 0) frame.colno = raw.colno;
    if (typeof raw.function === "string" && /^(?:async )?[A-Za-z_$][A-Za-z0-9_$.<>]{0,127}$/.test(raw.function)) frame.function = raw.function;
    if (typeof raw.chunk_id === "string" && UUID.test(raw.chunk_id)) frame.chunk_id = raw.chunk_id;
    frames.push(frame);
  }
  const operation = label(source.operation, "exception");
  const errorCode = label(source.error_code, "EXCEPTION");
  return {
    $exception_list: [{
      type,
      value: surface === "web" ? "Browser operation failed" : "Worker operation failed",
      mechanism: { type: "generic", handled: fields(first.mechanism).handled === true },
      ...(frames.length ? { stacktrace: { type: "raw", frames } } : {}),
    }],
    $exception_type: type,
    ...(operation !== "exception" || errorCode !== "EXCEPTION"
      ? { $exception_fingerprint: `auth:${surface}:${operation}:${errorCode}:${type}` }
      : {}),
    $issue_name: `${operation}: ${errorCode} (${type})`,
    operation,
    error_code: errorCode,
    outcome: "failure",
  };
}
