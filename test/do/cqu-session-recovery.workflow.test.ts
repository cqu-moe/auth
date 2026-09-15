import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runCquSessionRecovery,
  type CquSessionRecoveryParams,
} from "../../src/workflows/cqu-session-recovery";

interface FakeStep {
  step: WorkflowStep;
  calls: Array<{ name: string; config?: WorkflowStepConfig }>;
  sleeps: Array<{ name: string; timestamp: number }>;
}

function fakeStep(): FakeStep {
  const calls: FakeStep["calls"] = [];
  const sleeps: FakeStep["sleeps"] = [];
  return {
    calls,
    sleeps,
    step: {
      async do<T>(
        name: string,
        configOrCallback: WorkflowStepConfig | (() => Promise<T>),
        maybeCallback?: () => Promise<T>
      ): Promise<T> {
        const config = typeof configOrCallback === "function" ? undefined : configOrCallback;
        calls.push({ name, config });
        return (typeof configOrCallback === "function"
          ? configOrCallback
          : maybeCallback!)();
      },
      async sleepUntil(name: string, timestamp: Date | number) {
        sleeps.push({
          name,
          timestamp: timestamp instanceof Date ? timestamp.getTime() : timestamp,
        });
      },
    } as WorkflowStep,
  };
}

function fixture(responses: Response[]) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(input instanceof Request ? input : new Request(input, init));
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  });
  return {
    env: {
      CQU_SESSION: {
        idFromName: (name: string) => name,
        get: () => ({ fetch }),
      } as unknown as DurableObjectNamespace,
    },
    requests,
  };
}

function event(payload: CquSessionRecoveryParams, startedAt: number) {
  return {
    payload,
    timestamp: new Date(startedAt),
    instanceId: payload.recoveryId,
  } satisfies WorkflowEvent<CquSessionRecoveryParams>;
}

afterEach(() => vi.useRealTimers());

describe("CquSessionRecoveryWorkflow", () => {
  it("durably waits for the requested retry and finishes the matching cycle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { env, requests } = fixture([
      Response.json({ state: "waiting", retryAt: 1_030_000 }),
      Response.json({ state: "complete" }),
      Response.json({ ok: true }),
    ]);
    const fake = fakeStep();
    fake.step.sleepUntil = async (name, timestamp) => {
      const value = timestamp instanceof Date ? timestamp.getTime() : timestamp;
      fake.sleeps.push({ name, timestamp: value });
      vi.setSystemTime(value);
    };

    const result = await runCquSessionRecovery(
      env,
      event({ userId: "u1", recoveryId: "r1", deadlineAt: 1_600_000 }, 1_000_000),
      fake.step
    );

    expect(result).toEqual({ state: "complete", cleanupComplete: true });
    expect(fake.sleeps).toEqual([{ name: "recovery wait 1", timestamp: 1_030_000 }]);
    expect(fake.calls.map((call) => call.name)).toEqual([
      "recovery tick 1",
      "recovery tick 2",
      "recovery finish",
    ]);
    expect(fake.calls[0]!.config).toMatchObject({
      retries: { limit: 2, delay: "2 seconds" },
      timeout: "20 seconds",
    });
    expect(await requests[0]!.json()).toEqual({ recoveryId: "r1", deadlineAt: 1_600_000 });
    expect(await requests[2]!.json()).toEqual({ recoveryId: "r1", outcome: "complete" });
  });

  it("converts a tick transport error to failed and still runs durable cleanup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const { env, requests } = fixture([
      new Response("unavailable", { status: 503 }),
      Response.json({ ok: true }),
    ]);
    const fake = fakeStep();

    const result = await runCquSessionRecovery(
      env,
      event({ userId: "u2", recoveryId: "r2", deadlineAt: 2_600_000 }, 2_000_000),
      fake.step
    );

    expect(result).toEqual({ state: "failed", cleanupComplete: true });
    expect(fake.calls.map((call) => call.name)).toEqual([
      "recovery tick 1",
      "recovery finish",
    ]);
    expect(new URL(requests[1]!.url).pathname).toBe("/recovery-finish");
    expect(await requests[1]!.json()).toEqual({ recoveryId: "r2", outcome: "failed" });
  });

  it("clamps each wait to five seconds and the thirty-minute cycle deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    const { env, requests } = fixture([
      Response.json({ state: "waiting", retryAt: 3_000_001 }),
      Response.json({ ok: true }),
    ]);
    const fake = fakeStep();
    fake.step.sleepUntil = async (name, timestamp) => {
      const value = timestamp instanceof Date ? timestamp.getTime() : timestamp;
      fake.sleeps.push({ name, timestamp: value });
      vi.setSystemTime(4_800_000);
    };

    const result = await runCquSessionRecovery(
      env,
      event({ userId: "u3", recoveryId: "r3", deadlineAt: 99_000_000 }, 3_000_000),
      fake.step
    );

    expect(result.state).toBe("failed");
    expect(fake.sleeps[0]!.timestamp).toBe(3_005_000);
    expect(await requests[0]!.json()).toEqual({ recoveryId: "r3", deadlineAt: 4_800_000 });
  });

  it("replays a recorded terminal tick without re-evaluating the advanced clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(9_000_000);
    const { env, requests } = fixture([Response.json({ ok: true })]);
    const fake = fakeStep();
    fake.step.do = (async (
      name: string,
      configOrCallback: WorkflowStepConfig | (() => Promise<unknown>),
      maybeCallback?: () => Promise<unknown>
    ) => {
      if (name === "recovery tick 1") {
        fake.calls.push({ name });
        return { state: "complete" };
      }
      const config =
        typeof configOrCallback === "function" ? undefined : configOrCallback;
      fake.calls.push({ name, config });
      return (typeof configOrCallback === "function"
        ? configOrCallback
        : maybeCallback!)();
    }) as WorkflowStep["do"];

    const result = await runCquSessionRecovery(
      env,
      event({ userId: "u4", recoveryId: "r4", deadlineAt: 8_000_000 }, 7_000_000),
      fake.step
    );

    expect(result).toEqual({ state: "complete", cleanupComplete: true });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe("/recovery-finish");
  });

  it("does not sleep after the final bounded tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    const waiting = Array.from({ length: 120 }, () =>
      Response.json({ state: "waiting", retryAt: 10_005_000 })
    );
    const { env } = fixture([...waiting, Response.json({ ok: true })]);
    const fake = fakeStep();

    const result = await runCquSessionRecovery(
      env,
      event(
        { userId: "u5", recoveryId: "r5", deadlineAt: 11_800_000 },
        10_000_000
      ),
      fake.step
    );

    expect(result).toEqual({ state: "failed", cleanupComplete: true });
    expect(fake.calls.filter((call) => call.name.startsWith("recovery tick"))).toHaveLength(120);
    expect(fake.sleeps).toHaveLength(119);
  });
});
