import { isBanned } from "./services/oauth-tokens";
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
import { scopeSatisfies } from "./services/oauth-scopes";
import { hashOAuthClientSecret } from "./utils/oauth-secret";
import { oauthClientCquScopes } from "./db/schema";
import { getCquBinding, type CquBindStatus } from "./services/cqu-binding";
import { requiredScopeForTarget } from "./services/required-scope";
import type { HarvestCapture, HarvestFetch } from "./services/cqu-node-protocol";
import {
  parseExternalSearchArgs,
  parseExternalSearchResult,
  type CquExternalSearchArgs,
  type CquExternalSearchResult,
} from "./services/cqu-external-search";
import {
  parseExternalCaptureArgs,
  parseExternalCaptureResult,
  type CquExternalCaptureArgs,
  type CquExternalCaptureResult,
} from "./services/cqu-external-capture";
import { resolveBrowserDeadline } from "./services/cqu-browser-budget";
import { CquSsoError } from "./services/cqu-sso";
import {
  feedAuthError,
  feedRecipientDataError,
  parseFeedRequest,
  resolveFeedContext,
  type FeedAuthError,
  type FeedAuthRequest,
  type FeedAuthResult,
  type FeedPolicy,
  type FeedRecipient,
} from "./services/feed-policy";
import type { Env } from "./types";

// 纯 scope 映射在 services/required-scope.ts(单独成模块以便 Node-pool 单测);此处再导出。
export { requiredScopeForTarget };

// 最小返回形状:验证 client_secret 所需的哈希值 + disabled 闸。adapter.findOne
// 返回完整行,这里只取 clientSecret(hashed 模式 SHA-256/base64url)与 disabled。
interface OAuthClientSecretRow {
  clientId: string;
  clientSecret?: string | null;
  disabled?: boolean | null;
  metadata?: { subsystem?: unknown; rpcMethods?: unknown } | null;
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

  /** Service identity is only valid inside private Worker RPC. No user sessions
   * or per-user OAuth tokens are minted by these methods. */
  private async authorizeService(
    args: { clientId: string; clientSecret: string; userId: string },
    method:
      | "getCaps"
      | "getCquTicket"
      | "cquHarvest"
      | "cquExternalSearch"
      | "cquExternalCapture"
  ): Promise<{ subsystem: string } | { error: string }> {
    const finish = (result: { subsystem: string } | { error: string }) => {
      console.info(JSON.stringify({ event: "auth.rpc.request", clientId: args.clientId,
        userId: args.userId, method, identityStatus: "error" in result ? result.error : "verified" }));
      return result;
    };
    const { adapter } = await createAuth(this.env, new Request(this.env.BETTER_AUTH_URL)).$context;
    const client = await adapter.findOne<OAuthClientSecretRow>({ model: "oauthClient", where: [{ field: "clientId", value: args.clientId }] });
    if (!client?.clientSecret || client.disabled ||
        !constantTimeEquals(await hashOAuthClientSecret(args.clientSecret), client.clientSecret)) {
      return finish({ error: "INVALID_CLIENT" });
    }
    const methods = client.metadata?.rpcMethods;
    const subsystem = client.metadata?.subsystem;
    if (!Array.isArray(methods) || !methods.every(value => typeof value === "string") ||
        !methods.includes(method) || typeof subsystem !== "string") return finish({ error: "FORBIDDEN" });
    const user = args.userId && await adapter.findOne<{ banned?: boolean | null; banExpires?: Date | null }>({
      model: "user", where: [{ field: "id", value: args.userId }],
    });
    if (!user || isBanned(user)) return finish({ error: "FORBIDDEN" });
    return finish({ subsystem });
  }

  private async hasSchoolBinding(userId: string): Promise<boolean> {
    // #37's DO reconciliation remains the final gate. This early check also
    // accepts older credentials-only accounts, but never a deleting address.
    const row = await this.env.DATABASE.prepare(`SELECT 1 AS allowed FROM cqu_credentials c
      WHERE c.user_id = ? AND c.status = 'active' AND NOT EXISTS (
        SELECT 1 FROM cqu_bind_addresses a WHERE a.user_id = c.user_id AND a.status != 'active'
      )`).bind(userId).first();
    return !!row;
  }

  private async authorizeFeedService(
    args: unknown,
    method: "getFeedPolicy" | "getFeedRecipient"
  ): Promise<{ request: FeedAuthRequest } | { error: FeedAuthResult<never> }> {
    const parsed = parseFeedRequest(args);
    if ("code" in parsed) {
      return { error: feedAuthError(parsed.code, crypto.randomUUID(), parsed.retryable) };
    }
    const requestId = crypto.randomUUID();
    try {
      const { adapter } = await createAuth(
        this.env,
        new Request(this.env.BETTER_AUTH_URL)
      ).$context;
      const client = await adapter.findOne<OAuthClientSecretRow>({
        model: "oauthClient",
        where: [{ field: "clientId", value: parsed.clientId }],
      });
      if (
        !client?.clientSecret ||
        client.disabled ||
        !constantTimeEquals(
          await hashOAuthClientSecret(parsed.clientSecret),
          client.clientSecret
        )
      ) {
        console.info(JSON.stringify({
          event: "auth.rpc.request",
          clientId: parsed.clientId,
          userId: parsed.userId,
          method,
          identityStatus: "INVALID_CLIENT",
        }));
        return { error: feedAuthError("INVALID_CLIENT", requestId) };
      }
      const methods = client.metadata?.rpcMethods;
      const subsystem = client.metadata?.subsystem;
      const allowed =
        Array.isArray(methods) &&
        methods.every((value) => typeof value === "string") &&
        methods.includes(method) &&
        subsystem === "feed";
      if (!allowed) {
        console.info(JSON.stringify({
          event: "auth.rpc.request",
          clientId: parsed.clientId,
          userId: parsed.userId,
          method,
          identityStatus: "CLIENT_NOT_ALLOWED",
        }));
        return { error: feedAuthError("CLIENT_NOT_ALLOWED", requestId) };
      }
      console.info(JSON.stringify({
        event: "auth.rpc.request",
        clientId: parsed.clientId,
        userId: parsed.userId,
        method,
        identityStatus: "verified",
      }));
      return { request: parsed };
    } catch {
      return { error: feedAuthError("AUTH_UNAVAILABLE", requestId, true) };
    }
  }

  /** Current calendar rights, including false flags; no school binding needed. */
  async getCaps(args: {
    clientId: string;
    clientSecret: string;
    userId: string;
  }): Promise<{ calendar: CalendarCaps } | null> {
    const authorization = await this.authorizeService(args, "getCaps");
    if ("error" in authorization || authorization.subsystem !== "calendar") return null;
    return resolveCapsForRpc(this.env.DATABASE, args.userId);
  }

  async getFeedPolicy(args: unknown): Promise<FeedAuthResult<FeedPolicy>> {
    const authorization = await this.authorizeFeedService(args, "getFeedPolicy");
    if ("error" in authorization) return authorization.error;
    const context = await resolveFeedContext(
      this.env.DATABASE,
      authorization.request.userId
    );
    if ("code" in context) {
      return feedAuthError(context.code, crypto.randomUUID(), context.retryable);
    }
    return {
      ok: true,
      contractVersion: 1,
      checkedAt: context.checkedAt,
      data: context.policy,
    };
  }

  async getFeedRecipient(args: unknown): Promise<
    FeedAuthResult<{ policy: FeedPolicy; recipient: FeedRecipient }>
  > {
    const authorization = await this.authorizeFeedService(args, "getFeedRecipient");
    if ("error" in authorization) return authorization.error;
    const context = await resolveFeedContext(
      this.env.DATABASE,
      authorization.request.userId
    );
    if ("code" in context) {
      return feedAuthError(context.code, crypto.randomUUID(), context.retryable);
    }
    const recipientError = feedRecipientDataError(context.user);
    if (recipientError) {
      return feedAuthError(
        recipientError.code,
        crypto.randomUUID(),
        recipientError.retryable
      );
    }
    const recipient: FeedRecipient = !context.policy.access
      ? { status: "blocked" }
      : context.user.emailVerified === true || context.user.emailVerified === 1
        ? { status: "verified", email: context.user.email }
        : { status: "unverified" };
    return {
      ok: true,
      contractVersion: 1,
      checkedAt: context.checkedAt,
      data: { policy: context.policy, recipient },
    };
  }

  /** Client target scopes, current business rights and school binding all apply.
   * The DO retains host validation, QuickLogin consent, rate limits and audit. */
  async getCquTicket(args: {
    clientId: string;
    clientSecret: string;
    service?: string;
    serviceUrl?: string;
    userId: string;
  }): Promise<{ ticket: string } | { error: string }> {
    const authorization = await this.authorizeService(args, "getCquTicket");
    if ("error" in authorization) return authorization;
    const caps = await resolveCaps(this.env.DATABASE, args.userId);
    const permitted = authorization.subsystem === "calendar"
      ? args.service === "jwxt" && !args.serviceUrl && caps.calendar.sync === true
      : authorization.subsystem === "eval"
        ? args.service === "jxpj" && !args.serviceUrl && caps.eval.submit === true
        : authorization.subsystem === "cqu" && caps.cqu.quicklogin_access === true;
    if (!permitted) return { error: "FORBIDDEN" };
    if (!(await this.hasSchoolBinding(args.userId))) return { error: "NO_CQU_BINDING" };

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

  /** Calendar harvesting is centrally authorized, then dispatched through the
   * existing DO target-host, binding, rate-limit and audit controls. */
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
    const authorization = await this.authorizeService(args, "cquHarvest");
    if ("error" in authorization) return authorization;
    const caps = await resolveCapsForRpc(this.env.DATABASE, args.userId);
    if (authorization.subsystem !== "calendar" || caps?.calendar.sync !== true) return { error: "FORBIDDEN" };
    if (!(await this.hasSchoolBinding(args.userId))) return { error: "NO_CQU_BINDING" };
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

  /** Search only through fixed AllCourseSchedule recipes; transport details are never caller-controlled. */
  async cquExternalSearch(
    args: CquExternalSearchArgs
  ): Promise<CquExternalSearchResult | { error: string }> {
    const recipe = parseExternalSearchArgs(args);
    if ("error" in recipe) return recipe;

    const authorization = await this.authorizeService(args, "cquExternalSearch");
    if ("error" in authorization) return authorization;
    const caps = await resolveCapsForRpc(this.env.DATABASE, args.userId);
    if (authorization.subsystem !== "calendar" || caps?.calendar.external !== true) {
      return { error: "FORBIDDEN" };
    }
    if (!(await this.hasSchoolBinding(args.userId))) return { error: "NO_CQU_BINDING" };

    const doId = this.env.CQU_SESSION.idFromName(args.userId);
    const stub = this.env.CQU_SESSION.get(doId);
    const doUrl = new URL("https://do/external-search");
    doUrl.searchParams.set("clientId", args.clientId);
    doUrl.searchParams.set("source", "rpc");
    if (typeof args.deadlineAt === "number") doUrl.searchParams.set("deadlineAt", String(args.deadlineAt));
    const resp = await stub.fetch(new Request(doUrl.toString(), {
      method: "POST",
      body: JSON.stringify(recipe),
    }));
    const body = await resp.json<unknown>().catch(() => null);
    if (!resp.ok || typeof body !== "object" || body === null || (body as { ok?: unknown }).ok !== true) {
      const code = typeof body === "object" && body !== null
        ? (body as { code?: unknown }).code ?? (body as { error?: unknown }).error
        : undefined;
      return { error: typeof code === "string" ? code : "SEARCH_FAILED" };
    }
    const result = parseExternalSearchResult(body, args.sourceType);
    if (!("error" in result) && result.sourceType === "course" &&
      (result.course.id !== args.courseId || result.course.name !== args.courseName || result.session.id !== args.expectedSessionId)) {
      return { error: "SCHEMA_INVALID" };
    }
    return result;
  }

  /** Capture only a fixed current-term admin-class business target. */
  async cquExternalCapture(
    args: CquExternalCaptureArgs
  ): Promise<CquExternalCaptureResult | { error: string }> {
    const recipe = parseExternalCaptureArgs(args);
    if ("error" in recipe) return recipe;
    let deadlineAt: number;
    try {
      deadlineAt = resolveBrowserDeadline(args.deadlineAt, Date.now());
    } catch (error) {
      return {
        error: error instanceof CquSsoError ? error.code : "INVALID_BROWSER_DEADLINE",
      };
    }

    const authorization = await this.authorizeService(args, "cquExternalCapture");
    if ("error" in authorization) return authorization;
    const caps = await resolveCapsForRpc(this.env.DATABASE, args.userId);
    if (authorization.subsystem !== "calendar" || caps?.calendar.external !== true) {
      return { error: "FORBIDDEN" };
    }
    if (!(await this.hasSchoolBinding(args.userId))) return { error: "NO_CQU_BINDING" };

    const doId = this.env.CQU_SESSION.idFromName(args.userId);
    const stub = this.env.CQU_SESSION.get(doId);
    const doUrl = new URL("https://do/external-capture");
    doUrl.searchParams.set("clientId", args.clientId);
    doUrl.searchParams.set("source", "rpc");
    const resp = await stub.fetch(new Request(doUrl.toString(), {
      method: "POST",
      body: JSON.stringify({ ...recipe, deadlineAt }),
    }));
    const body = await resp.json<unknown>().catch(() => null);
    if (!resp.ok || typeof body !== "object" || body === null || (body as { ok?: unknown }).ok !== true) {
      const code = typeof body === "object" && body !== null
        ? (body as { code?: unknown }).code ?? (body as { error?: unknown }).error
        : undefined;
      return { error: typeof code === "string" ? code : "CAPTURE_TRANSIENT" };
    }
    return parseExternalCaptureResult(body, recipe);
  }
}
