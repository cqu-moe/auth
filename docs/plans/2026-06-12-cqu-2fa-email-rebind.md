# CQU 2FA 邮件取码无人值守会话重绑 — 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 CQU 增强登录（密码 + 密保邮箱 2FA + 瑞数 WAF）下的用户会话**无人值守持续可用**——CF Email Routing 自动捕获 2FA 验证码 + CF Containers 跑 patchright 完成浏览器登录，每 ~7h 自动重铸 TGT；热路径取 ST 保活/发 ticket 仍走纯 fetch。

**Architecture:** 详见同目录 `2026-06-12-cqu-2fa-email-rebind-design.md`。控制平面 D1（地址映射/白名单/密码），数据平面 DO（活会话/状态机/取码暂存/WS）。浏览器登录器在 CF Containers（复用 `cqu-api-endpoint-collection/systems/auth/cqu_login.py`）。取码靠推送（绑定码→浏览器 WS；2FA 码→DO 推容器），不轮询。

**Tech Stack:** Cloudflare Workers (Hono) · Durable Objects (+ Hibernatable WebSocket) · D1 (Drizzle) · CF Containers (`@cloudflare/containers`) · Email Routing (`email()` handler + PostalMime) · Python aiohttp + patchright · vitest（Node pool，仅测纯函数）。

**关键约束（来自逆向，勿违反）：**
- 「发验证码」必须真浏览器内原生点击（纯 fetch → 412）；第一因素/提交码用**表单导航式**（Angular-XHR → 400）。
- 取 ST 凭 `SOURCEID_TGC` 换 ticket 对瑞数豁免（纯 fetch 可做）；TGT ~8h 绝对寿命。
- `cqu.edu.cn` **无 DMARC/DKIM**，发件人校验靠 **SPF=pass + envelope=sso@cqu.edu.cn + 源 IP∈202.202.0.0/24**。
- 测试在 Node pool（无 Workers 绑定）→ **只 TDD 纯函数**；集成走 `wrangler dev` + 真实账号手动验证。
- 相关技能：@superpowers:test-driven-development @cloudflare:wrangler @cloudflare:durable-objects @cloudflare:cloudflare-email-service

---

## Phase 0 — 逆向闭合（实施前必须，全是手动实验，无代码）

阻塞性未知项；任一为否都要改设计。**不写代码，记录结论到设计文档 §12。**

### Task 0.1: 验证 CQU 密保邮箱接受外部域
- 用真实账号登录 `self.cqu.edu.cn/cas-success/safe-center/bind-email-password/bind`，尝试把密保邮箱设为一个你控制的外部域地址（如 `probe@<你的测试域>`）。
- **验证**：能否提交并收到"密保邮箱绑定验证码"邮件。✅ 已有真实样本（`密保邮箱绑定验证码.eml`，发件 `sso@cqu.edu.cn`，6 位码，TTL 2min）→ 基本确认可行，但需确认 `@bind.cqu.moe` 这类**你将用的真实域**不被拒。
- **失败应对**：若限制域 → 改走 §转发模式（用户保留自己邮箱 + 转发规则）为主。

### Task 0.2: 验证 CF Email Routing 对 SPF-fail 邮件的投递行为
- 在一个测试 zone 上开 Email Routing catch-all → 一个最小 `email()` Worker（仅 `console.log(message.from, message.headers.get("authentication-results"))`）。
- 从一个**伪造 From: sso@cqu.edu.cn 但非 CQU IP** 的来源发测试信。
- **验证**：CF 是否仍把 SPF-fail 信投到 Worker（决定我们 `setReject` 把关位置），以及 `authentication-results` 头里 `spf=` 字段的确切格式。
- **记录**：CF 注入的 `Authentication-Results` 头精确文本（Phase 2 解析正则要对齐）。

### Task 0.3: basic(1 GiB) Chromium OOM 实测
- 本地 Docker 跑 `linux/amd64` Debian + Chromium + patchright，限内存 1 GiB，跑一次 `cqu_login.py --stop-before-code`。
- **验证**：是否 OOM。✅ → 用 basic（成本 ÷4）；❌ → 用 standard-1。
- 记录到设计文档 §11.5 / §12。

### Task 0.4: 选定专用收信域/zone
- **勿在 cqu.moe 顶级开 catch-all**（会劫持现有 @cqu.moe 收信）。选一个专用 zone（如子域 `bind.cqu.moe` 独立 MX，或单独域名）。
- 在 CF 开 Email Routing + catch-all，确认 MX 生效（`dig MX`）。

---

## Phase 1 — D1 schema：地址映射表

### Task 1.1: 加 `cquBindAddresses` 表到 schema

**Files:**
- Modify: `src/db/schema.ts`（末尾追加）

**Step 1: 追加表定义**
```ts
export const cquBindAddresses = sqliteTable("cqu_bind_addresses", {
  token: text("token").primaryKey(),                    // 专属地址本地部分（随机不可枚举）
  userId: text("user_id").notNull().unique(),
  kind: text("kind").notNull().default("direct"),       // direct | forward
  senderWhitelist: text("sender_whitelist").notNull(),  // JSON 字符串数组
  status: text("status").notNull().default("pending"),  // pending | active | revoked
  boundAt: text("bound_at").notNull().default("(datetime('now'))"),
  lastCodeAt: text("last_code_at"),
});
```

**Step 2: 生成 migration**

Run: `npm run db:generate`
Expected: 在 `migrations/` 生成新 SQL 文件含 `CREATE TABLE cqu_bind_addresses`。
> 若 drizzle-kit 对函数式 auth 报错，手写 SQL migration（见 CLAUDE.md）。

**Step 3: 本地应用**

Run: `npm run db:migrate:local`
Expected: `cqu_bind_addresses` 建表成功。

**Step 4: typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/db/schema.ts migrations/
git commit -m "feat(db): add cqu_bind_addresses table for 2FA email mapping"
```

---

## Phase 2 — 纯逻辑单元（全 TDD，co-located `*.test.ts`）

新建 `src/services/cqu-2fa/`，每个纯函数一文件 + 同名 `.test.ts`。这是计划里**唯一能真正 TDD 的部分**，务必先测后码。

### Task 2.1: `localPart(address)` — 取收件地址本地部分

**Files:**
- Create: `src/services/cqu-2fa/address.ts`
- Test: `src/services/cqu-2fa/address.test.ts`

**Step 1: 写失败测试**
```ts
import { describe, it, expect } from "vitest";
import { localPart } from "./address";

describe("localPart", () => {
  it("extracts local part, lowercased", () => {
    expect(localPart("AbC123@bind.cqu.moe")).toBe("abc123");
  });
  it("strips +subaddressing", () => {
    expect(localPart("tok+anything@bind.cqu.moe")).toBe("tok");
  });
  it("returns empty for malformed", () => {
    expect(localPart("not-an-email")).toBe("");
  });
});
```

**Step 2: 跑测试确认失败** — Run: `npm run test -- address` → FAIL（模块不存在）。

**Step 3: 最小实现**
```ts
export function localPart(address: string): string {
  const at = address.indexOf("@");
  if (at <= 0) return "";
  return address.slice(0, at).split("+")[0].trim().toLowerCase();
}
```

**Step 4: 跑测试确认通过** — Run: `npm run test -- address` → PASS。

**Step 5: Commit**
```bash
git add src/services/cqu-2fa/address.ts src/services/cqu-2fa/address.test.ts
git commit -m "feat(2fa): localPart address parser"
```

### Task 2.2: `genAddressToken()` — 随机不可枚举地址 token

**Files:** Create `src/services/cqu-2fa/token.ts` + `token.test.ts`

**Step 1: 失败测试**
```ts
import { describe, it, expect } from "vitest";
import { genAddressToken } from "./token";
describe("genAddressToken", () => {
  it("returns 24-char url-safe lowercase, unique", () => {
    const a = genAddressToken(), b = genAddressToken();
    expect(a).toMatch(/^[a-z0-9]{24}$/);   // 邮箱地址友好：纯小写字母数字
    expect(a).not.toBe(b);
  });
});
```

**Step 2: 确认失败** — `npm run test -- token` → FAIL。

**Step 3: 实现**（用 Web Crypto，对齐仓库风格）
```ts
export function genAddressToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (const b of bytes) out += alphabet[b % 36];
  // 15 bytes → 取 24 字符（够 ~124 bit 熵）
  return (out + out).slice(0, 24);
}
```
> 注：上面 slice 占位，改成对 24 字节取模更干净——实现时用 `new Uint8Array(24)` 循环 36 取模，去掉拼接。测试只校验格式+唯一，按测试改到通过即可。

**Step 4: 确认通过** — `npm run test -- token` → PASS。

**Step 5: Commit** — `git commit -m "feat(2fa): unguessable address token generator"`

### Task 2.3: `extractCode(subject, text)` — 按主题分流提码（真实样本驱动）

**Files:** Create `src/services/cqu-2fa/extract-code.ts` + `extract-code.test.ts`

**Step 1: 失败测试（用真实样本的脱敏正文）**
```ts
import { describe, it, expect } from "vitest";
import { extractCode } from "./extract-code";

const LOGIN_SUBJECT = "邮件验证码登录";
const LOGIN_TEXT = "您正在进行统一身份认证，请在页面中输入下方验证码完成验证 740004 安全提示：若并非你本人在操作，请忽略此邮件，切勿将验证码告知他人 为保障您的帐户安全，请在 600 秒内完成验证，否则验证码将自动失效。";

const BIND_SUBJECT = "密保邮箱绑定验证码";
const BIND_TEXT = "尊敬的 测试用户(30200000)，您的验证码为：943754，有效期2分钟。";

describe("extractCode", () => {
  it("login 2FA: picks 6-digit code, not the 600 TTL", () => {
    expect(extractCode(LOGIN_SUBJECT, LOGIN_TEXT)).toEqual({ code: "740004", kind: "login_2fa" });
  });
  it("bind confirm: anchors on 验证码为, not the 8-digit student id", () => {
    expect(extractCode(BIND_SUBJECT, BIND_TEXT)).toEqual({ code: "943754", kind: "bind_confirm" });
  });
  it("unknown subject -> null", () => {
    expect(extractCode("通知", "您有一条新消息 123456")).toBeNull();
  });
  it("bind text without 验证码为 anchor -> null (avoid eating student id)", () => {
    expect(extractCode(BIND_SUBJECT, "学号30200000 无码")).toBeNull();
  });
});
```

**Step 2: 确认失败** — `npm run test -- extract-code` → FAIL。

**Step 3: 实现**
```ts
export type CodeHit = { code: string; kind: "login_2fa" | "bind_confirm" };

export function extractCode(subject: string, text: string): CodeHit | null {
  const s = (subject || "").trim();
  const t = text || "";
  if (s.includes("邮件验证码登录")) {
    const m = t.match(/(?<!\d)(\d{6})(?!\d)/);   // 600 是 3 位不命中
    return m ? { code: m[1], kind: "login_2fa" } : null;
  }
  if (s.includes("密保邮箱绑定验证码")) {
    const m = t.match(/验证码为[:：]\s*(\d{6})/);  // 必须锚定，避开学号前 6 位
    return m ? { code: m[1], kind: "bind_confirm" } : null;
  }
  return null;
}
```

**Step 4: 确认通过** — `npm run test -- extract-code` → PASS。

**Step 5: Commit** — `git commit -m "feat(2fa): subject-routed verification code extractor"`

### Task 2.4: `parseInboundAuth(headers)` — 解析 SPF/envelope/源 IP

**Files:** Create `src/services/cqu-2fa/sender-auth.ts` + `sender-auth.test.ts`

> 头部精确格式以 Phase 0 Task 0.2 实测的 CF `Authentication-Results` 为准；下方按已抓样本（Fastmail 头）写，实施时按 CF 真头微调正则。

**Step 1: 失败测试**
```ts
import { describe, it, expect } from "vitest";
import { parseInboundAuth, senderVerified } from "./sender-auth";

const AUTH = "phl-mx-03; spf=pass smtp.mailfrom=sso@cqu.edu.cn smtp.helo=cqu.edu.cn; dkim=none; dmarc=none";
const RECEIVED = "from cqu.edu.cn (smtp.cqu.edu.cn [202.202.0.26]) by phl-mx-03 ...";

describe("parseInboundAuth", () => {
  it("extracts spf result, envelope from, source ip", () => {
    expect(parseInboundAuth(AUTH, RECEIVED)).toEqual({
      spf: "pass", envelopeFrom: "sso@cqu.edu.cn", sourceIp: "202.202.0.26",
    });
  });
});

describe("senderVerified", () => {
  const bind = { kind: "direct", senderWhitelist: ["sso@cqu.edu.cn"] };
  it("accepts spf=pass + official envelope + CQU ip", () => {
    expect(senderVerified({ spf: "pass", envelopeFrom: "sso@cqu.edu.cn", sourceIp: "202.202.0.26" }, bind)).toBe(true);
  });
  it("rejects spoofed From with spf=fail", () => {
    expect(senderVerified({ spf: "fail", envelopeFrom: "sso@cqu.edu.cn", sourceIp: "1.2.3.4" }, bind)).toBe(false);
  });
  it("rejects non-CQU source ip even if spf=pass", () => {
    expect(senderVerified({ spf: "pass", envelopeFrom: "sso@cqu.edu.cn", sourceIp: "8.8.8.8" }, bind)).toBe(false);
  });
});
```

**Step 2: 确认失败** — `npm run test -- sender-auth` → FAIL。

**Step 3: 实现**
```ts
const CQU_IP_PREFIX = "202.202.0.";  // 202.202.0.0/24（smtp/pop3.cqu.edu.cn）

export function parseInboundAuth(authResults: string, received: string) {
  const spf = authResults.match(/spf=(\w+)/)?.[1] ?? "none";
  const envelopeFrom = authResults.match(/smtp\.mailfrom=([^\s;]+)/)?.[1] ?? "";
  const sourceIp = received.match(/\[(\d{1,3}(?:\.\d{1,3}){3})\]/)?.[1] ?? "";
  return { spf, envelopeFrom, sourceIp };
}

export function senderVerified(
  auth: { spf: string; envelopeFrom: string; sourceIp: string },
  bind: { kind: string; senderWhitelist: string[] }
): boolean {
  const officialOk =
    auth.spf === "pass" &&
    bind.senderWhitelist.includes(auth.envelopeFrom) &&
    auth.sourceIp.startsWith(CQU_IP_PREFIX);
  if (officialOk) return true;
  // forward 模式：额外接受用户登记的转发地址（信任较弱）
  if (bind.kind === "forward" && bind.senderWhitelist.includes(auth.envelopeFrom) && auth.spf === "pass") return true;
  return false;
}
```

**Step 4: 确认通过** — `npm run test -- sender-auth` → PASS。

**Step 5: Commit** — `git commit -m "feat(2fa): SPF+envelope+IP sender verification (cqu.edu.cn has no DMARC)"`

### Task 2.5: `nextStatus(current, event)` — 6 态状态机

**Files:** Create `src/services/cqu-2fa/state-machine.ts` + `state-machine.test.ts`

**Step 1: 失败测试**
```ts
import { describe, it, expect } from "vitest";
import { nextStatus, type CquStatus } from "./state-machine";

describe("nextStatus", () => {
  it("binding -> active on confirm+first login", () => {
    expect(nextStatus("binding", "FIRST_LOGIN_OK")).toBe("active");
  });
  it("active -> relogging on relogin trigger", () => {
    expect(nextStatus("active", "RELOGIN_START")).toBe("relogging");
  });
  it("relogging -> active on success", () => {
    expect(nextStatus("relogging", "RELOGIN_OK")).toBe("active");
  });
  it("relogging -> expired on failure", () => {
    expect(nextStatus("relogging", "RELOGIN_FAIL")).toBe("expired");
  });
  it("expired -> relogging on retry", () => {
    expect(nextStatus("expired", "RELOGIN_START")).toBe("relogging");
  });
  it("any -> revoked on revoke", () => {
    expect(nextStatus("active", "REVOKE")).toBe("revoked");
    expect(nextStatus("expired", "REVOKE")).toBe("revoked");
  });
  it("illegal transition keeps current", () => {
    expect(nextStatus("revoked", "RELOGIN_OK")).toBe("revoked");
  });
});
```

**Step 2: 确认失败** — `npm run test -- state-machine` → FAIL。

**Step 3: 实现**
```ts
export type CquStatus = "unbound" | "binding" | "active" | "relogging" | "expired" | "revoked";
export type CquEvent =
  | "START_BIND" | "FIRST_LOGIN_OK" | "RELOGIN_START" | "RELOGIN_OK" | "RELOGIN_FAIL" | "REVOKE" | "UNBIND";

const TABLE: Record<CquStatus, Partial<Record<CquEvent, CquStatus>>> = {
  unbound:   { START_BIND: "binding" },
  binding:   { FIRST_LOGIN_OK: "active", REVOKE: "revoked", UNBIND: "unbound" },
  active:    { RELOGIN_START: "relogging", REVOKE: "revoked", UNBIND: "unbound" },
  relogging: { RELOGIN_OK: "active", RELOGIN_FAIL: "expired", REVOKE: "revoked" },
  expired:   { RELOGIN_START: "relogging", REVOKE: "revoked", UNBIND: "unbound" },
  revoked:   { UNBIND: "unbound" },
};

export function nextStatus(current: CquStatus, event: CquEvent): CquStatus {
  return TABLE[current]?.[event] ?? current;
}
```

**Step 4: 确认通过** — `npm run test -- state-machine` → PASS。

**Step 5: Commit** — `git commit -m "feat(2fa): 6-state session state machine"`

### Task 2.6: `shouldStartLogin(loginInFlight, now)` — single-flight 锁判定

**Files:** Create `src/services/cqu-2fa/single-flight.ts` + `single-flight.test.ts`

**Step 1: 失败测试**
```ts
import { describe, it, expect } from "vitest";
import { shouldStartLogin, LOGIN_LOCK_TTL_MS } from "./single-flight";

describe("shouldStartLogin", () => {
  const now = 1_000_000;
  it("starts when no lock", () => {
    expect(shouldStartLogin(null, now)).toBe(true);
  });
  it("blocks when fresh lock in flight", () => {
    expect(shouldStartLogin({ token: "x", startedAt: now - 1000 }, now)).toBe(false);
  });
  it("starts when stale lock (> TTL, crashed login)", () => {
    expect(shouldStartLogin({ token: "x", startedAt: now - LOGIN_LOCK_TTL_MS - 1 }, now)).toBe(true);
  });
});
```

**Step 2: 确认失败** — `npm run test -- single-flight` → FAIL。

**Step 3: 实现**
```ts
export const LOGIN_LOCK_TTL_MS = 3 * 60 * 1000; // 3min：超时视为崩溃，允许重抢

export function shouldStartLogin(
  lock: { token: string; startedAt: number } | null,
  now: number
): boolean {
  if (!lock) return true;
  return now - lock.startedAt > LOGIN_LOCK_TTL_MS;
}
```

**Step 4: 确认通过** — `npm run test -- single-flight` → PASS。

**Step 5: Commit** — `git commit -m "feat(2fa): single-flight relogin lock predicate"`

### Task 2.7: 全量回归

Run: `npm run test` → 全 PASS；`npm run typecheck` → 无错。
```bash
git commit --allow-empty -m "test(2fa): pure-logic units green"
```

---

## Phase 3 — Email Worker（入站管道接线 + 本地集成）

### Task 3.1: 安装 postal-mime + 加 `email()` handler

**Files:**
- Modify: `package.json`（dep: `postal-mime`）
- Create: `src/email-handler.ts`
- Modify: `src/index.ts`（导出 `email`）、`src/types.ts`（绑定类型）

**Step 1:** `npm install postal-mime`

**Step 2: 写 handler**（用 Phase 2 纯函数 + D1）
```ts
// src/email-handler.ts
import PostalMime from "postal-mime";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { cquBindAddresses } from "./db/schema";
import { localPart } from "./services/cqu-2fa/address";
import { extractCode } from "./services/cqu-2fa/extract-code";
import { parseInboundAuth, senderVerified } from "./services/cqu-2fa/sender-auth";
import type { Env } from "./types";

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const token = localPart(message.to);
  const db = drizzle(env.DATABASE);
  const bind = await db.select().from(cquBindAddresses).where(eq(cquBindAddresses.token, token)).get();
  if (!bind || bind.status === "revoked") return message.setReject("unknown recipient");

  const auth = parseInboundAuth(
    message.headers.get("authentication-results") ?? "",
    message.headers.get("received") ?? ""
  );
  const whitelist = JSON.parse(bind.senderWhitelist) as string[];
  if (!senderVerified(auth, { kind: bind.kind, senderWhitelist: whitelist })) {
    return message.setReject("sender not verified");
  }

  const email = await PostalMime.parse(message.raw);
  const hit = extractCode(email.subject ?? "", email.text ?? email.html ?? "");
  if (!hit) return; // 非验证码邮件，静默 drop

  await env.CQU_SESSION.getByName(bind.userId).fetch("https://do/deposit-code", {
    method: "POST",
    body: JSON.stringify({ ...hit, sender: message.from, ts: Date.now() }),
  });
}
```

**Step 3: 在 `src/index.ts` 导出**
```ts
import { handleEmail } from "./email-handler";
// 现有 export default 改为同时含 fetch + email：
export default {
  fetch: app.fetch,
  async email(message, env, ctx) { await handleEmail(message, env); },
};
```
> 注意保持现有 `app.all("*")` catch-all 不动；只是把 `export default app` 换成显式对象。typecheck 确认 `fetch` 签名兼容。

**Step 4: typecheck** — `npm run typecheck` → 无错。

**Step 5: 本地集成验证**（不可单测，用 wrangler dev 的 email 端点）
- Run: `npm run dev`
- 先手动往 D1 插一条测试绑定：`npx wrangler d1 execute auth-cqu-moe-db --local --command "INSERT INTO cqu_bind_addresses (token,user_id,kind,sender_whitelist,status) VALUES ('testtok','test-user','direct','[\"sso@cqu.edu.cn\"]','active')"`
- 用 `密保邮箱绑定验证码.eml` 的内容 POST 到本地 email 端点：
  ```bash
  curl -X POST 'http://localhost:8787/cdn-cgi/handler/email' \
    --url-query 'from=sso@cqu.edu.cn' --url-query 'to=testtok@bind.cqu.moe' \
    --header 'Content-Type: application/json' --data-binary @/Users/uu/Downloads/密保邮箱绑定验证码.eml
  ```
- Expected: handler 解析出 `{code:"943754", kind:"bind_confirm"}` 并尝试 `CQU_SESSION.deposit-code`（DO 此时可能未实现 deposit-code → 看日志确认提码正确即可）。
> ⚠️ 本地 `authentication-results` 头由你 curl 提供，CF 真实头格式以 Phase 0 Task 0.2 为准；senderVerified 在本地可能因头不同而需放宽——记得上线前用真实 CF 头回归。

**Step 6: Commit**
```bash
git add package.json package-lock.json src/email-handler.ts src/index.ts src/types.ts
git commit -m "feat(email): inbound email() handler — verify sender, extract code, deposit to DO"
```

---

## Phase 4 — CF Containers 浏览器登录器

> 复用 `cqu-api-endpoint-collection/systems/auth/cqu_login.py`。把它的 `--code-file` 轮询改成 aiohttp `/code` 事件推入。集成验证需**真实 CQU 账号**，无法单测。参考 @cloudflare:wrangler 的 containers 配置。

### Task 4.1: 容器骨架（aiohttp 包 run()）

**Files:**
- Create: `container/Dockerfile`、`container/server.py`、`container/cqu_login.py`（从仓库拷贝并改造）、`container/requirements.txt`

**Step 1: 拷贝并改造 `cqu_login.py`**
- 从 `../cqu-api-endpoint-collection/systems/auth/cqu_login.py` 拷入 `container/cqu_login.py`。
- 把 `read_code()` 的文件轮询替换为「`await asyncio.Event`」：新增模块级 `CODE_EVENTS: dict[str, tuple[asyncio.Event, dict]]`，`run()` 发码后 `await events[session].wait()` 取 `code`。

**Step 2: `container/server.py`（aiohttp）**
```python
import asyncio, json
from aiohttp import web
import cqu_login  # 改造后的登录器

CODE_EVENTS: dict[str, asyncio.Event] = {}
CODE_VALUES: dict[str, str] = {}

async def run_handler(request):
    body = await request.json()
    session = body.get("session") or "default"
    ev = asyncio.Event(); CODE_EVENTS[session] = ev
    async def code_waiter():
        await ev.wait(); return CODE_VALUES.pop(session, "")
    try:
        result = await cqu_login.run_login(
            student_id=body["studentId"], password=body["password"],
            service=body["service"], method=body.get("method", "mail"),
            code_provider=code_waiter,            # run_login 在发码后 await 它
        )
        return web.json_response({"ok": True, **result})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)
    finally:
        CODE_EVENTS.pop(session, None)

async def code_handler(request):
    body = await request.json()
    session = body.get("session") or "default"
    CODE_VALUES[session] = body["code"]
    if session in CODE_EVENTS: CODE_EVENTS[session].set()
    return web.json_response({"ok": True})

app = web.Application()
app.add_routes([web.post("/run", run_handler), web.post("/code", code_handler)])
if __name__ == "__main__":
    web.run_app(app, host="0.0.0.0", port=8080)
```
> `cqu_login.py` 需重构出 `async def run_login(student_id, password, service, method, code_provider) -> dict`，返回 `{"cookies": {...}, "ticket": "ST-..."}`（从 `storage_state` 抽 `SOURCEID_TGC/SESSION/rg_objectid`）。保留 form-nav 提交、发码点击、ticket 抓取逻辑不变。

**Step 3: `container/Dockerfile`**
```dockerfile
FROM --platform=linux/amd64 python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget gnupg ca-certificates fonts-liberation libnss3 libatk-bridge2.0-0 \
    libgtk-3-0 libgbm1 libasound2 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && patchright install --with-deps chromium
COPY server.py cqu_login.py .
EXPOSE 8080
CMD ["python", "server.py"]
```
`requirements.txt`: `patchright`、`aiohttp`、`pycryptodome`。

**Step 4: 本地构建 + e2e（真实账号）**
- `docker build -t cqu-login container/`
- `docker run --rm -p 8080:8080 --memory=1g cqu-login`（1g 验证 basic 可行性，呼应 Task 0.3）
- `curl -X POST localhost:8080/run -d '{"studentId":"<真实>","password":"<真实>","service":"https://my.cqu.edu.cn/authserver/authentication/cas","method":"mail","session":"t1"}'`（阻塞）
- 收到真实 2FA 邮件后，另一终端：`curl -X POST localhost:8080/code -d '{"session":"t1","code":"<6位>"}'`
- Expected: `/run` 返回 `{ok:true, cookies:{SOURCEID_TGC:...}, ticket:"ST-..."}`。
- **验证**：basic 1g 不 OOM、全链路到真实 ST。记录结论。

**Step 5: Commit**
```bash
git add container/
git commit -m "feat(container): patchright login driver (aiohttp /run + /code event push)"
```

### Task 4.2: wrangler 接入 Container

**Files:** Modify `wrangler.jsonc`、`src/index.ts`（导出 `CquLoginContainer` 类）、新建 `src/durable-objects/cqu-login-container.ts`

**Step 1:** `src/durable-objects/cqu-login-container.ts`
```ts
import { Container } from "@cloudflare/containers";
import type { Env } from "../types";
export class CquLoginContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "20s";
}
```
**Step 2:** `wrangler.jsonc` 增量（containers + DO 绑定 + migration v2，见设计 §5.3）。`npm install @cloudflare/containers`。
**Step 3:** typecheck。
**Step 4: Commit** — `git commit -m "feat(container): wire CquLoginContainer DO + wrangler config"`

---

## Phase 5 — DO 改造（状态机 + single-flight + 主动重登 + deposit-code）

> 集成性强，难单测；逻辑骨架已由 Phase 2 纯函数覆盖。每步后 `npm run typecheck`，用 `wrangler dev` 手动验证。

### Task 5.1: 退役纯 fetch 登录、保留取 ST
- Modify `src/services/cqu-sso.ts`：删 `login()`（或标 `@deprecated` 抛错）；保留 `getServiceTicket()`/`checkOnline()`/cookie 工具。
- typecheck → commit `refactor(cqu-sso): retire dead pure-fetch password login; keep getServiceTicket`

### Task 5.2: DO 接 Container 重登 + single-flight
- Modify `src/durable-objects/cqu-session.ts`：
  - `SessionState` 加 `loginAt`；新增 storage 键 `loginInFlight`、`pendingCode`、`status`（6 态，用 `nextStatus`）。
  - `relogin()` 改为：`shouldStartLogin` 判定 → 置 `loginInFlight`（`nextStatus(...,'RELOGIN_START')`）→ 解密密码 → `env.CQU_LOGIN.getByName(userId).fetch('/run',...)` → 成功写 cookies+`loginAt`、`RELOGIN_OK`、清锁；失败 `RELOGIN_FAIL`。
  - `init()` 走同一条 Container 路径（首登 `FIRST_LOGIN_OK`）。
- typecheck → commit `feat(do): container-driven relogin with single-flight lock + state machine`

### Task 5.3: deposit-code action + 主动 +7h 重登
- Modify `src/durable-objects/cqu-session.ts`：
  - 新增 `deposit-code` action：按 `kind` 分流——`login_2fa` → `env.CQU_LOGIN.getByName(userId).fetch('/code',{code,session})` 推容器；`bind_confirm` → 经 WS 推浏览器（Phase 6）+ 暂存 `pendingCode`。
  - `alarm()`：保活探针保留；新增 `now - loginAt >= 7h` → 触发 `relogin()`（主动）；探针失效也触发。
- 用 `wrangler dev` 模拟：手动 deposit-code → 看是否推到容器。
- commit `feat(do): deposit-code routing + proactive 7h relogin`

---

## Phase 6 — WS 下发 + 绑定 onboarding

### Task 6.1: DO Hibernatable WebSocket（绑定码秒推浏览器）
- Modify `src/durable-objects/cqu-session.ts`：加 `fetch` 内 `Upgrade: websocket` 分支 → `this.ctx.acceptWebSocket(server)`；`deposit-code` 的 `bind_confirm` 分支 → `this.ctx.getWebSockets().forEach(ws => ws.send(JSON.stringify({type:'bind_code', code})))`。
- 参考 @cloudflare:durable-objects 的 WebSocket Hibernation API。
- commit `feat(do): hibernatable WS to push bind confirmation code to browser`

### Task 6.2: 绑定 onboarding 路由 + 前端页
- Create `src/routes/cqu-bind.ts`：`POST /api/cqu/bind-address`（签发 `<token>@bind.cqu.moe`，D1 写 pending）、`GET /api/cqu/bind-status`、WS 升级端点 `/api/cqu/bind-ws`。
- 前端 `frontend/src/` 加绑定页：显示专属地址 + 引导文案（去 CQU 设密保邮箱）+ WS 连接显示收到的确认码。
- 手动 e2e：真实账号走完 §设计 §9 五步。
- commit `feat(bind): onboarding flow + WS bind-code UI`

---

## Phase 7 — 端到端无人值守闭环 + 加固

### Task 7.1: 全链路联调（真实账号）
- 绑定 → 首登 → 等 ~7h（或临时把阈值调小到 5min 验证）→ 观察自动重登：容器点火 → 发码 → 邮件到达 → DO 推码 → 提交 → 新 TGT → 状态回 active、零停机取 ST。
- 验证 single-flight：并发触发两次重登，确认只点火一个容器。

### Task 7.2: 审计 + 限频 + 告警
- 每次登录尝试 / 收码（发件人+时刻）/ 发 ST 记 `console`（CF Observability 可查）。
- 重登频率上限、发码上限（防滥用/防瑞数限频）。
- 提码失败 / 重登连续失败 → 状态 `expired` + 告警日志。
- commit `feat: audit logging, rate limits, failure alerts`

### Task 7.3: 文档同步 + CLAUDE.md 更新
- 更新 `CLAUDE.md`（新认证体系、Container、Email 管道、状态机、勿在 cqu.moe 顶级开 catch-all 等 gotcha）。
- 更新设计文档 §12 待验证项为已验证。
- commit `docs: sync CLAUDE.md + design doc with 2FA rebind implementation`

---

## 验收标准
- [ ] 绑定流程：用户能在自己浏览器把密保邮箱设为专属地址，确认码经 WS 秒显并完成绑定。
- [ ] 无人值守：会话每 ~7h 自动重铸 TGT，用户零操作；重登窗口零停机。
- [ ] 热路径：任意时刻能纯 fetch 取 ST → 调 jwxt 拿到实时课表。
- [ ] 安全：伪造 From 的 SPF-fail 邮件被拒；非验证码邮件静默 drop；零出站。
- [ ] 成本：basic/standard-1 实例选定，符合 §11 模型。
- [ ] `npm run test` 全绿、`npm run typecheck` 无错。
