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
  };
}
