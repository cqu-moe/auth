import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { CquSessionRecoveryParams, Env } from "../types";
export type { CquSessionRecoveryParams } from "../types";

type RecoveryState = "complete" | "needs_reauth" | "waiting" | "failed";
type TerminalState = Exclude<RecoveryState, "waiting">;

interface TickResult {
  state: RecoveryState;
  retryAt?: number;
}

export interface RecoveryWorkflowResult {
  state: TerminalState;
  cleanupComplete: boolean;
}

const MAX_CYCLE_MS = 30 * 60_000;
const MAX_TICKS = 120;
const MIN_WAIT_MS = 5_000;
const TRANSPORT_STEP = {
  retries: { limit: 2, delay: "2 seconds" as const, backoff: "constant" as const },
  timeout: "20 seconds" as const,
};

function isTickResult(value: unknown): value is TickResult {
  if (!value || typeof value !== "object") return false;
  const result = value as { state?: unknown; retryAt?: unknown };
  return (
    ["complete", "needs_reauth", "waiting", "failed"].includes(
      result.state as string
    ) &&
    (result.retryAt === undefined ||
      (typeof result.retryAt === "number" && Number.isFinite(result.retryAt)))
  );
}

async function postSession(
  env: Pick<Env, "CQU_SESSION">,
  userId: string,
  path: "/recovery-tick" | "/recovery-finish",
  body: Record<string, unknown>
): Promise<Response> {
  const id = env.CQU_SESSION.idFromName(userId);
  return env.CQU_SESSION.get(id).fetch(`http://do${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function runCquSessionRecovery(
  env: Pick<Env, "CQU_SESSION">,
  event: Readonly<WorkflowEvent<CquSessionRecoveryParams>>,
  step: WorkflowStep
): Promise<RecoveryWorkflowResult> {
  const params = event.payload;
  const startedAt = event.timestamp.getTime();
  const requestedDeadline = Number.isFinite(params.deadlineAt)
    ? params.deadlineAt
    : startedAt;
  const deadlineAt = Math.min(requestedDeadline, startedAt + MAX_CYCLE_MS);
  let outcome: TerminalState = "failed";

  try {
    if (!params.userId || !params.recoveryId || deadlineAt <= startedAt) {
      throw new Error("invalid recovery workflow parameters");
    }

    for (let iteration = 0; iteration < MAX_TICKS; iteration += 1) {
      const tick = await step.do(
        `recovery tick ${iteration + 1}`,
        TRANSPORT_STEP,
        async () => {
          const now = Date.now();
          if (now >= deadlineAt) return { state: "failed" } satisfies TickResult;
          const response = await postSession(
            env,
            params.userId,
            "/recovery-tick",
            { recoveryId: params.recoveryId, deadlineAt }
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`recovery tick transport failed: ${response.status}`);
          }
          const result: unknown = await response.json();
          if (!isTickResult(result)) {
            throw new Error("recovery tick returned an invalid response");
          }
          if (result.state !== "waiting") return result;
          const requestedRetryAt = result.retryAt ?? now + MIN_WAIT_MS;
          return {
            state: "waiting",
            retryAt: Math.min(
              deadlineAt,
              Math.max(now + MIN_WAIT_MS, requestedRetryAt)
            ),
          } satisfies TickResult;
        }
      );

      if (tick.state !== "waiting") {
        outcome = tick.state;
        break;
      }

      if (iteration === MAX_TICKS - 1) break;
      await step.sleepUntil(`recovery wait ${iteration + 1}`, tick.retryAt!);
    }
  } catch {
    outcome = "failed";
  }

  let cleanupComplete = false;
  try {
    await step.do("recovery finish", TRANSPORT_STEP, async () => {
      const response = await postSession(
        env,
        params.userId,
        "/recovery-finish",
        { recoveryId: params.recoveryId, outcome }
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`recovery finish transport failed: ${response.status}`);
      }
      await response.body?.cancel();
    });
    cleanupComplete = true;
  } catch {
    // The cleanup attempt is itself durable and retried. The DO keeps the matching
    // cycle fenced until a later start/tick can reconcile it.
  }

  return { state: outcome, cleanupComplete };
}

export class CquSessionRecoveryWorkflow extends WorkflowEntrypoint<
  Env,
  CquSessionRecoveryParams
> {
  override run(
    event: Readonly<WorkflowEvent<CquSessionRecoveryParams>>,
    step: WorkflowStep
  ): Promise<RecoveryWorkflowResult> {
    return runCquSessionRecovery(this.env, event, step);
  }
}
