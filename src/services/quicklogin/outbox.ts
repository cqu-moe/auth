import type { DeviceId, GrantId } from "./contracts";

export type OutboxKind =
  | "device-notify"
  | "projection"
  | "revoke-oauth-family";

export interface OutboxEvent {
  id: string;
  kind: OutboxKind;
  revision: number;
  deviceId?: DeviceId;
  generation?: number;
  grantId?: GrantId;
  attempts: number;
  nextAttemptAt: number;
}

export type OutboxDispatcher = (event: OutboxEvent) => Promise<boolean>;

const MAX_BACKOFF_MS = 6 * 60 * 60_000;

export async function dispatchOutboxEvent(
  event: OutboxEvent,
  dispatcher?: OutboxDispatcher
): Promise<boolean> {
  if (!dispatcher) return false;
  return dispatcher(event);
}

export function deferOutboxEvent(
  event: OutboxEvent,
  now: number
): OutboxEvent {
  const attempts = event.attempts + 1;
  const exponent = Math.min(attempts - 1, 15);
  const delay = Math.min(1_000 * 2 ** exponent, MAX_BACKOFF_MS);
  return { ...event, attempts, nextAttemptAt: now + delay };
}

export function nextOutboxAlarm(events: OutboxEvent[]): number | null {
  if (events.length === 0) return null;
  return Math.min(...events.map((event) => event.nextAttemptAt));
}
