export interface TurnstileOptions {
  sitekey: string;
  action: string;
  language: string;
  size: "flexible" | "compact";
  theme: "auto";
  appearance: "interaction-only";
  retry: "never";
  "response-field": false;
  callback: (token: string) => void;
  "error-callback": () => boolean;
  "expired-callback": () => void;
  "timeout-callback": () => void;
  "before-interactive-callback": () => void;
  "after-interactive-callback": () => void;
}

interface Turnstile {
  render: (container: HTMLElement, options: TurnstileOptions) => string;
  remove: (id: string) => void;
}

declare global {
  interface Window { turnstile?: Turnstile }
}

let loading: Promise<Turnstile> | undefined;

export function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    const fail = () => {
      window.clearTimeout(timer);
      script.remove();
      reject(new Error("安全验证加载失败"));
    };
    const timer = window.setTimeout(fail, 15_000);
    script.onerror = fail;
    script.onload = () => {
      const api = window.turnstile;
      if (!api) return fail();
      // ready() rejects async/defer scripts; the load event already guarantees execution.
      window.clearTimeout(timer);
      resolve(api);
    };
    document.head.append(script);
  }).catch(error => { loading = undefined; throw error; });
  return loading;
}
