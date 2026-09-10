import type { Env } from "../../types";

export function quickloginDeviceModeEnabled(
  env: Pick<Env, "QUICKLOGIN_DEVICE_MODE">
): boolean {
  return env.QUICKLOGIN_DEVICE_MODE === "on";
}
