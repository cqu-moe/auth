export const CQU_PROACTIVE_RELOGIN_MS = 7 * 60 * 60_000;

/** Draw once per successful login and persist: 99% at 6–7h, 1% at 4–6h. */
export function sampleCquReloginAt(loginAt: number): number {
  const sample = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
  const hours = sample < 0.01
    ? 4 + (sample / 0.01) * 2
    : 6 + (sample - 0.01) / 0.99;
  return loginAt + Math.floor(hours * 60 * 60_000);
}
