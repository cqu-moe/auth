# Two-Factor Authentication and Double-OTP Email Change Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in Better Auth 2FA (TOTP, email OTP fallback, backup codes, trusted devices), reserve Passkey as a future method, and replace the link-based email-change flow with current-email OTP followed by new-email OTP.

**Architecture:** Better Auth remains the sole owner of 2FA challenges, OTP verification records, session promotion, and the final email update. The Worker configures the `twoFactor` and `emailOTP` plugins, persists only Better Auth's documented schema, and uses the existing Resend integration for code delivery. React owns only explicit UI state machines; no OTP, TOTP secret, or backup code is persisted in browser storage. Existing `user.id` rows and foreign-key identity remain unchanged when email changes.

**Tech Stack:** TypeScript, Better Auth 1.6.11, Better Auth Cloudflare adapter, Cloudflare D1/KV/Workers, Resend, React 19, React Router 7, Tailwind CSS 4, Vitest 4, `qrcode`.

**Spec:** `docs/superpowers/specs/2026-09-05-two-factor-authentication-design.md`

## Global Constraints

- Follow red-green-refactor for every behavior change: add one failing test, run it and observe the expected failure, implement the minimum code, then rerun the focused test.
- Keep the existing settings-page layout. Add one compact “二次验证” summary card; put enrollment and management on `/settings/two-factor`.
- Keep nickname editing exactly where it is. Replace only the contents of the independent `/settings/email` page.
- Use Better Auth's native `/two-factor/*` and `/email-otp/*` endpoints. Do not create a parallel challenge table or custom email-update endpoint.
- Passkey is a compile-time reservation only. Do not install the Passkey plugin, create Passkey tables, or show Passkey controls.
- Generate QR images locally in the browser. Do not send `totpURI` to a third-party QR service.
- Never put OTPs, TOTP secrets, or backup codes in URLs, logs, localStorage, or sessionStorage.
- Each commit must include only the files listed by its task plus directly generated lockfile changes.

---

## Task 1: Add Better Auth 2FA persistence

**Files:**

- Create: `src/db/schema.two-factor.test.ts`
- Modify: `src/db/schema.ts`
- Create: `drizzle/migrations/0006_two_factor.sql`

**Interfaces:**

```ts
export const user = sqliteTable("user", {
  twoFactorEnabled: integer("twoFactorEnabled", { mode: "boolean" }),
});

export const twoFactor = sqliteTable("twoFactor", {
  id: text("id"),
  secret: text("secret"),
  backupCodes: text("backupCodes"),
  userId: text("userId"),
  verified: integer("verified", { mode: "boolean" }),
});
```

- [ ] **Step 1: Write the failing schema test**

```ts
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { twoFactor, user } from "./schema";

describe("Better Auth two-factor schema", () => {
  it("defines the user flag and the twoFactor table", () => {
    expect(getTableColumns(user).twoFactorEnabled).toBeDefined();
    expect(Object.keys(getTableColumns(twoFactor))).toEqual([
      "id",
      "secret",
      "backupCodes",
      "userId",
      "verified",
    ]);
  });

  it("migrates existing users as not enrolled", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY NOT NULL);
      INSERT INTO user (id) VALUES ('existing-user');
    `);
    database.exec(
      readFileSync(
        new URL("../../drizzle/migrations/0006_two_factor.sql", import.meta.url),
        "utf8"
      )
    );

    expect(
      database.prepare("SELECT twoFactorEnabled FROM user WHERE id = ?")
        .get("existing-user")
    ).toEqual({ twoFactorEnabled: 0 });
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'twoFactor'")
        .get()
    ).toEqual({ name: "twoFactor" });
    database.close();
  });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails because the schema fields are absent**

Run: `npx vitest run src/db/schema.two-factor.test.ts`

Expected: FAIL with a missing `twoFactor` export or missing `twoFactorEnabled` column.

- [ ] **Step 3: Add the Drizzle schema**

Add `index` to the existing import and add the Better Auth fields exactly as named:

```ts
import { sqliteTable, text, integer, primaryKey, index } from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
  // existing columns remain unchanged
  twoFactorEnabled: integer("twoFactorEnabled", { mode: "boolean" })
    .notNull()
    .default(false),
});

export const twoFactor = sqliteTable(
  "twoFactor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backupCodes").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: integer("verified", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    index("twoFactor_secret_idx").on(table.secret),
    index("twoFactor_userId_idx").on(table.userId),
  ]
);
```

- [ ] **Step 4: Add the D1 migration**

```sql
ALTER TABLE `user`
  ADD COLUMN `twoFactorEnabled` INTEGER NOT NULL DEFAULT 0;

CREATE TABLE `twoFactor` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `secret` TEXT NOT NULL,
  `backupCodes` TEXT NOT NULL,
  `userId` TEXT NOT NULL,
  `verified` INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `twoFactor_secret_idx` ON `twoFactor` (`secret`);
CREATE INDEX `twoFactor_userId_idx` ON `twoFactor` (`userId`);
```

- [ ] **Step 5: Run the schema test and typecheck**

Run: `npx vitest run src/db/schema.two-factor.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/schema.two-factor.test.ts drizzle/migrations/0006_two_factor.sql
git commit -m "feat(auth): add two-factor persistence"
```

---

## Task 2: Configure Better Auth 2FA, email OTP, mail delivery, and rate limits

**Files:**

- Create: `src/auth-two-factor.test.ts`
- Modify: `src/auth.ts`
- Modify: `src/types.ts` only if the existing `Env` type does not already expose the Resend and KV bindings used by the test fixture.

**Interfaces:**

```ts
twoFactor({
  issuer: "auth.cqu.moe",
  twoFactorCookieMaxAge: 600,
  trustDeviceMaxAge: 2_592_000,
  totpOptions: { digits: 6, period: 30 },
  otpOptions: { digits: 6, period: 5, allowedAttempts: 3, storeOTP: "hashed" },
  backupCodeOptions: { amount: 10, length: 10, storeBackupCodes: "encrypted" },
})

emailOTP({
  otpLength: 6,
  expiresIn: 300,
  allowedAttempts: 3,
  storeOTP: "hashed",
  resendStrategy: "rotate",
  disableSignUp: true,
  changeEmail: { enabled: true, verifyCurrentEmail: true },
})
```

- [ ] **Step 1: Add a reusable in-memory auth fixture and failing configuration test**

Move the repeated D1/KV/Resend fixture from `src/auth-profile.test.ts` only if doing so reduces duplication; otherwise keep this test self-contained. Assert plugin IDs and the absence of the old link flow:

```ts
it("enables Better Auth two-factor and native email-change OTP", () => {
  const { auth, database } = authForTest();
  const pluginIds = auth.options.plugins?.map((plugin) => plugin.id);

  expect(pluginIds).toContain("two-factor");
  expect(pluginIds).toContain("email-otp");
  expect(auth.options.user?.changeEmail).toBeUndefined();
  database.close();
});
```

- [ ] **Step 2: Run the test and observe the missing plugin failure**

Run: `npx vitest run src/auth-two-factor.test.ts`

Expected: FAIL because `two-factor` and `email-otp` are not configured and the old link flow is still enabled.

- [ ] **Step 3: Configure both plugins and remove the default link-based change-email block**

Update imports:

```ts
import { customSession, emailOTP, twoFactor } from "better-auth/plugins";
```

Add these plugins before `customSession`:

```ts
emailOTP({
  async sendVerificationOTP({ email, otp, type }) {
    const copy = type === "change-email"
      ? {
          subject: "验证新登录邮箱 - auth.cqu.moe",
          intro: "请输入以下验证码，完成登录邮箱更换。",
        }
      : {
          subject: "确认当前登录邮箱 - auth.cqu.moe",
          intro: "请输入以下验证码，确认是你本人在更换登录邮箱。",
        };

    await getResend().emails.send({
      from: "auth.cqu.moe <noreply@cqu.moe>",
      to: email,
      subject: copy.subject,
      html: `<p>${copy.intro}</p><p style="font-size:24px;font-weight:700;letter-spacing:6px">${otp}</p><p>验证码 5 分钟内有效，请勿转发。</p>`,
    });
  },
  otpLength: 6,
  expiresIn: 300,
  allowedAttempts: 3,
  storeOTP: "hashed",
  resendStrategy: "rotate",
  disableSignUp: true,
  changeEmail: { enabled: true, verifyCurrentEmail: true },
}),
twoFactor({
  issuer: "auth.cqu.moe",
  twoFactorCookieMaxAge: 600,
  trustDeviceMaxAge: 60 * 60 * 24 * 30,
  totpOptions: { digits: 6, period: 30 },
  otpOptions: {
    digits: 6,
    period: 5,
    allowedAttempts: 3,
    storeOTP: "hashed",
    async sendOTP({ user, otp }) {
      await getResend().emails.send({
        from: "auth.cqu.moe <noreply@cqu.moe>",
        to: user.email,
        subject: "登录二次验证码 - auth.cqu.moe",
        html: `<p>请输入以下验证码完成登录：</p><p style="font-size:24px;font-weight:700;letter-spacing:6px">${otp}</p><p>验证码 5 分钟内有效，请勿转发。</p>`,
      });
    },
  },
  backupCodeOptions: {
    amount: 10,
    length: 10,
    storeBackupCodes: "encrypted",
  },
}),
```

Keep the existing `emailVerification` link flow for sign-up verification. Remove only `user.changeEmail` and its `/change-email` hook.

- [ ] **Step 4: Restrict the generic current-email OTP endpoints to the signed-in user's current address**

Add a before hook branch for `/email-otp/send-verification-otp` and `/email-otp/check-verification-otp`:

```ts
const currentEmailOtpPaths = new Set([
  "/email-otp/send-verification-otp",
  "/email-otp/check-verification-otp",
]);

// inside hooks.before
if (currentEmailOtpPaths.has(ctx.path)) {
  const session = await getSessionFromCtx(ctx);
  const body = ctx.body as { email?: string; type?: string } | undefined;
  const matchesCurrentEmail =
    session &&
    body?.type === "email-verification" &&
    body.email?.trim().toLowerCase() === session.user.email.toLowerCase();

  if (!matchesCurrentEmail) {
    throw new APIError("FORBIDDEN", {
      code: "CURRENT_EMAIL_OTP_ONLY",
      message: "只能向当前登录邮箱发送或校验验证码",
    });
  }
}
```

Extend the test with a signed-in request whose body names another email and assert HTTP 403 with no Resend call.

- [ ] **Step 5: Put sensitive paths on KV-backed path-specific rate limits**

Replace the current rate-limit object with:

```ts
rateLimit: {
  enabled: true,
  window: 60,
  max: 30,
  storage: "secondary-storage",
  customRules: {
    "/two-factor/send-otp": { window: 60, max: 3 },
    "/two-factor/verify-totp": { window: 60, max: 5 },
    "/two-factor/verify-otp": { window: 60, max: 5 },
    "/two-factor/verify-backup-code": { window: 60, max: 5 },
    "/email-otp/send-verification-otp": { window: 60, max: 3 },
    "/email-otp/check-verification-otp": { window: 60, max: 5 },
    "/email-otp/request-email-change": { window: 60, max: 5 },
    "/email-otp/change-email": { window: 60, max: 5 },
  },
},
```

- [ ] **Step 6: Add an enrollment and login integration test**

After migration and sign-up, verify the email link, enable 2FA with the password, derive the current TOTP through Better Auth's testable server endpoint, and verify it:

```ts
const enabled = await auth.api.enableTwoFactor({
  headers,
  body: { password: "password123" },
});
const secret = new URL(enabled.totpURI).searchParams.get("secret");
expect(secret).toBeTruthy();

const { code } = await auth.api.generateTOTP({ body: { secret: secret! } });
await auth.api.verifyTOTP({ headers, body: { code } });

expect(
  database.prepare('SELECT twoFactorEnabled FROM "user"').get()
).toMatchObject({ twoFactorEnabled: 1 });
```

Sign out, sign in again with `returnHeaders: true`, assert `twoFactorRedirect === true`, use the returned 2FA cookie to verify TOTP, then assert a normal session is created. Also send and verify one email 2FA OTP, and consume one backup code twice to prove the second attempt fails.

Use fake timers to prove a 5-minute email OTP expires, submit three wrong email OTPs to prove the stored challenge is invalidated, and issue one more request than each sensitive path's configured limit to assert HTTP 429. Keep these cases on separate fresh auth fixtures so one limit does not contaminate another assertion.

- [ ] **Step 7: Run focused tests and typecheck**

Run: `npx vitest run src/auth-two-factor.test.ts src/auth-profile.test.ts && npm run typecheck`

Expected: PASS after `src/auth-profile.test.ts` is reduced to nickname/user-ID invariants that do not depend on the removed link flow.

- [ ] **Step 8: Commit**

```bash
git add src/auth.ts src/auth-two-factor.test.ts src/auth-profile.test.ts src/types.ts
git commit -m "feat(auth): configure native two-factor authentication"
```

---

## Task 3: Add typed client methods and pure flow helpers

**Files:**

- Modify: `frontend/src/lib/auth-client.ts`
- Create: `frontend/src/lib/two-factor.ts`
- Create: `frontend/src/lib/two-factor.test.ts`
- Create: `frontend/src/lib/email-change-flow.ts`
- Create: `frontend/src/lib/email-change-flow.test.ts`

**Interfaces:**

```ts
export type SecondFactorMethod = "totp" | "email-otp" | "backup-code" | "passkey";
export const availableSecondFactorMethods: readonly Exclude<SecondFactorMethod, "passkey">[];
export type EmailChangeStep = "current-email" | "new-email" | "new-email-otp" | "complete";
export function normalizeOtp(value: string): string;
export function mapAuthError(code: string | undefined, fallback: string): string;
```

- [ ] **Step 1: Write failing helper tests**

```ts
describe("two-factor helpers", () => {
  it("reserves passkey without exposing it as an available method", () => {
    const future: SecondFactorMethod = "passkey";
    expect(future).toBe("passkey");
    expect(availableSecondFactorMethods).toEqual(["totp", "email-otp", "backup-code"]);
  });

  it("normalizes six-digit codes", () => {
    expect(normalizeOtp(" 12 34-56 ")).toBe("123456");
  });
});
```

For email steps, test legal transitions only:

```ts
expect(nextEmailChangeStep("current-email", "current-otp-verified")).toBe("new-email");
expect(nextEmailChangeStep("new-email", "new-otp-sent")).toBe("new-email-otp");
expect(nextEmailChangeStep("new-email-otp", "email-changed")).toBe("complete");
```

- [ ] **Step 2: Run both tests and observe missing-module failures**

Run: `npx vitest run frontend/src/lib/two-factor.test.ts frontend/src/lib/email-change-flow.test.ts`

Expected: FAIL because the helper modules do not exist.

- [ ] **Step 3: Implement the helpers**

```ts
export type SecondFactorMethod = "totp" | "email-otp" | "backup-code" | "passkey";

export const availableSecondFactorMethods = [
  "totp",
  "email-otp",
  "backup-code",
] as const satisfies readonly Exclude<SecondFactorMethod, "passkey">[];

export function normalizeOtp(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6);
}

export function mapAuthError(code: string | undefined, fallback: string): string {
  if (code === "INVALID_CODE" || code === "INVALID_OTP") return "验证码不正确";
  if (code === "OTP_HAS_EXPIRED" || code === "OTP_EXPIRED") return "验证码已过期，请重新获取";
  if (code === "TOO_MANY_ATTEMPTS" || code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE") {
    return "尝试次数过多，请重新获取验证码";
  }
  if (code === "INVALID_BACKUP_CODE") return "备用恢复码无效或已使用";
  return fallback;
}
```

Use a discriminated event union in `email-change-flow.ts`; throw on impossible transitions so components cannot silently skip either mailbox:

```ts
export type EmailChangeStep = "current-email" | "new-email" | "new-email-otp" | "complete";
export type EmailChangeEvent = "current-otp-verified" | "new-otp-sent" | "email-changed";

export function nextEmailChangeStep(
  step: EmailChangeStep,
  event: EmailChangeEvent
): EmailChangeStep {
  if (step === "current-email" && event === "current-otp-verified") return "new-email";
  if (step === "new-email" && event === "new-otp-sent") return "new-email-otp";
  if (step === "new-email-otp" && event === "email-changed") return "complete";
  throw new Error(`Invalid email change transition: ${step} -> ${event}`);
}
```

- [ ] **Step 4: Register Better Auth client plugins**

```ts
import { emailOTPClient, twoFactorClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [
    oauthProviderClient(),
    emailOTPClient(),
    twoFactorClient({ twoFactorPage: "/two-factor" }),
  ],
});
```

- [ ] **Step 5: Run focused tests and frontend build**

Run: `npx vitest run frontend/src/lib/two-factor.test.ts frontend/src/lib/email-change-flow.test.ts && npm --prefix frontend run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/auth-client.ts frontend/src/lib/two-factor.ts frontend/src/lib/two-factor.test.ts frontend/src/lib/email-change-flow.ts frontend/src/lib/email-change-flow.test.ts
git commit -m "feat(frontend): add two-factor flow primitives"
```

---

## Task 4: Build the login two-factor challenge page

**Files:**

- Create: `frontend/src/pages/TwoFactorChallenge.tsx`
- Create: `frontend/src/pages/TwoFactorChallenge.test.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/pages/Login.tsx` only if needed to preserve a post-login destination; the Better Auth client plugin owns the actual 2FA redirect.

**Interfaces:**

```ts
type LoginChallengeMethod = "totp" | "email-otp" | "backup-code";
```

- [ ] **Step 1: Write a failing static-render test**

Render the page under `MemoryRouter` and assert all required controls exist:

```ts
expect(html).toContain("二次验证");
expect(html).toContain("身份验证器");
expect(html).toContain("邮箱验证码");
expect(html).toContain("备用恢复码");
expect(html).toContain("在这台设备上保持信任 30 天");
expect(html).not.toContain("Passkey");
```

- [ ] **Step 2: Run the test and observe the missing-page failure**

Run: `npx vitest run frontend/src/pages/TwoFactorChallenge.test.tsx`

Expected: FAIL because the page does not exist.

- [ ] **Step 3: Implement the challenge UI**

The default tab is TOTP. Each submit uses only native client methods:

```ts
await authClient.twoFactor.verifyTotp({ code, trustDevice });
await authClient.twoFactor.sendOtp({ trustDevice });
await authClient.twoFactor.verifyOtp({ code, trustDevice });
await authClient.twoFactor.verifyBackupCode({ code, trustDevice });
```

On successful verification call `navigate("/settings", { replace: true })`. On `INVALID_TWO_FACTOR_COOKIE`, show “验证会话已过期，请重新登录” and link back to `/login`. Normalize six-digit inputs with `normalizeOtp`; do not normalize backup codes beyond trim.

Use a segmented method selector, a single-code input with `inputMode="numeric"` and `autoComplete="one-time-code"`, resend cooldown text, inline errors, loading state, and a checkbox for the 30-day trusted-device cookie. Do not render a Passkey option.

- [ ] **Step 4: Register the public route outside `ProtectedRoute`**

```tsx
<Route path="/two-factor" element={<TwoFactorChallenge />} />
```

It must remain inside `EmailVerificationGate`; the temporary 2FA cookie is not a full authenticated session, so wrapping this route in `ProtectedRoute` would create a redirect loop.

Prevent the existing password-login handler from navigating to `/verify-email` while the client plugin is redirecting to the challenge page:

```ts
if (data && "twoFactorRedirect" in data && data.twoFactorRedirect === true) {
  return;
}
navigate(getPostAuthDestination(data?.user.emailVerified === true), { replace: true });
```

- [ ] **Step 5: Run the component test and frontend build**

Run: `npx vitest run frontend/src/pages/TwoFactorChallenge.test.tsx && npm --prefix frontend run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/TwoFactorChallenge.tsx frontend/src/pages/TwoFactorChallenge.test.tsx frontend/src/App.tsx frontend/src/pages/Login.tsx
git commit -m "feat(frontend): add two-factor login challenge"
```

---

## Task 5: Build 2FA enrollment and management in settings

**Files:**

- Create: `frontend/src/components/TwoFactorSettingsSection.tsx`
- Create: `frontend/src/components/TwoFactorSettingsSection.test.tsx`
- Create: `frontend/src/pages/TwoFactorSettings.tsx`
- Create: `frontend/src/pages/TwoFactorSettings.test.tsx`
- Modify: `frontend/src/pages/Settings.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`

**Interfaces:**

```ts
type EnrollmentStep = "password" | "scan" | "backup-codes" | "complete";
interface EnrollmentSecret {
  totpURI: string;
  backupCodes: string[];
}
```

- [ ] **Step 1: Write failing summary-card and management-page render tests**

For the settings card, assert enabled/disabled status and the dedicated link:

```ts
expect(html).toContain("二次验证");
expect(html).toContain("尚未启用");
expect(html).toContain('href="/settings/two-factor"');
```

For the management page, assert the initial password gate, local QR target, manual-key fallback, and that backup codes are not initially rendered.

- [ ] **Step 2: Run tests and observe missing-component failures**

Run: `npx vitest run frontend/src/components/TwoFactorSettingsSection.test.tsx frontend/src/pages/TwoFactorSettings.test.tsx`

Expected: FAIL because the files do not exist.

- [ ] **Step 3: Install the local QR encoder**

Run: `npm --prefix frontend install qrcode && npm --prefix frontend install --save-dev @types/qrcode`

Expected: only `frontend/package.json` and `frontend/package-lock.json` change.

- [ ] **Step 4: Add the compact settings summary card**

`TwoFactorSettingsSection` accepts `enabled: boolean` and renders status plus a link to `/settings/two-factor`. Read `twoFactorEnabled` from `session.user` in `Settings.tsx` and place this card immediately after `AccountProfileSection`.

```tsx
<TwoFactorSettingsSection enabled={user?.twoFactorEnabled === true} />
```

- [ ] **Step 5: Implement enrollment**

The page uses this exact sequence:

```ts
const { data, error } = await authClient.twoFactor.enable({ password });
// keep data.totpURI and data.backupCodes only in React state

const qrDataUrl = await QRCode.toDataURL(data.totpURI, {
  errorCorrectionLevel: "M",
  margin: 1,
  width: 224,
});

await authClient.twoFactor.verifyTotp({ code });
await refetchSession();
```

Show the QR, the manual secret parsed from `new URL(totpURI).searchParams.get("secret")`, and a TOTP code input. Only after successful verification show all backup codes once, with “复制全部” and a required acknowledgement checkbox before the final button. Keep `backupCodes` in component state and clear them when leaving the page.

- [ ] **Step 6: Implement enabled-state management**

For an enabled account expose:

```ts
await authClient.twoFactor.generateBackupCodes({ password });
await authClient.twoFactor.disable({ password });
await refetchSession();
```

Regeneration requires password and warns that old codes immediately stop working. Disabling requires password, a confirmation panel, and no extra custom endpoint.

- [ ] **Step 7: Register the protected route**

```tsx
<Route
  path="/settings/two-factor"
  element={
    <ProtectedRoute>
      <TwoFactorSettings />
    </ProtectedRoute>
  }
/>
```

- [ ] **Step 8: Run focused tests, lint, and build**

Run: `npx vitest run frontend/src/components/TwoFactorSettingsSection.test.tsx frontend/src/pages/TwoFactorSettings.test.tsx && npm --prefix frontend run lint && npm --prefix frontend run build`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/TwoFactorSettingsSection.tsx frontend/src/components/TwoFactorSettingsSection.test.tsx frontend/src/pages/TwoFactorSettings.tsx frontend/src/pages/TwoFactorSettings.test.tsx frontend/src/pages/Settings.tsx frontend/src/App.tsx frontend/package.json frontend/package-lock.json
git commit -m "feat(frontend): add two-factor settings"
```

---

## Task 6: Replace link-based email change with current-email and new-email OTPs

**Files:**

- Create: `frontend/src/components/EmailChangeFlow.tsx`
- Create: `frontend/src/components/EmailChangeFlow.test.tsx`
- Modify: `frontend/src/components/AccountProfileSection.tsx`
- Modify: `frontend/src/components/AccountProfileSection.test.tsx`
- Modify: `frontend/src/pages/ChangeEmail.tsx`
- Modify: `src/auth-profile.test.ts`

**Interfaces:**

```ts
interface EmailChangeFlowProps {
  currentEmail: string;
  onSessionRefresh: () => Promise<unknown>;
}
```

- [ ] **Step 1: Replace the old render expectations with a failing three-stage flow test**

```ts
expect(html).toContain("验证当前邮箱");
expect(html).toContain("输入新邮箱");
expect(html).toContain("验证新邮箱");
expect(html).toContain("发送验证码");
expect(html).not.toContain("点击链接");
expect(html).not.toContain("确认邮件");
```

Keep the existing test proving the settings summary only contains the email pencil link.

- [ ] **Step 2: Run the test and observe failure against the current link copy**

Run: `npx vitest run frontend/src/components/EmailChangeFlow.test.tsx frontend/src/components/AccountProfileSection.test.tsx`

Expected: FAIL because the current section asks the user to click mailbox links.

- [ ] **Step 3: Extract and implement the OTP flow component**

Stage 1 sends to and checks the current session email:

```ts
await authClient.emailOtp.sendVerificationOtp({
  email: currentEmail,
  type: "email-verification",
});

await authClient.emailOtp.checkVerificationOtp({
  email: currentEmail,
  type: "email-verification",
  otp: currentOtp,
});
setStep(nextEmailChangeStep(step, "current-otp-verified"));
```

Stage 2 validates `newEmail` through the existing `validateNewEmail` helper, then atomically consumes the current OTP and sends the new-email OTP:

```ts
await authClient.emailOtp.requestEmailChange({
  newEmail: validatedEmail,
  otp: currentOtp,
});
setNewEmail(validatedEmail);
setStep(nextEmailChangeStep(step, "new-otp-sent"));
```

Stage 3 verifies the new mailbox and performs the actual Better Auth update:

```ts
await authClient.emailOtp.changeEmail({
  newEmail,
  otp: newEmailOtp,
});
await onSessionRefresh();
setCurrentOtp("");
setNewEmailOtp("");
setStep(nextEmailChangeStep(step, "email-changed"));
```

Each OTP input uses `inputMode="numeric"`, `autoComplete="one-time-code"`, six-digit normalization, a resend cooldown, and inline error mapping. Stage 2 keeps `currentOtp` only in React memory until `requestEmailChange` consumes it. Navigating away abandons the flow.

- [ ] **Step 4: Simplify the page and remove callback-query handling**

```tsx
export default function ChangeEmail() {
  const { data: session, refetch } = authClient.useSession();
  return (
    <Layout>
      <div className="max-w-2xl">
        <EmailChangeFlow
          currentEmail={session?.user.email ?? ""}
          onSessionRefresh={refetch}
        />
      </div>
    </Layout>
  );
}
```

Remove the exported `AccountEmailChangeSection` from `AccountProfileSection.tsx`; leave nickname editing and the email pencil link unchanged.

- [ ] **Step 5: Rewrite the server integration test around two OTPs**

Capture six-digit codes from the mocked Resend HTML:

```ts
function otpFromEmail(html: string): string {
  const otp = html.match(/>(\d{6})</)?.[1];
  if (!otp) throw new Error("email did not contain a six-digit OTP");
  return otp;
}
```

Test this exact sequence through the native server APIs:

```ts
await auth.api.sendVerificationOTP({
  headers,
  body: { email: "old@example.com", type: "email-verification" },
});
const currentOtp = otpFromEmail(sendEmail.mock.calls.at(-1)![0].html);

await auth.api.checkVerificationOTP({
  headers,
  body: { email: "old@example.com", type: "email-verification", otp: currentOtp },
});

await auth.api.requestEmailChangeEmailOTP({
  headers,
  body: { newEmail: "new@example.com", otp: currentOtp },
});
const newOtp = otpFromEmail(sendEmail.mock.calls.at(-1)![0].html);

expect(readUser()).toEqual({ id: originalUserId, email: "old@example.com" });

await auth.api.changeEmailEmailOTP({
  headers,
  body: { newEmail: "new@example.com", otp: newOtp },
});

expect(readUser()).toEqual({ id: originalUserId, email: "new@example.com" });
```

Add negative cases for wrong current OTP, trying to send a current-email OTP to another address, wrong new-email OTP, OTP reuse, a code issued to a different user, and a code issued for a different purpose. In every negative case assert the email and `user.id` are unchanged.

- [ ] **Step 6: Run focused backend and frontend tests**

Run: `npx vitest run src/auth-profile.test.ts frontend/src/lib/email-change-flow.test.ts frontend/src/components/EmailChangeFlow.test.tsx frontend/src/components/AccountProfileSection.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/EmailChangeFlow.tsx frontend/src/components/EmailChangeFlow.test.tsx frontend/src/components/AccountProfileSection.tsx frontend/src/components/AccountProfileSection.test.tsx frontend/src/pages/ChangeEmail.tsx src/auth-profile.test.ts
git commit -m "feat(auth): change email with two OTP checks"
```

---

## Task 7: Full verification and visual acceptance

**Files:**

- Modify only files needed to fix failures found by the checks below.

**Interfaces:** None; this task verifies the previously defined contracts.

- [ ] **Step 1: Apply migrations to the local D1 database**

Run: `npm run db:migrate:local`

Expected: migration `0006_two_factor.sql` applies successfully. If it was already applied, Wrangler reports no pending migrations.

- [ ] **Step 2: Run the complete test and typecheck matrix**

Run: `npm test`

Expected: all Worker and frontend Vitest tests PASS.

Run: `npm run typecheck && npm run typecheck:do`

Expected: both TypeScript checks PASS.

Run: `npm run test:do`

Expected: all Durable Object tests PASS; existing source-map or remote-login-node informational noise is acceptable only when the command exits 0.

- [ ] **Step 3: Run production-facing frontend checks**

Run: `npm --prefix frontend run lint && npm --prefix frontend run build`

Expected: lint and production build PASS.

- [ ] **Step 4: Exercise the user-visible paths in a fresh local process**

Run the existing local development command, then verify in the browser:

1. `/settings` keeps the original personal-information card and its two pencil icons.
2. The 2FA summary card links to `/settings/two-factor`.
3. Enrollment requires password, shows a locally generated QR/manual secret, rejects a bad code, accepts a valid TOTP, and displays backup codes once.
4. A new login redirects to `/two-factor`; TOTP, email OTP, and a single-use backup code work; trusted-device selection suppresses the next challenge on the same browser.
5. `/settings/email` sends the first OTP only to the current mailbox, does not reveal the new-email form until that code is checked, sends the second OTP to the new mailbox, and changes the email only after the second code succeeds.
6. Refreshing or navigating away from enrollment/email-change does not restore secrets or OTPs.
7. At a narrow viewport, method selectors, OTP inputs, backup codes, and action buttons do not overflow.

- [ ] **Step 5: Inspect the final diff and commit only verification fixes**

Run: `git status --short && git diff --check && git diff --stat`

Expected: no whitespace errors; only intended files are present. If verification required fixes, commit them as one focused follow-up such as:

```bash
git add <only-the-files-fixed-during-verification>
git commit -m "fix(auth): harden two-factor flows"
```

If no fixes were needed, do not create an empty commit.

---

## Completion Criteria

- Better Auth `twoFactor` and `emailOTP` are the only authorities for challenges and email mutation.
- TOTP enrollment is opt-in, password-gated, and incomplete until a valid TOTP is verified.
- Login supports TOTP, email OTP fallback, single-use backup codes, and optional 30-day trusted-device behavior.
- Passkey exists only in the `SecondFactorMethod` type and is absent from schema, plugin config, and UI.
- Email changes require a valid current-email OTP and a valid new-email OTP; no confirmation links remain in this flow.
- The email changes on the existing user row, so `user.id` and all user-ID foreign-key relationships remain unchanged.
- OTP storage is hashed, backup-code storage is encrypted, sensitive routes use KV-backed rate limiting, and secrets never enter URLs or browser storage.
- Full Worker tests, frontend tests, both typechecks, Durable Object tests, lint, production build, local migration, and browser acceptance all pass.
