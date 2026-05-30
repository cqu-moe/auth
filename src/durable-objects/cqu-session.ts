import { DurableObject } from "cloudflare:workers";
import { CquSsoClient, type CasCookies, CquSsoError } from "../services/cqu-sso";
import { decrypt } from "../services/crypto";
import type { Env } from "../types";

const KEEPALIVE_INTERVAL_MS = 15 * 60 * 1000;
const RETRY_INTERVAL_MS = 60 * 1000;
const MAX_FAST_RETRIES = 5;
const DUMMY_SERVICE = "https://my.cqu.edu.cn/authserver/authentication/cas";

export const SERVICE_URLS: Record<string, string> = {
  jwxt: "https://my.cqu.edu.cn/authserver/authentication/cas",
  jxpj: "https://my.cqu.edu.cn/authserver/authentication/cas",
  library: "https://lib.cqu.edu.cn/cas/validate",
  card: "https://card.cqu.edu.cn/cas/validate",
};

interface SessionState {
  userId: string;
  studentId: string;
  cookies: CasCookies;
  objectId: string;
  tgt: string;
  lastKeepAlive: number;
  lastRequestedAt: number;
  status: "active" | "expired" | "error";
  consecutiveFailures: number;
}

interface StoredCredentials {
  encryptedPassword: string;
  iv: string;
}

export class CquSessionDO extends DurableObject<Env> {
  private state: SessionState | null = null;
  private ssoClient = new CquSsoClient();

  private async loadState(): Promise<void> {
    if (!this.state) {
      this.state = (await this.ctx.storage.get<SessionState>("state")) ?? null;
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.split("/").pop();

    try {
      switch (action) {
        case "init": {
          const body = await request.json<{
            userId: string;
            studentId: string;
            encryptedPassword: string;
            iv: string;
          }>();
          await this.ctx.storage.put<StoredCredentials>("credentials", {
            encryptedPassword: body.encryptedPassword,
            iv: body.iv,
          });
          const result = await this.initSession(
            body.userId,
            body.studentId,
            body.encryptedPassword,
            body.iv
          );
          return Response.json(result);
        }
        case "service-ticket": {
          const service = url.searchParams.get("service");
          if (!service)
            return Response.json({ error: "Missing service" }, { status: 400 });
          const ticket = await this.getServiceTicket(service);
          return Response.json({ ticket });
        }
        case "status": {
          const status = await this.getStatus();
          return Response.json(status);
        }
        case "destroy": {
          await this.ctx.storage.deleteAll();
          this.state = null;
          return Response.json({ success: true });
        }
        default:
          return Response.json({ error: "Unknown action" }, { status: 404 });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Internal error";
      const code = e instanceof CquSsoError ? e.code : "INTERNAL_ERROR";
      return Response.json({ error: message, code }, { status: 500 });
    }
  }

  private async initSession(
    userId: string,
    studentId: string,
    encryptedPassword: string,
    iv: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const password = await decrypt(
        encryptedPassword,
        iv,
        this.env.ENCRYPTION_KEY
      );
      const result = await this.ssoClient.login(
        studentId,
        password,
        DUMMY_SERVICE
      );
      this.state = {
        userId,
        studentId,
        cookies: result.cookies,
        objectId: "",
        tgt: "",
        lastKeepAlive: Date.now(),
        lastRequestedAt: Date.now(),
        status: "active",
        consecutiveFailures: 0,
      };
      await this.ctx.storage.put("state", this.state);
      await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);
      return { success: true };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : "Unknown error",
      };
    }
  }

  private async getServiceTicket(service: string): Promise<string> {
    await this.loadState();
    if (!this.state || this.state.status !== "active") {
      throw new CquSsoError("SESSION_INACTIVE", "CQU session not active");
    }
    const serviceUrl = SERVICE_URLS[service];
    if (!serviceUrl) {
      throw new CquSsoError("UNKNOWN_SERVICE", `Unknown service: ${service}`);
    }
    this.state.lastRequestedAt = Date.now();
    await this.ctx.storage.put("state", this.state);
    return this.ssoClient.getServiceTicket(this.state.cookies, serviceUrl);
  }

  private async getStatus(): Promise<Record<string, unknown>> {
    await this.loadState();
    if (!this.state) return { status: "unbound" };
    return {
      status: this.state.status,
      studentId: this.state.studentId,
      lastKeepAlive: this.state.lastKeepAlive,
      lastRequestedAt: this.state.lastRequestedAt,
    };
  }

  async alarm(): Promise<void> {
    await this.loadState();
    if (!this.state) return;

    const outcome = await this.runKeepAlive();

    if (outcome === "active") {
      this.state.status = "active";
      this.state.lastKeepAlive = Date.now();
      this.state.consecutiveFailures = 0;
      await this.ctx.storage.put("state", this.state);
      await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);
      return;
    }

    if (outcome === "expired") {
      // Server reachable but credentials rejected — genuinely needs re-binding.
      this.state.status = "error";
      this.state.consecutiveFailures = 0;
      console.error(
        `[CquSession] ${this.state.studentId}: credentials rejected, status -> error (needs re-login)`
      );
      await this.ctx.storage.put("state", this.state);
      await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);
      return;
    }

    // outcome === "transient": couldn't reach CQU SSO. The CAS session is
    // almost certainly still valid server-side, so keep the existing cookies
    // and status untouched and retry soon instead of falsely flagging re-login.
    this.state.consecutiveFailures = (this.state.consecutiveFailures ?? 0) + 1;
    const fastRetry = this.state.consecutiveFailures <= MAX_FAST_RETRIES;
    const delay = fastRetry ? RETRY_INTERVAL_MS : KEEPALIVE_INTERVAL_MS;
    console.warn(
      `[CquSession] ${this.state.studentId}: keepalive unreachable (attempt #${this.state.consecutiveFailures}), keeping session, retrying in ${delay}ms`
    );
    await this.ctx.storage.put("state", this.state);
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  /**
   * One keepalive cycle. Returns:
   * - "active":    session is (or was made) valid.
   * - "expired":   server reachable but credentials rejected — real re-login needed.
   * - "transient": couldn't reach CQU; cookies left intact, caller should retry soon.
   */
  private async runKeepAlive(): Promise<"active" | "expired" | "transient"> {
    const state = this.state!;
    // 1. Probe: can the existing cookies still mint a service ticket?
    try {
      await this.ssoClient.getServiceTicket(state.cookies, DUMMY_SERVICE);
      return "active";
    } catch (e) {
      if (isTransientError(e)) {
        console.warn(`[CquSession] ${state.studentId}: probe unreachable: ${errMsg(e)}`);
        return "transient";
      }
      // Non-network failure (e.g. TGT_EXPIRED): session invalid server-side.
    }

    // 2. Session expired server-side — try a fresh login. relogin() only
    //    overwrites cookies on success, so a failure leaves the old ones intact.
    try {
      await this.relogin();
      return "active";
    } catch (e) {
      if (isTransientError(e)) {
        console.warn(`[CquSession] ${state.studentId}: relogin unreachable: ${errMsg(e)}`);
        return "transient";
      }
      console.error(`[CquSession] ${state.studentId}: relogin rejected: ${errMsg(e)}`);
      return "expired";
    }
  }

  private async relogin(): Promise<void> {
    if (!this.state) throw new Error("No state");
    const creds =
      await this.ctx.storage.get<StoredCredentials>("credentials");
    if (!creds) throw new Error("No stored credentials");
    const password = await decrypt(
      creds.encryptedPassword,
      creds.iv,
      this.env.ENCRYPTION_KEY
    );
    const result = await this.ssoClient.login(
      this.state.studentId,
      password,
      DUMMY_SERVICE
    );
    this.state.cookies = result.cookies;
  }
}

function isTransientError(e: unknown): boolean {
  // Network errors (timeout/reset) and an unparseable page (CQU maintenance)
  // don't prove the credentials are bad — only a server-side auth rejection does.
  if (e instanceof CquSsoError) {
    return e.code === "NETWORK_ERROR" || e.code === "PARSE_ERROR";
  }
  return true; // unknown failure: be conservative, retry rather than flag re-login
}

function errMsg(e: unknown): string {
  if (e instanceof CquSsoError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
