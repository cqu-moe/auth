import { WorkerEntrypoint } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { createAuth } from "./auth";
import { resolveCaps, type Caps } from "./services/entitlements";
import { scopeSatisfies } from "./middleware/scope";
import { hashOAuthClientSecret } from "./utils/oauth-secret";
import { oauthClientCquScopes } from "./db/schema";
import { requiredScopeForTarget } from "./services/required-scope";
import type { Env } from "./types";

// 纯 scope 映射在 services/required-scope.ts(单独成模块以便 Node-pool 单测);此处再导出。
export { requiredScopeForTarget };

// 最小返回形状:验证 client_secret 所需的哈希值 + disabled 闸。adapter.findOne
// 返回完整行,这里只取 clientSecret(hashed 模式 SHA-256/base64url)与 disabled。
interface OAuthClientSecretRow {
  clientId: string;
  clientSecret?: string | null;
  disabled?: boolean | null;
}

// 定长比较:逐字符 XOR 累加,避免 secret 哈希比较的早退时序泄漏。长度不等直接 false。
// 两侧都是 base64url(SHA-256) 的定长串,timing-safe 是廉价的纵深防御。
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * AuthService — Service Binding RPC 入口(第一方子系统经 Service Binding 调用)。
 *
 * 调用方在其 wrangler 里声明:
 *   services: [{ binding: "AUTH", service: "cqu-moe-auth", entrypoint: "AuthService" }]
 * auth 侧无需自绑定;命名 entrypoint 随 Worker 自动暴露。
 *
 * 安全红线:getCquTicket 是取 CQU 票的【第二入口】,必须与公共 route 同等锁死。
 * 它【绝不】直连 SSO 铸票,而是一律经 CquSessionDO 这个唯一 chokepoint,继承其
 * host 再校验 / quicklogin opt-in / 限频 / 审计四道闸(见 cqu-session.ts 注释)。
 */
export class AuthService extends WorkerEntrypoint<Env> {
  /**
   * 用 cookie 头校验会话,返回 { user, caps } 或 null(未登录/无 cookie)。
   * 返回值是 structured-cloneable 的纯对象(better-auth 的 user 与 caps 都是普通对象)。
   */
  async verifySession(
    cookieHeader: string | null
  ): Promise<{ user: Record<string, unknown>; caps: Caps } | null> {
    if (!cookieHeader) return null;
    const auth = createAuth(
      this.env,
      new Request("https://auth.cqu.moe", {
        headers: { cookie: cookieHeader },
      })
    );
    const s = await auth.api.getSession({
      headers: new Headers({ cookie: cookieHeader }),
    });
    if (!s?.user) return null;
    const caps = await resolveCaps(this.env.DATABASE, s.user.id);
    // s.user / caps 均为普通对象,可直接 structured clone 跨 RPC 边界返回。
    return { user: s.user as Record<string, unknown>, caps };
  }

  /**
   * 取 CQU CAS Service Ticket(取票第二入口,SECURITY-CRITICAL)。锁死顺序:
   *   ① 认证 clientId(M-6 红线):按 clientId 查 OAuth client,用 hashOAuthClientSecret
   *      验证呈递的 client_secret 与存储哈希一致(定长比较)。RPC 调用方自报 clientId,
   *      不验 secret 则任意绑定 Worker 都能冒充任意 client —— 故所有调用都强制验证。
   *   ② 定所需 scope + 模式:serviceUrl → "cqu:ticket:any";service → "cqu:ticket:"+key;
   *      皆缺 → MISSING_TARGET。
   *   ③ client-scope 授权:读 oauth_client_cqu_scopes,scopeSatisfies 不过 → FORBIDDEN
   *      (镜像 route 的 per-client 检查;route 的 JWT 检查在此无对应物,由 ① 的 secret 认证替代)。
   *   ④ 经 DO chokepoint 出票:绝不直连 ssoClient。寻址 idFromName(userId),构造
   *      service-ticket 请求(clientId + source="rpc"),由 DO 做 host 再校验 / opt-in /
   *      限频 / 审计。DO 非 ok → 回传其 error code;否则回传 { ticket }。
   *
   * ⚠️ 绝不在此调用 ssoClient.getServiceTicket 或任何 SSO 直铸路径。所有安全闸都活在
   * DO.getServiceTicket 里,绕过它(直连 SSO 铸票)会跳过 opt-in/限频/审计/host 校验。
   * 一律经 DO,不留例外。
   */
  async getCquTicket(args: {
    clientId: string;
    clientSecret: string;
    service?: string;
    serviceUrl?: string;
    userId: string;
  }): Promise<{ ticket: string } | { error: string }> {
    // ① 认证 clientId + client_secret(M-6)。dummy Request 仅用于构造 auth 上下文。
    const auth = createAuth(
      this.env,
      new Request("https://auth.cqu.moe")
    );
    const ctx = await auth.$context;
    const client = await ctx.adapter.findOne<OAuthClientSecretRow>({
      model: "oauthClient",
      where: [{ field: "clientId", value: args.clientId }],
    });
    if (!client || !client.clientSecret) return { error: "INVALID_CLIENT" };
    // 被禁用的 client 绝不许铸票(镜像 OAuth 端点对 disabled 的封禁)。回同一 opaque
    // INVALID_CLIENT(不回特异错误),避免向调用方泄露「该 client 存在但被禁」的状态。
    // 置于 secret 比对前,确保 disabled client 永不触达 scope/DO。
    if (client.disabled) return { error: "INVALID_CLIENT" };
    const presentedHash = await hashOAuthClientSecret(args.clientSecret);
    if (!constantTimeEquals(presentedHash, client.clientSecret)) {
      return { error: "INVALID_CLIENT" };
    }

    // ② 定所需 scope + 模式(serviceUrl 优先)。
    const scope = requiredScopeForTarget({
      service: args.service,
      serviceUrl: args.serviceUrl,
    });
    if ("error" in scope) return { error: scope.error };
    const required = scope.required;

    // ③ client-scope 授权:读该 client 已配置的 cqu scopes,镜像 route 的 per-client 检查。
    const rows = await drizzle(this.env.DATABASE)
      .select()
      .from(oauthClientCquScopes)
      .where(eq(oauthClientCquScopes.clientId, args.clientId))
      .all();
    const clientScopes = rows.map((r) => r.scope);
    if (!scopeSatisfies(clientScopes, required)) {
      return { error: "FORBIDDEN" };
    }

    // ④ 经 DO chokepoint 出票(绝不直连 ssoClient)。DO 做 host 再校验/opt-in/限频/审计。
    const doId = this.env.CQU_SESSION.idFromName(args.userId);
    const stub = this.env.CQU_SESSION.get(doId);
    const doUrl = new URL("https://do/service-ticket");
    if (args.serviceUrl) {
      doUrl.searchParams.set("serviceUrl", args.serviceUrl);
    } else if (args.service) {
      doUrl.searchParams.set("service", args.service);
    }
    doUrl.searchParams.set("clientId", args.clientId);
    doUrl.searchParams.set("source", "rpc");

    const resp = await stub.fetch(new Request(doUrl.toString()));
    if (!resp.ok) {
      const err = await resp
        .json<{ error?: string; code?: string }>()
        .catch(() => ({}) as { error?: string; code?: string });
      return { error: err.code ?? "ST_FAILED" };
    }
    const body = await resp.json<{ ticket: string }>();
    return { ticket: body.ticket };
  }
}
