import { useCallback, useEffect, useRef, useState } from "react";
import type { TurnstileAction } from "../../../shared/turnstile";
import { loadTurnstile } from "./turnstile";

type Status = "loading" | "verifying" | "interactive" | "ready" | "error";

export function useTurnstile(action: TurnstileAction | null) {
  const [container, ref] = useState<HTMLDivElement | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<Status>("loading");
  const [waiting, setWaiting] = useState(false);
  const token = useRef<{ value: string; at: number } | null>(null);
  const pending = useRef<{ resolve: (value: string | null) => void; timer: number } | null>(null);

  const settle = useCallback((value: string | null) => {
    if (!pending.current) return;
    window.clearTimeout(pending.current.timer);
    pending.current.resolve(value);
    pending.current = null;
    setWaiting(false);
  }, []);

  const retry = useCallback(() => {
    token.current = null;
    setStatus("loading");
    setAttempt(value => value + 1);
  }, []);

  const cancelPending = useCallback(() => settle(null), [settle]);

  useEffect(() => {
    if (!container || !action) return;
    let disposed = false;
    let remove: (() => void) | undefined;
    const fail = () => {
      if (disposed) return;
      token.current = null;
      setStatus("error");
      settle(null);
    };
    void loadTurnstile().then(api => {
      if (disposed) return;
      setStatus("verifying");
      const id = api.render(container, {
        sitekey: import.meta.env.VITE_TURNSTILE_SITE_KEY || "0x4AAAAAAEzqhmaJIXcAno2H",
        action,
        language: "zh-cn",
        size: container.clientWidth > 0 && container.clientWidth < 300 ? "compact" : "flexible",
        theme: "auto",
        appearance: "interaction-only",
        retry: "never",
        "response-field": false,
        callback: value => {
          if (disposed) return;
          setStatus("ready");
          if (pending.current) { token.current = null; settle(value); }
          else token.current = { value, at: Date.now() };
        },
        "error-callback": () => { fail(); return true; },
        "timeout-callback": fail,
        "expired-callback": () => { if (!disposed) retry(); },
        "before-interactive-callback": () => { if (!disposed) setStatus("interactive"); },
        "after-interactive-callback": () => { if (!disposed) setStatus("verifying"); },
      });
      remove = () => api.remove(id);
    }).catch(fail);
    return () => {
      disposed = true;
      token.current = null;
      remove?.();
    };
  }, [action, attempt, container, retry, settle]);

  // Leaving a form cancels its pending submission, even if the provider finishes later.
  useEffect(() => () => settle(null), [action, settle]);

  const getToken = () => {
    if (!action || pending.current) return Promise.resolve(null);
    const cached = token.current;
    token.current = null;
    if (cached && Date.now() - cached.at < 290_000) return Promise.resolve(cached.value);
    setWaiting(true);
    const result = new Promise<string | null>(resolve => {
      pending.current = {
        resolve,
        timer: window.setTimeout(() => { setStatus("error"); settle(null); }, 60_000),
      };
    });
    if (cached || status === "error" || status === "ready") retry();
    return result;
  };

  return { ref, status, waiting, getToken, reset: retry, cancelPending };
}

export type TurnstileVerificationState = ReturnType<typeof useTurnstile>;
