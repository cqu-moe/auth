import { parseCquBindingEvent, type CquBindingEvent } from "../../../../shared/cqu-events";

export type BindingConnectionState = "connecting" | "open" | "closed" | "error" | "failed";
export type BindingConnectionOptions = {
  onEvent: (event: CquBindingEvent) => void;
  onState: (state: BindingConnectionState) => void;
  shouldReconnect: () => boolean;
  retry: { delayMs: number; maxAttempts: number | null };
  heartbeatMs: number | null;
};

function bindingEventsUrl() {
  const url = new URL("/api/v1/cqu/binding/events", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function openBindingEvents(options: BindingConnectionOptions): { close(): void } {
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let attempts = 0;
  let closed = false;
  let generation = 0;

  const clearTimers = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    reconnectTimer = null;
    heartbeatTimer = null;
  };

  const connect = () => {
    if (closed || !options.shouldReconnect()) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    const currentGeneration = ++generation;
    options.onState("connecting");
    const current = new WebSocket(bindingEventsUrl());
    socket = current;
    current.onopen = () => {
      if (closed || currentGeneration !== generation) return current.close();
      attempts = 0;
      options.onState("open");
      if (options.heartbeatMs !== null) {
        heartbeatTimer = setInterval(() => {
          if (!closed && current.readyState === WebSocket.OPEN) current.send("ping");
        }, options.heartbeatMs);
      }
    };
    current.onmessage = (message) => {
      if (closed || currentGeneration !== generation) return;
      const event = parseCquBindingEvent(message.data);
      if (event) options.onEvent(event);
    };
    current.onerror = () => {
      if (closed || currentGeneration !== generation) return;
      options.onState("error");
      current.close();
    };
    current.onclose = () => {
      if (currentGeneration !== generation) return;
      clearTimers();
      socket = null;
      if (closed || !options.shouldReconnect()) return options.onState("closed");
      if (options.retry.maxAttempts !== null && attempts >= options.retry.maxAttempts) {
        return options.onState("failed");
      }
      attempts += 1;
      options.onState("closed");
      reconnectTimer = setTimeout(connect, options.retry.delayMs);
    };
  };

  connect();
  return {
    close() {
      if (closed) return;
      closed = true;
      generation += 1;
      clearTimers();
      const current = socket;
      socket = null;
      current?.close();
    },
  };
}
