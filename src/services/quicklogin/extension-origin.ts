import type { Env } from "../../types";

type ExtensionOriginEnv = Pick<Env,
  "QUICKLOGIN_EXTENSION_ORIGIN" | "QUICKLOGIN_STORE_EXTENSION_ORIGIN">;

export function quickloginExtensionOrigins(env: ExtensionOriginEnv): string[] {
  const origins = [env.QUICKLOGIN_EXTENSION_ORIGIN];
  if (env.QUICKLOGIN_STORE_EXTENSION_ORIGIN !== undefined) {
    origins.push(env.QUICKLOGIN_STORE_EXTENSION_ORIGIN);
  }
  if (!origins.every(origin => typeof origin === "string" &&
    /^chrome-extension:\/\/[a-p]{32}$/.test(origin))) return [];
  return [...new Set(origins)];
}

export function acceptedQuickloginOrigin(
  env: ExtensionOriginEnv,
  origin: string | undefined
): string | null {
  return origin && quickloginExtensionOrigins(env).includes(origin) ? origin : null;
}
