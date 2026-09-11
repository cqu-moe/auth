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

export type Principal =
  | { kind: "session"; user: { id: string; role?: string; [key: string]: unknown } }
  | { kind: "bearer"; userId: string; clientId: string; scopes: string[] };

export interface RequestAuthCache {
  session?: Promise<Principal | null>;
  bearer?: Promise<Principal | null>;
}

export interface HonoEnv {
  Bindings: Env;
  Variables: {
    user: { id: string; [key: string]: unknown };
    principal: Principal;
    requestAuthCache: RequestAuthCache;
    // 已校验的 DO service-ticket URL(canonical),阶段一→阶段二传递,见 routes/cqu.ts。
    stDoUrl: string;
    // 取票客户端的 OAuth clientId(Bearer 令牌 azp/client_id);转发给 DO 做 per-client 限频与审计。
    // 同源会话(无 Bearer)或令牌无 azp 时为 undefined → DO 视为 null(自成限频桶)。
    clientId?: string;
  };
}
