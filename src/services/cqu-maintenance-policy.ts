import type { Env } from "../types";

export const CQU_PROACTIVE_RELOGIN_MS = 7 * 60 * 60_000;

type ExperimentEnv = Pick<Env,
  "CQU_NO_PROBE_EXPERIMENT_USER_ID" | "CQU_NO_PROBE_EXPERIMENT_DEVICE_ID"
>;

export function skipAccountProbes(env: ExperimentEnv, userId: string): boolean {
  return !!userId && env.CQU_NO_PROBE_EXPERIMENT_USER_ID === userId;
}

export function skipDeviceProbes(env: ExperimentEnv, userId: string, deviceId: string): boolean {
  return skipAccountProbes(env, userId) && !!deviceId
    && env.CQU_NO_PROBE_EXPERIMENT_DEVICE_ID === deviceId;
}
