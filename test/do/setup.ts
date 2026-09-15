import { env } from "cloudflare:test";
import { beforeEach, vi } from "vitest";

function workflowInstance(id: string): WorkflowInstance {
  return {
    id,
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    status: vi.fn(async () => ({ status: "running" as const })),
    sendEvent: vi.fn(async () => undefined),
  } as WorkflowInstance;
}

beforeEach(() => {
  vi.spyOn(env.CQU_SESSION_RECOVERY, "create").mockImplementation(
    async (options) => workflowInstance(options?.id ?? crypto.randomUUID())
  );
  vi.spyOn(env.CQU_SESSION_RECOVERY, "get").mockImplementation(
    async (id) => workflowInstance(id)
  );
});
