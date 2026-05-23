export interface Env {
  DATABASE: D1Database;
  KV: KVNamespace;
  EMAIL: SendEmail;
  CQU_SESSION: DurableObjectNamespace;
  ENCRYPTION_KEY: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
}

export interface HonoEnv {
  Bindings: Env;
  Variables: {
    user: { id: string; [key: string]: unknown };
  };
}
