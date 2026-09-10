import { WorkerEntrypoint } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { createAuth } from "./auth";
import {
  resolveCaps,
  resolveCapsForRpc,
  type Caps,
  type CalendarCaps,
} from "./services/entitlements";
import { scopeSatisfies } from "./middleware/scope";
import { hashOAuthClientSecret } from "./utils/oauth-secret";
import { oauthClientCquScopes } from "./db/schema";
import { getCquBinding, type CquBindStatus } from "./services/cqu-binding";
import { requiredScopeForTarget } from "./services/required-scope";
import type { HarvestCapture, HarvestFetch } from "./services/cqu-node-protocol";
import { resolveBrowserDeadline } from "./services/cqu-browser-budget";
import { CquSsoError } from "./services/cqu-sso";
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

export type { CquBindStatus } from "./services/cqu-binding";

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
  ): Promise<{
    user: Record<string, unknown>;
    caps: Caps;
    cquBindStatus: CquBindStatus;
  } | null> {
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
    const { bindStatus: cquBindStatus } = await getCquBinding(this.env.DATABASE, s.user.id);
    // s.user / caps / cquBindStatus 均为普通值,可直接 structured clone 跨 RPC 边界返回。
    return { user: s.user as Record<string, unknown>, caps, cquBindStatus };
  }

  /**
   * M-6 客户端认证闸(getCquTicket / getCaps 共用,单点可审计)。RPC 进程内调用方
   * 自报 clientId 不可信,必须验 client_secret。返回 true 仅当全部满足,否则 false:
   *  - client 存在且有 clientSecret;
   *  - client 未被禁用(disabled);此检查【先于】secret 比对 —— disabled client 永不
   *    触达后续闸,且对外回 opaque(由调用方统一映射成 INVALID_CLIENT / null),
   *    不泄露「存在但被禁」状态;
   *  - 呈递 secret 的哈希(hashOAuthClientSecret)与存储哈希定长比较(constantTimeEquals)相等。
   */
  private async authenticateClient(
    clientId: string,
    clientSecret: string
  ): Promise<boolean> {
    // dummy Request 仅用于构造 auth 上下文。
    const auth = createAuth(this.env, new Request("https://auth.cqu.moe"));
    const ctx = await auth.$context;
    const client = await ctx.adapter.findOne<OAuthClientSecretRow>({
      model: "oauthClient",
      where: [{ field: "clientId", value: clientId }],
    });
    if (!client || !client.clientSecret) return false;
    if (client.disabled) return false;
    const presentedHash = await hashOAuthClientSecret(clientSecret);
    return constantTimeEquals(presentedHash, client.clientSecret);
  }

  /**
   * 取用户当前、权威的 calendar caps(离线读取,SECURITY-SENSITIVE)。供 schedule 的
   * 离线同步 cron 做权益门禁 / 硬撤销(见 issue #7)。锁死顺序:
   *   ① 认证调用方 client(M-6,见 authenticateClient):验 clientId+client_secret。
   *      getCaps 是【按任意 userId 枚举】的原语 —— 无 per-user 凭证(不同于 verifySession
   *      以用户 cookie 为凭证,只能查持有者),不验则任一被绑定 Worker 都能扫全体用户的
   *      权益画像。认证失败 → null(opaque)。
   *   ② 直查 user_entitlement(无 cookie/session)→ 只盖 calendar 片(最小披露,
   *      schedule 仅消费 calendar)。零行 → null(用户不存在/无权益,schedule fail-closed)。
   */
  async getCaps(args: {
    clientId: string;
    clientSecret: string;
    userId: string;
  }): Promise<{ calendar: CalendarCaps } | null> {
    if (!args.userId) return null;
    if (!(await this.authenticateClient(args.clientId, args.clientSecret))) {
      return null;
    }
    return resolveCapsForRpc(this.env.DATABASE, args.userId);
  }

  /**
   * 取 CQU CAS Service Ticket(取票第二入口,SECURITY-CRITICAL)。锁死顺序:
   *   ① 认证 clientId(M-6 红线,见 authenticateClient):验呈递的 client_secret 与存储哈希
   *      一致(定长比较)。RPC 调用方自报 clientId,不验 secret 则任意绑定 Worker 都能冒充
   *      任意 client —— 故所有调用都强制验证。
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
    // ① 认证 clientId + client_secret(M-6)。disabled client 在闸内即被拒,且回同一
    // opaque INVALID_CLIENT(不泄露「存在但被禁」),确保其永不触达 scope/DO。
    if (!(await this.authenticateClient(args.clientId, args.clientSecret))) {
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

  /**
   * organic harvest 取数(取数第二入口,SECURITY-CRITICAL)。auth 提供的**业务无关批量取数原语**:
   * 在用户已登录 + 已过瑞数的临时浏览器里导航 navUrl(页面有机 fire 课表/学期)+ 截获 capture
   * 模式响应 + 跑 fetch[] in-page GET,一把返回。schedule 等子系统填自己的 navUrl/配方。
   *
   * 锁死顺序(对齐 getCquTicket):
   *   ① authenticateClient(M-6 client_secret constant-time):RPC 调用方自报 clientId 不可信,
   *      失败 → { error: "INVALID_CLIENT" }(opaque)。
   *   ② 经 DO data-harvest chokepoint 出数(绝不在此直起浏览器):寻址 idFromName(userId),
   *      DO 做精确 host 白名单(my.cqu.edu.cn 或其 aTrust 改写 host，且单配方不得混用)
   *      / 限流 / 审计 / 各自独立的 needs_reauth 熔断。
   *   ③ DO 非 ok → 回传其 code(NEEDS_REAUTH | SESSION_INACTIVE | RATE_LIMITED |
   *      INVALID_HARVEST_URL | WAF_CHALLENGE | TGT_EXPIRED);成功 → { captures, fetches }。
   *
   * ⚠️ host 红线只允许两个代码内固定的精确主机，且同一配方必须 same-host，
   *    防 auth 变开放代理(SSRF)。不做 client-scope 检查(通用原语, 取数授权 = M-6 机器信任 +
   *    用户 CQU 会话 active + host 白名单;业务级权益门禁在调用方 schedule 侧)。
   */
  async cquHarvest(args: {
    clientId: string;
    clientSecret: string;
    userId: string;
    navUrl: string;
    capture?: string[];
    fetch?: { method?: string; url: string }[];
    /** 可选绝对截止时间(ms epoch):auth 钳制到当前时间+13min,整次 harvest 共用。 */
    deadlineAt?: number;
  }): Promise<
    | { captures: HarvestCapture[]; fetches: HarvestFetch[] }
    | { error: string }
  > {
    if (!args.userId) return { error: "INVALID_CLIENT" };
    if (!(await this.authenticateClient(args.clientId, args.clientSecret))) {
      return { error: "INVALID_CLIENT" };
    }
    let deadlineAt: number;
    try {
      deadlineAt = resolveBrowserDeadline(args.deadlineAt, Date.now());
    } catch (e) {
      return {
        error: e instanceof CquSsoError ? e.code : "INVALID_BROWSER_DEADLINE",
      };
    }

    const doId = this.env.CQU_SESSION.idFromName(args.userId);
    const stub = this.env.CQU_SESSION.get(doId);
    const doUrl = new URL("https://do/data-harvest");
    doUrl.searchParams.set("clientId", args.clientId);
    doUrl.searchParams.set("source", "rpc");

    const resp = await stub.fetch(
      new Request(doUrl.toString(), {
        method: "POST",
        body: JSON.stringify({
          navUrl: args.navUrl,
          capture: args.capture ?? [],
          fetch: args.fetch ?? [],
          deadlineAt,
        }),
      })
    );
    if (!resp.ok) {
      const err = await resp
        .json<{ error?: string; code?: string }>()
        .catch(() => ({}) as { error?: string; code?: string });
      return { error: err.code ?? "HARVEST_FAILED" };
    }
    return resp.json<{ captures: HarvestCapture[]; fetches: HarvestFetch[] }>();
  }
}
