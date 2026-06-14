export interface Env {
  DATABASE: D1Database;
  KV: KVNamespace;
  RESEND_API_KEY: string;
  CQU_SESSION: DurableObjectNamespace;
  CQU_LOGIN: DurableObjectNamespace;
  ASSETS: Fetcher;
  ENCRYPTION_KEY: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  BIND_EMAIL_DOMAIN: string;
}

export interface HonoEnv {
  Bindings: Env;
  Variables: {
    user: { id: string; [key: string]: unknown };
    // 已校验的 DO service-ticket URL(canonical),阶段一→阶段二传递,见 routes/cqu.ts。
    stDoUrl: string;
  };
}
