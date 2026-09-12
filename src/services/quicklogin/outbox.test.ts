import { describe, expect, it } from "vitest";
import { mergeOutboxEvents, type OutboxEvent } from "./outbox";

function event(
  id: string,
  kind: OutboxEvent["kind"],
  revision: number,
  fields: Partial<OutboxEvent> = {}
): OutboxEvent {
  return { id, kind, revision, attempts: 0, nextAttemptAt: revision, ...fields };
}

describe("bounded QuickLogin outbox", () => {
  it("coalesces 1000 failed projection, notify, and revoke updates to their latest semantics", () => {
    let outbox: OutboxEvent[] = [];
    for (let revision = 1; revision <= 1000; revision += 1) {
      outbox = mergeOutboxEvents(outbox, [
        event(`projection-${revision}`, "projection", revision),
        event(`notify-${revision}`, "device-notify", revision, {
          deviceId: "device-a", generation: revision,
        }),
        event(`revoke-${revision}`, "revoke-oauth-family", revision, {
          grantId: "grant-a",
        }),
      ]);
    }
    expect(outbox).toHaveLength(3);
    expect(outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "projection", revision: 1000 }),
      expect.objectContaining({ kind: "device-notify", deviceId: "device-a", generation: 1000 }),
      expect.objectContaining({ kind: "revoke-oauth-family", grantId: "grant-a", revision: 1000 }),
    ]));
  });

  it("never silently evicts a distinct OAuth grant revocation at the hard limit", () => {
    const full = Array.from({ length: 256 }, (_, index) =>
      event(`revoke-${index}`, "revoke-oauth-family", index, { grantId: `grant-${index}` })
    );
    expect(() => mergeOutboxEvents(full, [
      event("revoke-overflow", "revoke-oauth-family", 257, { grantId: "grant-overflow" }),
    ])).toThrow("QuickLogin outbox critical capacity exceeded");
    expect(full).toHaveLength(256);
  });
});
