import PostalMime from "postal-mime";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { cquBindAddresses } from "./db/schema";
import { localPart } from "./services/cqu-2fa/address";
import { extractCode } from "./services/cqu-2fa/extract-code";
import { parseInboundAuth, senderVerified } from "./services/cqu-2fa/sender-auth";
import type { Env } from "./types";

const MAX_RAW_SIZE = 25 * 1024 * 1024; // 25 MiB 上限，超过即拒，避免 PostalMime 解析大邮件

// Cloudflare 入站邮件管道：解析收件地址 → D1 查绑定 → 校验发件人 → 提码 → 投递到用户 DO。
//
// 安全顺序至关重要（先校验、后解析正文）：
//   1. token → bind（D1），缺失/已撤销立即 setReject
//   2. 必须含 CF 盖的 ARC-Authentication-Results（authserv-id=mx.cloudflare.net）
//   3. parseInboundAuth + senderVerified（Phase 2 纯函数），不过即 setReject
//   4. rawSize 上限校验
//   5. 以上全过后，才 PostalMime.parse + extractCode
//
// senderVerified 必须在 extractCode 之前运行：提码器信任正文来自 CQU，
// 只有确认发件人是 CQU 官方（SPF=pass + envelope 白名单 + 源 IP∈202.202.0.0/24）后，
// 才允许把正文里的 6 位数字当作可信验证码提取。
//
// 零出站：永不调用 message.forward() / message.reply()。
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  const token = localPart(message.to);
  const db = drizzle(env.DATABASE);
  const bind = await db
    .select()
    .from(cquBindAddresses)
    .where(eq(cquBindAddresses.token, token))
    .get();
  if (!bind || bind.status === "revoked") {
    return message.setReject("unknown recipient");
  }

  const arc = message.headers.get("arc-authentication-results") ?? "";
  if (!arc.includes("mx.cloudflare.net")) {
    return message.setReject("missing CF auth header");
  }
  const auth = parseInboundAuth(arc); // 只信 CF 盖的 ARC-Authentication-Results

  if (message.rawSize > MAX_RAW_SIZE) {
    return message.setReject("too large");
  }

  const whitelist = JSON.parse(bind.senderWhitelist) as string[];
  if (!senderVerified(auth, { kind: bind.kind, senderWhitelist: whitelist })) {
    return message.setReject("sender not verified");
  }

  // 发件人已确认为 CQU 官方后，才解析正文并提码（extractCode 信任正文来源）。
  const email = await PostalMime.parse(message.raw);
  const hit = extractCode(email.subject ?? "", email.text ?? email.html ?? "");
  if (!hit) return; // 非验证码邮件，静默 drop（不出站、不回弹）

  // 投递到用户的 Durable Object —— 复用 src/routes/cqu.ts 的寻址约定：
  // idFromName(userId) → get(id) → fetch(new Request(...))。
  // deposit-code action 由 Phase 5 实现，此处先接线（当前运行时可能 404）。
  const doId = env.CQU_SESSION.idFromName(bind.userId);
  const stub = env.CQU_SESSION.get(doId);
  await stub.fetch(
    new Request("https://do/deposit-code", {
      method: "POST",
      body: JSON.stringify({ ...hit, sender: message.from, ts: Date.now() }),
    })
  );
}
