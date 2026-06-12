import PostalMime from "postal-mime";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { cquBindAddresses } from "./db/schema";
import { localPart } from "./services/cqu-2fa/address";
import { extractCode } from "./services/cqu-2fa/extract-code";
import { parseInboundAuth, senderVerified, trustedCfArc } from "./services/cqu-2fa/sender-auth";
import type { Env } from "./types";

const MAX_RAW_SIZE = 25 * 1024 * 1024; // 25 MiB 上限，超过即拒，避免 PostalMime 解析大邮件

// Cloudflare 入站邮件管道：解析收件地址 → D1 查绑定 → 校验发件人 → 提码 → 投递到用户 DO。
//
// 安全顺序至关重要（先校验、后解析正文）：
//   1. token → bind（D1），缺失/非 active 立即 setReject（pending/revoked 都不收码）
//   2. ARC-Authentication-Results 必须由 CF 盖章：trustedCfArc() 把信任锚定在 authserv-id
//      （mx.cloudflare.net）上——只取 CF 自己那一条 ARC 实例，丢弃攻击者自带/追加的伪造段；
//      不是 CF 盖的（或被伪造段顶到最前）即 setReject。
//   3. parseInboundAuth(cfArc) + senderVerified（Phase 2 纯函数），不过即 setReject
//   4. rawSize 上限校验
//   5. 以上全过后，才 PostalMime.parse + extractCode
//
// senderVerified 必须在 extractCode 之前运行：提码器信任正文来自 CQU，
// 只有确认发件人是 CQU 官方（SPF=pass + envelope 白名单 + 源 IP∈202.202.0.0/24）后，
// 才允许把正文里的 6 位数字当作可信验证码提取。
//
// 可观测性约定：spoof/未知收件人/非验证码邮件的拒绝是「预期内」的，保持静默（不打 error log）。
// 只有当一封*发件人已通过校验*的可信邮件因基础设施故障（D1 查询、解析、DO 投递抛错）丢失时，
// 才 console.error 出足够上下文，便于排查「合法验证码丢了」。
//
// 零出站：永不调用 message.forward() / message.reply()。
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  // 校验前的 D1 查询：基础设施故障不应静默吞掉（此时还无法判定发件人，但查询失败本身值得记录）。
  let bind: typeof cquBindAddresses.$inferSelect | undefined;
  try {
    const db = drizzle(env.DATABASE);
    bind = await db
      .select()
      .from(cquBindAddresses)
      .where(eq(cquBindAddresses.token, localPart(message.to)))
      .get();
  } catch (err) {
    console.error("[email] D1 lookup failed", { to: message.to, err });
    return message.setReject("temporary lookup failure");
  }
  // C2: 仅 active 绑定收码。pending（未验证激活）/ revoked（已撤销）一律拒。
  if (!bind || bind.status !== "active") {
    return message.setReject("inactive binding");
  }

  // C1: 信任锚定在 authserv-id 上，只解析 CF 自己盖的那条 ARC 段。
  const rawHeader = message.headers.get("arc-authentication-results") ?? "";
  const cfArc = trustedCfArc(rawHeader);
  if (!cfArc) return message.setReject("untrusted auth header");
  const auth = parseInboundAuth(cfArc);

  if (message.rawSize > MAX_RAW_SIZE) {
    return message.setReject("too large");
  }

  // I1: 解析 senderWhitelist（JSON 字符串数组）不得把异常抛出 handler。
  let whitelist: string[];
  try {
    const parsed = JSON.parse(bind.senderWhitelist);
    if (!Array.isArray(parsed)) {
      console.error("[email] senderWhitelist is not an array", { token: bind.token });
      return message.setReject("invalid binding");
    }
    whitelist = parsed;
  } catch (err) {
    console.error("[email] senderWhitelist JSON parse failed", { token: bind.token, err });
    return message.setReject("invalid binding");
  }

  if (!senderVerified(auth, { kind: bind.kind, senderWhitelist: whitelist })) {
    // 预期内拒绝（spoof / 发件人未通过校验）——保持静默。
    return message.setReject("sender not verified");
  }

  // —— 自此以下，发件人已确认为可信 CQU 来源 ——
  // 之后任何基础设施故障都可能导致「合法验证码丢失」，必须 console.error 留痕，不得静默吞。

  // 发件人已确认为 CQU 官方后，才解析正文并提码（extractCode 信任正文来源）。
  let email: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    email = await PostalMime.parse(message.raw);
  } catch (err) {
    console.error("[email] PostalMime.parse failed on verified sender", {
      token: bind.token,
      from: message.from,
      err,
    });
    return message.setReject("parse failure");
  }

  const hit = extractCode(email.subject ?? "", email.text ?? email.html ?? "");
  if (!hit) return; // 非验证码邮件，静默 drop（不出站、不回弹）

  // 投递到用户的 Durable Object —— 复用 src/routes/cqu.ts 的寻址约定：
  // idFromName(userId) → get(id) → fetch(new Request(...))。
  // deposit-code action 由 Phase 5 实现，此处先接线（当前运行时可能 404）。
  try {
    const doId = env.CQU_SESSION.idFromName(bind.userId);
    const stub = env.CQU_SESSION.get(doId);
    const res = await stub.fetch(
      new Request("https://do/deposit-code", {
        method: "POST",
        body: JSON.stringify({ ...hit, sender: message.from, ts: Date.now() }),
      })
    );
    // M1: 检查投递结果。Phase 5 前 deposit-code 还没实现，已知会 404——记录但不崩溃。
    if (!res.ok) {
      // TODO Phase 5: deposit-code action 落地后，此处 404 应消失；届时校验 res.ok 并据此处理。
      console.error("[email] DO deposit-code returned non-ok", {
        token: bind.token,
        userId: bind.userId,
        status: res.status,
      });
    }
  } catch (err) {
    console.error("[email] DO deposit-code threw on verified sender", {
      token: bind.token,
      userId: bind.userId,
      err,
    });
    // 投递抛错也不抛出 handler（避免给上游退信/触发重投制造可观测的副作用）。
  }
}
