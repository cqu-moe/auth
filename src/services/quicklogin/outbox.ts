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
export const MAX_OUTBOX_EVENTS = 256;

function stableKey(event: OutboxEvent): string {
  if (event.kind === "projection") return "projection";
  if (event.kind === "device-notify" && event.deviceId) {
    return `device-notify:${event.deviceId}`;
  }
  if (event.kind === "revoke-oauth-family" && event.grantId) {
    return `revoke-oauth-family:${event.grantId}`;
  }
  throw new Error(`QuickLogin outbox event lacks a stable key: ${event.kind}`);
}

function isNewer(left: OutboxEvent, right: OutboxEvent): boolean {
  if (left.revision !== right.revision) return left.revision > right.revision;
  return (left.generation ?? -1) >= (right.generation ?? -1);
}

export function mergeOutboxEvents(
  current: readonly OutboxEvent[],
  incoming: readonly OutboxEvent[],
  limit = MAX_OUTBOX_EVENTS
): OutboxEvent[] {
  const latest = new Map<string, OutboxEvent>();
  for (const event of [...current, ...incoming]) {
    const key = stableKey(event);
    const existing = latest.get(key);
    if (!existing || isNewer(event, existing)) latest.set(key, event);
  }
  const events = [...latest.values()].sort((left, right) => {
    const priority = (event: OutboxEvent) => event.kind === "revoke-oauth-family" ? 0 :
      event.kind === "device-notify" ? 1 : 2;
    return priority(left) - priority(right) || left.revision - right.revision ||
      stableKey(left).localeCompare(stableKey(right));
  });
  if (events.length > limit) {
    throw new Error("QuickLogin outbox critical capacity exceeded");
  }
  return events;
}

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
