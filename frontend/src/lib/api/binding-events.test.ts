// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openBindingEvents } from "./binding-events";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; this.onclose?.(); });
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("binding event transport", () => {
  it("is close-idempotent and ignores malformed, pong, and late events", () => {
    const onEvent = vi.fn();
    const connection = openBindingEvents({
      onEvent, onState: vi.fn(), shouldReconnect: () => true,
      retry: { delayMs: 3000, maxAttempts: 5 }, heartbeatMs: 30000,
    });
    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.();
    socket.onmessage?.({ data: "pong" });
    socket.onmessage?.({ data: "{" });
    socket.onmessage?.({ data: JSON.stringify({ type: "bind_code", code: "123456" }) });
    expect(onEvent).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30000);
    expect(socket.send).toHaveBeenCalledWith("ping");
    connection.close();
    connection.close();
    socket.onmessage?.({ data: JSON.stringify({ type: "bind_code", code: "late" }) });
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("retries one current connection and stops at the configured limit", () => {
    const onState = vi.fn();
    openBindingEvents({
      onEvent: vi.fn(), onState, shouldReconnect: () => true,
      retry: { delayMs: 3000, maxAttempts: 1 }, heartbeatMs: null,
    });
    FakeWebSocket.instances[0].onclose?.();
    vi.advanceTimersByTime(3000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].onclose?.();
    expect(onState).toHaveBeenLastCalledWith("failed");
  });
});
