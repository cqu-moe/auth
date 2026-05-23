# auth.cqu.moe Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a unified authentication service for cqu.moe on Cloudflare Workers, with Better Auth for user auth, Durable Objects for CQU SSO session management, and OAuth 2.0 for consumer app integration.

**Architecture:** Single Cloudflare Worker (Hono) serving a React SPA frontend and API backend. Better Auth handles user authentication/RBAC/OIDC. A Durable Object per user maintains CQU SSO sessions (cookie jar + alarm-based keepalive). Consumer apps integrate via OAuth 2.0 Authorization Code + PKCE with fine-grained CQU scope control.

**Tech Stack:** Cloudflare Workers, Hono, D1, Drizzle ORM, Better Auth, better-auth-cloudflare, React (Vite), shadcn/ui, Tailwind CSS, Cloudflare Email Service, Durable Objects, Web Crypto API (AES-256-GCM)

**Reference project:** `../schedule-cloudflare/` — same Hono + D1 + Drizzle patterns, has working CQU SSO implementation in `src/services/auth.ts`

---

## Phase 1: Project Scaffolding & Better Auth

### Task 1: Initialize project with Hono + Wrangler

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wrangler.jsonc`
- Create: `src/types.ts`
- Create: `src/index.ts`
- Create: `.gitignore`

**Step 1: Initialize npm project and install dependencies**

```bash
npm init -y
npm install hono drizzle-orm better-auth better-auth-cloudflare
npm install -D wrangler @cloudflare/workers-types @cloudflare/vitest-pool-workers typescript vitest drizzle-kit @types/node
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "types": ["@cloudflare/workers-types", "node"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx",
    "paths": { "@/*": ["./src/*"] },
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "frontend", "src/**/*.test.ts"]
}
```

**Step 3: Create wrangler.jsonc**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "auth-cqu-moe",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-01",
  "compatibility_flags": ["nodejs_compat"],

  "placement": { "hostname": "sso.cqu.edu.cn" },

  "assets": {
    "directory": "./frontend/dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": true
  },

  "d1_databases": [{
    "binding": "DATABASE",
    "database_name": "auth-cqu-moe-db",
    "database_id": "PLACEHOLDER",
    "migrations_dir": "drizzle/migrations"
  }],

  "kv_namespaces": [{
    "binding": "KV",
    "id": "PLACEHOLDER"
  }],

  "send_email": [{ "name": "EMAIL" }],

  "durable_objects": {
    "bindings": [{
      "name": "CQU_SESSION",
      "class_name": "CquSessionDO"
    }]
  },

  "migrations": [{
    "tag": "v1",
    "new_classes": ["CquSessionDO"]
  }]
}
```

**Step 4: Create src/types.ts**

```typescript
import type { D1Database, KVNamespace, DurableObjectNamespace } from "@cloudflare/workers-types";

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
}
```

**Step 5: Create minimal src/index.ts**

```typescript
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { HonoEnv } from "./types";

const app = new Hono<HonoEnv>();

app.use("/*", cors());

app.get("/api/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() })
);

export default app;
```

**Step 6: Create .gitignore**

```
node_modules/
.wrangler/
.dev.vars
frontend/dist/
frontend/node_modules/
*.tsbuildinfo
```

**Step 7: Add scripts to package.json**

Add these to the `scripts` field:
```json
{
  "dev": "wrangler dev",
  "deploy": "npm run build:frontend && wrangler deploy",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "db:generate": "drizzle-kit generate",
  "db:migrate:local": "wrangler d1 migrations apply auth-cqu-moe-db --local",
  "build:frontend": "cd frontend && npm install && npm run build"
}
```

**Step 8: Verify typecheck passes**

Run: `npx tsc --noEmit`
Expected: no errors (or only expected warnings)

**Step 9: Commit**

```bash
git add package.json tsconfig.json wrangler.jsonc src/types.ts src/index.ts .gitignore
git commit -m "feat: scaffold project with Hono + wrangler config"
```

---

### Task 2: Drizzle schema + D1 setup

**Files:**
- Create: `src/db/schema.ts`
- Create: `drizzle.config.ts`

**Step 1: Create drizzle.config.ts**

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle/migrations",
  schema: "./src/db/schema.ts",
  dialect: "sqlite",
});
```

**Step 2: Create src/db/schema.ts with custom tables**

Better Auth tables are auto-generated. Define only custom tables here:

```typescript
import { sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core";

export const cquCredentials = sqliteTable("cqu_credentials", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  studentId: text("student_id").notNull(),
  encryptedPassword: text("encrypted_password").notNull(),
  iv: text("iv").notNull(),
  boundAt: text("bound_at").notNull().default("(datetime('now'))"),
  lastLoginAt: text("last_login_at"),
  status: text("status").notNull().default("active"),
});

export const oauthClientCquScopes = sqliteTable(
  "oauth_client_cqu_scopes",
  {
    clientId: text("client_id").notNull(),
    scope: text("scope").notNull(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.scope] })]
);
```

**Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add drizzle.config.ts src/db/schema.ts
git commit -m "feat: add Drizzle schema for CQU credentials and OAuth scopes"
```

---

### Task 3: Better Auth configuration

**Files:**
- Create: `src/auth.ts`
- Modify: `src/index.ts`

**Step 1: Create src/auth.ts with Better Auth + Cloudflare config**

```typescript
import { betterAuth } from "better-auth";
import { withCloudflare } from "better-auth-cloudflare";
import { admin } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "./types";
import * as schema from "./db/schema";

// RBAC
export const statement = {
  user: ["read", "ban", "unban", "delete"],
  oauthClient: ["create", "read", "update", "delete"],
  cquScope: ["assign", "revoke"],
  auditLog: ["read"],
  role: ["assign", "revoke"],
} as const;

export const ac = createAccessControl(statement);

export const roles = {
  user: ac.newRole({}),
  admin: ac.newRole({
    user: ["read", "ban", "unban"],
    oauthClient: ["read"],
    auditLog: ["read"],
  }),
  superAdmin: ac.newRole({
    user: ["read", "ban", "unban", "delete"],
    oauthClient: ["create", "read", "update", "delete"],
    cquScope: ["assign", "revoke"],
    auditLog: ["read"],
    role: ["assign", "revoke"],
  }),
};

export function createAuth(env: Env, request: Request) {
  const db = drizzle(env.DATABASE, { schema });

  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    ...withCloudflare(
      {
        d1: { db, options: { usePlural: false } },
        kv: env.KV,
        cf: request.cf ?? {},
        autoDetectIpAddress: true,
      },
      {
        emailAndPassword: {
          enabled: true,
          async sendVerificationEmail({ user, url }) {
            await env.EMAIL.send({
              to: user.email,
              from: "noreply@cqu.moe",
              subject: "验证你的邮箱 - auth.cqu.moe",
              html: `<p>点击链接验证邮箱：<a href="${url}">${url}</a></p>`,
            });
          },
          async sendResetPasswordEmail({ user, url }) {
            await env.EMAIL.send({
              to: user.email,
              from: "noreply@cqu.moe",
              subject: "重置密码 - auth.cqu.moe",
              html: `<p>点击链接重置密码：<a href="${url}">${url}</a></p>`,
            });
          },
        },
        plugins: [
          admin({
            ac,
            roles,
            defaultRole: "user",
          }),
        ],
        rateLimit: {
          enabled: true,
          window: 60,
          max: 30,
        },
      }
    ),
  });
}
```

**Step 2: Mount Better Auth routes in src/index.ts**

```typescript
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { HonoEnv } from "./types";
import { createAuth } from "./auth";

const app = new Hono<HonoEnv>();

app.use("/*", cors());

app.get("/api/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() })
);

app.all("/api/auth/*", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  return auth.handler(c.req.raw);
});

export default app;
```

**Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (may need to adjust types based on better-auth-cloudflare version)

**Step 4: Commit**

```bash
git add src/auth.ts src/index.ts
git commit -m "feat: configure Better Auth with Cloudflare D1, RBAC, and email"
```

---

## Phase 2: CQU SSO Integration

### Task 4: AES encryption service (Web Crypto API)

**Files:**
- Create: `src/services/crypto.ts`
- Create: `src/services/crypto.test.ts`

**Step 1: Write tests for crypto service**

```typescript
import { describe, it, expect } from "vitest";
import { encrypt, decrypt, encryptAesEcb } from "./crypto";

describe("AES-256-GCM", () => {
  it("encrypts and decrypts a string", async () => {
    const key = "dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXQ="; // 32 bytes base64
    const plaintext = "my-secret-password";
    const { ciphertext, iv } = await encrypt(plaintext, key);
    const decrypted = await decrypt(ciphertext, iv, key);
    expect(decrypted).toBe(plaintext);
  });
});

describe("AES-ECB (CQU password encryption)", () => {
  it("encrypts password with croypto key", () => {
    const key = "d9XYfl9siLfxBU+Ze1LxSQ=="; // 16 bytes base64
    const result = encryptAesEcb("test", key);
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/crypto.test.ts`
Expected: FAIL — modules not found

**Step 3: Implement crypto service**

```typescript
// AES-256-GCM for storing CQU credentials
export async function encrypt(
  plaintext: string,
  keyBase64: string
): Promise<{ ciphertext: string; iv: string }> {
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );
  return {
    ciphertext: bufferToBase64(encrypted),
    iv: bufferToBase64(iv),
  };
}

export async function decrypt(
  ciphertextBase64: string,
  ivBase64: string,
  keyBase64: string
): Promise<string> {
  const key = await importKey(keyBase64);
  const iv = base64ToBuffer(ivBase64);
  const ciphertext = base64ToBuffer(ciphertextBase64);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );
  return new TextDecoder().decode(decrypted);
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  const raw = base64ToBuffer(keyBase64);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

// AES-ECB for CQU SSO password encryption (matches CQU's croypto)
export function encryptAesEcb(plaintext: string, keyBase64: string): string {
  const { createCipheriv } = require("node:crypto");
  const key = Buffer.from(keyBase64, "base64");
  const algo = key.length <= 16 ? "aes-128-ecb" : "aes-256-ecb";
  const cipher = createCipheriv(algo, key, "");
  return Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]).toString("base64");
}

function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
```

**Step 4: Run tests**

Run: `npx vitest run src/services/crypto.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/crypto.ts src/services/crypto.test.ts
git commit -m "feat: add AES-256-GCM and AES-ECB crypto services"
```

---

### Task 5: CQU CAS login service

**Files:**
- Create: `src/services/cqu-sso.ts`
- Create: `src/services/cqu-sso.test.ts`

**Step 1: Write tests for CQU SSO service**

Test HTML parsing and login flow with mocked fetch. Reference `../schedule-cloudflare/src/services/auth.ts` for the proven implementation patterns.

```typescript
import { describe, it, expect, vi } from "vitest";
import { parseLoginPage, CquSsoClient } from "./cqu-sso";

describe("parseLoginPage", () => {
  it("extracts execution, croypto, and captchaId from HTML", () => {
    const html = `
      <input id="login-page-flowkey" value="e1s1" />
      <input id="login-croypto" value="d9XYfl9siLfxBU+Ze1LxSQ==" />
      <p id="captchaId">abc123</p>
    `;
    const result = parseLoginPage(html);
    expect(result.execution).toBe("e1s1");
    expect(result.croypto).toBe("d9XYfl9siLfxBU+Ze1LxSQ==");
    expect(result.captchaId).toBe("abc123");
  });

  it("throws when execution is missing", () => {
    const html = `<html><body>no fields</body></html>`;
    expect(() => parseLoginPage(html)).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/cqu-sso.test.ts`
Expected: FAIL

**Step 3: Implement CQU SSO client**

Adapt from `../schedule-cloudflare/src/services/auth.ts`. Key differences: no D1 dependency (DO handles state), returns cookies instead of tokens.

```typescript
const SSO_BASE = "https://sso.cqu.edu.cn";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";

export class CquSsoError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "CquSsoError";
  }
}

export interface LoginPageParams {
  execution: string;
  croypto: string;
  captchaId: string | null;
}

export interface CasCookies {
  SOURCEID_TGC: string;
  SESSION: string;
  rg_objectid: string;
}

export interface LoginResult {
  cookies: CasCookies;
  serviceTicket: string;
}

export function parseLoginPage(html: string): LoginPageParams {
  const execution = extractValue(html, "login-page-flowkey");
  const croypto = extractValue(html, "login-croypto");
  const captchaId = extractText(html, "captchaId");

  if (!execution || !croypto) {
    throw new CquSsoError(
      "PARSE_ERROR",
      "Failed to parse SSO login page"
    );
  }

  return { execution, croypto, captchaId };
}

function extractValue(html: string, id: string): string | null {
  const regex = new RegExp(`id=["']${id}["'][^>]*(?:value=["']([^"']+)["']|>([^<]+)<)`, "s");
  const match = html.match(regex);
  return match?.[1] ?? match?.[2] ?? null;
}

function extractText(html: string, id: string): string | null {
  const regex = new RegExp(`id=["']${id}["'][^>]*>([^<]*)`, "s");
  const match = html.match(regex);
  return match?.[1]?.trim() || null;
}

export class CquSsoClient {
  async login(
    username: string,
    password: string,
    serviceUrl: string = "https://sso.cqu.edu.cn/onlineCheck"
  ): Promise<LoginResult> {
    // Step 1: Get login page
    const pageResp = await fetch(
      `${SSO_BASE}/login?service=${encodeURIComponent(serviceUrl)}`,
      {
        headers: { "User-Agent": BROWSER_UA },
        redirect: "manual",
      }
    );
    const html = await pageResp.text();
    const params = parseLoginPage(html);
    const sessionCookies = parseCookies(pageResp.headers);

    // Step 2: Encrypt password
    const { encryptAesEcb } = await import("./crypto");
    const encryptedPassword = encryptAesEcb(password, params.croypto);
    const captchaPayload = encryptAesEcb("{}", params.croypto);

    // Step 3: Submit login
    const form = new URLSearchParams({
      username,
      password: encryptedPassword,
      type: "UsernamePassword",
      execution: params.execution,
      _eventId: "submit",
      croypto: params.croypto,
      captcha_payload: captchaPayload,
      geolocation: "",
    });

    const loginResp = await fetch(
      `${SSO_BASE}/login?service=${encodeURIComponent(serviceUrl)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": BROWSER_UA,
          Cookie: formatCookies(sessionCookies),
        },
        redirect: "manual",
        body: form.toString(),
      }
    );

    if (loginResp.status !== 302) {
      throw new CquSsoError("LOGIN_FAILED", "CAS login failed");
    }

    const location = loginResp.headers.get("Location") ?? "";
    const ticketMatch = location.match(/ticket=(ST-[^&]+)/);
    if (!ticketMatch) {
      throw new CquSsoError("NO_TICKET", "No ticket in redirect");
    }

    const allCookies = {
      ...sessionCookies,
      ...parseCookies(loginResp.headers),
    };

    return {
      cookies: {
        SOURCEID_TGC: allCookies["SOURCEID_TGC"] ?? "",
        SESSION: allCookies["SESSION"] ?? "",
        rg_objectid: allCookies["rg_objectid"] ?? "",
      },
      serviceTicket: ticketMatch[1],
    };
  }

  async getServiceTicket(
    cookies: CasCookies,
    serviceUrl: string
  ): Promise<string> {
    const cookieStr = `SOURCEID_TGC=${cookies.SOURCEID_TGC}; SESSION=${cookies.SESSION}; rg_objectid=${cookies.rg_objectid}`;
    const resp = await fetch(
      `${SSO_BASE}/login?service=${encodeURIComponent(serviceUrl)}`,
      {
        headers: {
          "User-Agent": BROWSER_UA,
          Cookie: cookieStr,
        },
        redirect: "manual",
      }
    );

    if (resp.status !== 302) {
      throw new CquSsoError("TGT_EXPIRED", "CAS session expired");
    }

    const location = resp.headers.get("Location") ?? "";
    const match = location.match(/ticket=(ST-[^&]+)/);
    if (!match) {
      throw new CquSsoError("NO_TICKET", "No ticket in redirect");
    }
    return match[1];
  }

  async checkOnline(cookies: CasCookies): Promise<boolean> {
    const cookieStr = `SOURCEID_TGC=${cookies.SOURCEID_TGC}; SESSION=${cookies.SESSION}; rg_objectid=${cookies.rg_objectid}`;
    const resp = await fetch(`${SSO_BASE}/onlineCheck`, {
      headers: {
        "User-Agent": BROWSER_UA,
        Cookie: cookieStr,
      },
    });
    return resp.status === 200;
  }
}

function parseCookies(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  const setCookies = headers.getAll?.("Set-Cookie") ?? headers.getSetCookie?.() ?? [];
  for (const cookie of setCookies) {
    const [nameValue] = cookie.split(";");
    const eqIdx = nameValue.indexOf("=");
    if (eqIdx > 0) {
      result[nameValue.substring(0, eqIdx).trim()] =
        nameValue.substring(eqIdx + 1).trim();
    }
  }
  return result;
}

function formatCookies(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}
```

**Step 4: Run tests**

Run: `npx vitest run src/services/cqu-sso.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/cqu-sso.ts src/services/cqu-sso.test.ts
git commit -m "feat: implement CQU CAS SSO login client"
```

---

### Task 6: CQU Session Durable Object

**Files:**
- Create: `src/durable-objects/cqu-session.ts`
- Modify: `src/index.ts` (export DO class)

**Step 1: Implement CquSessionDO**

```typescript
import { DurableObject } from "cloudflare:workers";
import { CquSsoClient, type CasCookies } from "../services/cqu-sso";
import { decrypt } from "../services/crypto";
import type { Env } from "../types";

const KEEPALIVE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DUMMY_SERVICE = "https://sso.cqu.edu.cn/onlineCheck";

// Service URL mapping for scope-based ticket requests
const SERVICE_URLS: Record<string, string> = {
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
}

export class CquSessionDO extends DurableObject<Env> {
  private state: SessionState | null = null;
  private ssoClient = new CquSsoClient();

  async init(
    userId: string,
    studentId: string,
    encryptedPassword: string,
    iv: string
  ): Promise<{ success: boolean; error?: string }> {
    const password = await decrypt(encryptedPassword, iv, this.env.ENCRYPTION_KEY);

    try {
      const result = await this.ssoClient.login(studentId, password, DUMMY_SERVICE);

      this.state = {
        userId,
        studentId,
        cookies: result.cookies,
        objectId: "",
        tgt: "",
        lastKeepAlive: Date.now(),
        lastRequestedAt: Date.now(),
        status: "active",
      };

      await this.ctx.storage.put("state", this.state);
      await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);

      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
    }
  }

  async getServiceTicket(service: string): Promise<string> {
    await this.loadState();
    if (!this.state || this.state.status !== "active") {
      throw new Error("CQU session not active");
    }

    const serviceUrl = SERVICE_URLS[service];
    if (!serviceUrl) {
      throw new Error(`Unknown service: ${service}`);
    }

    this.state.lastRequestedAt = Date.now();
    await this.ctx.storage.put("state", this.state);

    return this.ssoClient.getServiceTicket(this.state.cookies, serviceUrl);
  }

  async getStatus(): Promise<{ status: string; studentId?: string; lastKeepAlive?: number }> {
    await this.loadState();
    if (!this.state) return { status: "unbound" };
    return {
      status: this.state.status,
      studentId: this.state.studentId,
      lastKeepAlive: this.state.lastKeepAlive,
    };
  }

  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.state = null;
  }

  async alarm(): Promise<void> {
    await this.loadState();
    if (!this.state) return;

    try {
      // Try to get a throwaway ST to "use" the TGT
      await this.ssoClient.getServiceTicket(this.state.cookies, DUMMY_SERVICE);
      this.state.lastKeepAlive = Date.now();
      this.state.status = "active";
    } catch {
      // TGT expired — attempt re-login
      try {
        await this.relogin();
        this.state.lastKeepAlive = Date.now();
        this.state.status = "active";
      } catch {
        this.state.status = "error";
      }
    }

    await this.ctx.storage.put("state", this.state);
    await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);
  }

  private async relogin(): Promise<void> {
    if (!this.state) throw new Error("No state");

    // Read encrypted password from D1 via env
    // DO can't directly query D1, so we use a fetch to our own worker
    const resp = await this.env.CQU_SESSION.get(
      this.env.CQU_SESSION.idFromName("internal")
    ).fetch("https://internal/noop");
    // Actually, DO can fetch its own worker — but for simplicity,
    // store encrypted creds in DO storage at init time
    const creds = await this.ctx.storage.get<{
      encryptedPassword: string;
      iv: string;
    }>("credentials");
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

  private async loadState(): Promise<void> {
    if (!this.state) {
      this.state = (await this.ctx.storage.get("state")) ?? null;
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
          // Store creds in DO storage for re-login
          await this.ctx.storage.put("credentials", {
            encryptedPassword: body.encryptedPassword,
            iv: body.iv,
          });
          const result = await this.init(
            body.userId,
            body.studentId,
            body.encryptedPassword,
            body.iv
          );
          return Response.json(result);
        }
        case "service-ticket": {
          const service = url.searchParams.get("service");
          if (!service) return Response.json({ error: "Missing service" }, { status: 400 });
          const ticket = await this.getServiceTicket(service);
          return Response.json({ ticket });
        }
        case "status": {
          const status = await this.getStatus();
          return Response.json(status);
        }
        case "destroy": {
          await this.destroy();
          return Response.json({ success: true });
        }
        default:
          return Response.json({ error: "Unknown action" }, { status: 404 });
      }
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : "Internal error" },
        { status: 500 }
      );
    }
  }
}
```

**Step 2: Export DO from src/index.ts**

Add to the end of `src/index.ts`:

```typescript
export { CquSessionDO } from "./durable-objects/cqu-session";
```

**Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/durable-objects/cqu-session.ts src/index.ts
git commit -m "feat: implement CQU Session Durable Object with keepalive"
```

---

### Task 7: CQU API routes

**Files:**
- Create: `src/routes/cqu.ts`
- Modify: `src/index.ts`

**Step 1: Implement CQU routes**

```typescript
import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { createAuth } from "../auth";
import { encrypt } from "../services/crypto";
import { errorResponse } from "../utils/error";

const cqu = new Hono<HonoEnv>();

// Middleware: require authenticated user
async function requireUser(c: any, next: any) {
  const auth = createAuth(c.env, c.req.raw);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) return errorResponse(c, "UNAUTHORIZED", "未登录", 401);
  c.set("user", session.user);
  return next();
}

cqu.use("/*", requireUser);

// POST /api/cqu/bind — Bind CQU account
cqu.post("/bind", async (c) => {
  const user = c.get("user");
  const { studentId, password } = await c.req.json<{
    studentId: string;
    password: string;
  }>();

  // Encrypt password for storage
  const { ciphertext, iv } = await encrypt(password, c.env.ENCRYPTION_KEY);

  // Store in D1
  const { drizzle } = await import("drizzle-orm/d1");
  const db = drizzle(c.env.DATABASE);
  const id = crypto.randomUUID();

  // Import schema dynamically to avoid circular deps
  const { cquCredentials } = await import("../db/schema");
  await db.insert(cquCredentials).values({
    id,
    userId: user.id,
    studentId,
    encryptedPassword: ciphertext,
    iv,
  });

  // Initialize DO session
  const doId = c.env.CQU_SESSION.idFromName(user.id);
  const stub = c.env.CQU_SESSION.get(doId);
  const result = await stub.fetch(
    new Request("https://do/init", {
      method: "POST",
      body: JSON.stringify({
        userId: user.id,
        studentId,
        encryptedPassword: ciphertext,
        iv,
      }),
    })
  );
  const initResult = await result.json<{ success: boolean; error?: string }>();

  if (!initResult.success) {
    // Rollback D1 insert
    const { eq } = await import("drizzle-orm");
    await db.delete(cquCredentials).where(eq(cquCredentials.id, id));
    return errorResponse(c, "CQU_LOGIN_FAILED", initResult.error ?? "CQU 登录失败", 400);
  }

  return c.json({ success: true, studentId });
});

// DELETE /api/cqu/bind — Unbind CQU account
cqu.delete("/bind", async (c) => {
  const user = c.get("user");

  // Delete from D1
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { cquCredentials } = await import("../db/schema");
  const db = drizzle(c.env.DATABASE);
  await db.delete(cquCredentials).where(eq(cquCredentials.userId, user.id));

  // Destroy DO
  const doId = c.env.CQU_SESSION.idFromName(user.id);
  const stub = c.env.CQU_SESSION.get(doId);
  await stub.fetch(new Request("https://do/destroy", { method: "POST" }));

  return c.json({ success: true });
});

// GET /api/cqu/status — Check binding status
cqu.get("/status", async (c) => {
  const user = c.get("user");
  const doId = c.env.CQU_SESSION.idFromName(user.id);
  const stub = c.env.CQU_SESSION.get(doId);
  const resp = await stub.fetch(new Request("https://do/status"));
  const status = await resp.json();
  return c.json(status);
});

// GET /api/cqu/service-ticket?service=jwxt — Get Service Ticket
cqu.get("/service-ticket", async (c) => {
  const service = c.req.query("service");
  if (!service) return errorResponse(c, "MISSING_SERVICE", "缺少 service 参数", 400);

  // TODO: Check OAuth scope (cqu:ticket:<service>) when called via OAuth token
  // For now, any authenticated user can request ST for their own bound account

  const user = c.get("user");
  const doId = c.env.CQU_SESSION.idFromName(user.id);
  const stub = c.env.CQU_SESSION.get(doId);
  const resp = await stub.fetch(
    new Request(`https://do/service-ticket?service=${service}`)
  );

  if (!resp.ok) {
    const err = await resp.json<{ error: string }>();
    return errorResponse(c, "ST_FAILED", err.error, resp.status);
  }

  const { ticket } = await resp.json<{ ticket: string }>();
  return c.json({ ticket, service });
});

export { cqu };
```

**Step 2: Create src/utils/error.ts**

```typescript
import type { Context } from "hono";

export function errorResponse(
  c: Context,
  code: string,
  message: string,
  status: number = 400
) {
  return c.json(
    { detail: { error: { code, message } } },
    { status }
  );
}
```

**Step 3: Mount in src/index.ts**

```typescript
import { cqu } from "./routes/cqu";
// ...
app.route("/api/cqu", cqu);
```

**Step 4: Typecheck**

Run: `npx tsc --noEmit`

**Step 5: Commit**

```bash
git add src/routes/cqu.ts src/utils/error.ts src/index.ts
git commit -m "feat: add CQU credential binding and service ticket API routes"
```

---

## Phase 3: Admin Routes & OAuth Scope Control

### Task 8: Admin API routes

**Files:**
- Create: `src/routes/admin.ts`
- Modify: `src/index.ts`

Implement admin endpoints for user management and OAuth client management. Use Better Auth's admin plugin for user operations. Custom routes for CQU scope management.

Key endpoints:
- `GET /api/admin/users` — paginated user list
- `GET /api/admin/users/:id` — user detail + CQU binding status
- `PATCH /api/admin/users/:id` — ban/unban/role changes
- `GET /api/admin/oauth-clients` — list OAuth clients
- `POST /api/admin/oauth-clients` — create client
- `PUT /api/admin/oauth-clients/:id/scopes` — configure CQU scopes

**Commit:** `feat: add admin API routes for user and OAuth client management`

---

### Task 9: OAuth scope validation middleware

**Files:**
- Create: `src/middleware/scope.ts`
- Modify: `src/routes/cqu.ts`

Add middleware that checks `cqu:ticket:<service>` scope on the access token when the CQU service-ticket endpoint is called via OAuth (Bearer token from a consumer app).

**Commit:** `feat: add OAuth scope validation for CQU ticket requests`

---

## Phase 4: Frontend

### Task 10: Scaffold React + Vite frontend

**Files:**
- Create: `frontend/` (Vite + React + TypeScript)
- Install: shadcn/ui, Tailwind CSS, React Router

```bash
cd frontend
npm create vite@latest . -- --template react-ts
npm install @radix-ui/react-* class-variance-authority clsx tailwind-merge lucide-react react-router
npx shadcn-ui@latest init
```

**Commit:** `feat: scaffold React frontend with Vite, shadcn/ui, Tailwind`

---

### Task 11: Auth pages (Login, Register, Reset Password)

**Files:**
- Create: `frontend/src/pages/Login.tsx`
- Create: `frontend/src/pages/Register.tsx`
- Create: `frontend/src/pages/ResetPassword.tsx`

Use Better Auth React client SDK. Form validation, error handling, 简体中文 UI text.

**Commit:** `feat: implement login, register, and password reset pages`

---

### Task 12: Settings page (CQU binding)

**Files:**
- Create: `frontend/src/pages/Settings.tsx`

User can bind/unbind CQU account, view session health status, change password.

**Commit:** `feat: implement settings page with CQU account binding`

---

### Task 13: Admin panel

**Files:**
- Create: `frontend/src/pages/Admin.tsx`
- Create: `frontend/src/pages/admin/Users.tsx`
- Create: `frontend/src/pages/admin/OAuthClients.tsx`

Admin dashboard with user management table, OAuth client management with CQU scope checkboxes.

**Commit:** `feat: implement admin panel with user and OAuth client management`

---

### Task 14: OAuth authorize page

**Files:**
- Create: `frontend/src/pages/OAuthAuthorize.tsx`

Shows requested scopes (including `cqu:ticket:*` scopes), user approves/denies.

**Commit:** `feat: implement OAuth authorization consent page`

---

## Phase 5: Integration & Deployment

### Task 15: Create D1 database and deploy

```bash
npx wrangler d1 create auth-cqu-moe-db
# Update database_id in wrangler.jsonc with returned ID
npx wrangler kv namespace create KV
# Update KV id in wrangler.jsonc

# Set secrets
wrangler secret put ENCRYPTION_KEY
wrangler secret put BETTER_AUTH_SECRET

# Generate and apply migrations
npm run db:generate
npx wrangler d1 migrations apply auth-cqu-moe-db --remote

# Deploy
npm run deploy
```

**Commit:** `chore: configure production D1 and KV bindings`

---

### Task 16: OIDC Provider setup

Configure Better Auth's OIDC Provider plugin for consumer app integration. Register schedule-cloudflare as the first OAuth client.

**Commit:** `feat: configure OIDC Provider and register schedule-cloudflare client`

---

### Task 17: End-to-end integration test

Test the full flow:
1. Register user on auth.cqu.moe
2. Bind CQU account
3. Register OAuth client (schedule) with `cqu:ticket:jwxt` scope
4. OAuth login flow from consumer → auth → callback
5. Consumer uses access_token to request ST
6. Verify ST is valid by exchanging with CQU

**Commit:** `test: add end-to-end integration test for full OAuth + CQU flow`

---

## Summary

| Phase | Tasks | What it delivers |
|---|---|---|
| 1. Scaffolding | 1-3 | Working Hono + Better Auth + D1 with user registration/login |
| 2. CQU SSO | 4-7 | CQU account binding, DO session management, Service Ticket API |
| 3. Admin | 8-9 | Admin panel API, OAuth scope control |
| 4. Frontend | 10-14 | React SPA with all pages |
| 5. Deploy | 15-17 | Production deployment, OIDC, integration test |
