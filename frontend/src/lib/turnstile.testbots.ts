import { vi } from "vitest";
import type { TurnstileOptions } from "./turnstile";

export function installPassingTurnstile() {
  let nextId = 0;
  const removed = new Set<string>();
  vi.stubGlobal("turnstile", {
    ready: (ready: () => void) => ready(),
    render: (_container: HTMLElement, options: TurnstileOptions) => {
      const id = String(++nextId);
      queueMicrotask(() => { if (!removed.has(id)) options.callback(`fixture-token-${id}`); });
      return id;
    },
    remove: (id: string) => { removed.add(id); },
  });
}
