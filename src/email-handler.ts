import PostalMime from "postal-mime";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { cquBindAddresses } from "./db/schema";
import { localPart } from "./services/cqu-2fa/address";
import { extractCode } from "./services/cqu-2fa/extract-code";
import { envelopeSenderAllowed } from "./services/cqu-2fa/sender-auth";
import type { Env } from "./types";

const MAX_RAW_SIZE = 25 * 1024 * 1024; // 25 MiB 上限，超过即拒，避免 PostalMime 解析大邮件

// Cloudflare 入站邮件管道：解析收件地址 → D1 查绑定 → 校验信封发件人 → 提码 → 投递到用户 DO。
//
// 安全模型（三道独立防线）：
//   (a) 不可枚举的随机收件地址：token → bind 查表是真正的「谁能投进来」门。攻击者不知道某用户的
//       随机 token，根本投不到对的地址。
//   (b) CF 平台层 SPF/DKIM 门（在 Worker 之前）：CF 在 MX/邮局阶段强制入站邮件「通过 SPF 或带
//       正确 DKIM」，否则在进入本 Worker 之前就拒收。cqu.edu.cn 无 DKIM、SPF 只授权 CQU 发信 IP，
//       故任何「到达本 Worker 且信封 MAIL FROM=sso@cqu.edu.cn」的邮件必然已过 SPF（来自 CQU IP）。
//   (c) 信封发件人白名单：envelopeSenderAllowed(message.from, whitelist)。`message.from` 是
//       *信封* MAIL FROM（CF 文档明确：用于安全判断的字段），非可伪造的邮件头 From。
//
// 安全顺序（先校验、后解析正文）：
//   1. token → bind（D1），缺失/已 revoked 立即 setReject（pending 与 active 都收码）
//   2. rawSize 上限校验
//   3. 解析 senderWhitelist + envelopeSenderAllowed(message.from)，不过即 setReject
//   4. 以上全过后，才 PostalMime.parse + extractCode
//
// 信封发件人校验必须在 extractCode 之前运行：提码器信任正文来自 CQU，只有确认信封发件人在白名单内
// （叠加上面 CF 平台 SPF 门：白名单内的 cqu.edu.cn 地址必来自 CQU 授权 IP）后，才允许把正文里的
// 6 位数字当作可信验证码提取。
//
// ⚠️ 勿重新引入 ARC 头方案：旧实现读 `ARC-Authentication-Results` 并要求 CF 盖章
// （trustedCfArc/parseInboundAuth/senderVerified）。但 `ARC-*` 是「转发链」认证头，只在 *转发*
// 路径上添加，*不会* 出现在投递给 Worker email() handler 的入站邮件里——该头恒缺失，导致真实 CQU
// 邮件被全部误拒。已改为「CF 平台 SPF 门 + 信封发件人白名单 + 不可枚举地址」模型。
//
// 审计日志约定（Phase 7 加固）：每个有意义的「结果」只打一行，避免逐微步刷屏。
//   - ACCEPT（成功提码并投递）：一行 console.log `[email] accepted`，含 kind（绝不含码值）。
//   - REJECT（每条预期内拒绝）：一行 console.warn `[email] rejected`，reason 为稳定短码；
//     from 仅在 sender_not_allowed 时打出（便于发现伪造/配置错）。
//   - ERROR（基础设施故障——可能丢失合法验证码）：console.error `[email] error`，含 stage，必须显眼。
// 永不记录 hit.code/验证码值，也永不记录原始 MIME 正文。
//
// 零出站：永不调用 message.forward() / message.reply()。
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  const token = localPart(message.to);

  // 校验前的 D1 查询：基础设施故障不应静默吞掉（此时还无法判定发件人，但查询失败本身值得记录）。
  let bind: typeof cquBindAddresses.$inferSelect | undefined;
  try {
    const db = drizzle(env.DATABASE);
    bind = await db
      .select()
      .from(cquBindAddresses)
      .where(eq(cquBindAddresses.token, token))
      .get();
  } catch (err) {
    console.error("[email] error", {
      token,
      stage: "d1_lookup",
      message: err instanceof Error ? err.message : String(err),
    });
    return message.setReject("temporary lookup failure");
  }
  // 生命周期门（非安全门）：pending 与 active 都收码，只拒 revoked（已撤销）与缺失。
  //
  // 为什么 pending 必须收码：onboarding 是先有蛋、后有鸡的时序——
  //   POST /credentials 在绑定仍为 pending 时就触发 DO 首登；首登让 CQU 发出
  //   login_2fa 邮件，bind_confirm 确认码同样在 pending 阶段到达。若此处只收 active，
  //   首登 2FA 邮件会被丢弃 → 容器等码超时 → 首登永远不成功 → status 永远到不了 active，
  //   形成死锁。故 pending 必须收码。
  //
  // 这推翻了 Phase 3 review 的 C2 结论（"pending 绑定不应收码"）：C2 的本意是别让
  // 未验证的绑定收码，但它没考虑 onboarding 首登 2FA 的时序依赖——已被本次排序结论取代。
  // 真正的安全门是「不可枚举的随机收件地址」+「SPF/ARC 发件人校验」（下方步骤 2/3），
  // 绑定 status 只是生命周期开关（revoked = 关），不是安全门。请勿"修回"成 active-only。
  if (!bind || bind.status === "revoked") {
    console.warn("[email] rejected", {
      token,
      reason: "unknown_or_revoked_binding",
    });
    return message.setReject("inactive binding");
  }

  if (message.rawSize > MAX_RAW_SIZE) {
    console.warn("[email] rejected", {
      token,
      reason: "oversized",
      rawSize: message.rawSize,
    });
    return message.setReject("too large");
  }

  // I1: 解析 senderWhitelist（JSON 字符串数组）不得把异常抛出 handler。绑定数据损坏属基础设施级
  // 故障（可能导致合法验证码丢失），记为 error。
  let whitelist: string[];
  try {
    const parsed = JSON.parse(bind.senderWhitelist);
    if (!Array.isArray(parsed)) {
      console.error("[email] error", {
        token,
        stage: "whitelist_parse",
        message: "senderWhitelist is not an array",
      });
      return message.setReject("invalid binding");
    }
    whitelist = parsed;
  } catch (err) {
    console.error("[email] error", {
      token,
      stage: "whitelist_parse",
      message: err instanceof Error ? err.message : String(err),
    });
    return message.setReject("invalid binding");
  }

  // 信封发件人门：message.from 是信封 MAIL FROM（CF 平台 SPF 门已保证它来自被授权 IP）。
  // 预期内拒绝（信封发件人不在白名单）。诊断打出 message.from 以便和真实邮件对照，判断是误拒
  // 真信还是正确挡了非白名单发件人。不含验证码值。
  if (!envelopeSenderAllowed(message.from, whitelist)) {
    console.warn("[email] rejected", {
      token,
      reason: "sender_not_allowed",
      from: message.from,
    });
    return message.setReject("sender not allowed");
  }

  // —— 自此以下，发件人已确认为可信 CQU 来源 ——
  // 之后任何基础设施故障都可能导致「合法验证码丢失」，必须 console.error 留痕，不得静默吞。

  // 发件人已确认为 CQU 官方后，才解析正文并提码（extractCode 信任正文来源）。
  let email: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    email = await PostalMime.parse(message.raw);
  } catch (err) {
    console.error("[email] error", {
      token,
      stage: "parse",
      message: err instanceof Error ? err.message : String(err),
    });
    return message.setReject("parse failure");
  }

  const hit = extractCode(email.subject ?? "", email.text ?? email.html ?? "");
  if (!hit) {
    // 邮件已解析但未提到验证码：静默 drop（不出站、不回弹），但记 warn——发件人已校验通过却提不到码，
    // 多半是 CQU 邮件格式变更，需在日志里可见以便及时修提码正则。不记原始正文。
    console.warn("[email] rejected", { token, reason: "no_code_extracted" });
    return;
  }

  // 投递到用户的 Durable Object —— 复用 src/routes/cqu.ts 的寻址约定：
  // idFromName(userId) → get(id) → fetch(new Request(...))。
  // deposit-code action 由 Phase 5 实现，此处先接线（当前运行时可能 404）。
  let depositOk = false;
  try {
    const doId = env.CQU_SESSION.idFromName(bind.userId);
    const stub = env.CQU_SESSION.get(doId);
    const res = await stub.fetch(
      new Request("https://do/deposit-code", {
        method: "POST",
        body: JSON.stringify({ ...hit, sender: message.from, ts: Date.now() }),
      })
    );
    depositOk = res.ok;
    // M1: 检查投递结果。Phase 5 前 deposit-code 还没实现，已知会 404——记录但不崩溃。
    if (!res.ok) {
      // TODO Phase 5: deposit-code action 落地后，此处 404 应消失；届时校验 res.ok 并据此处理。
      console.error("[email] error", {
        token,
        stage: "do_deposit",
        message: `deposit-code returned ${res.status}`,
      });
    }
  } catch (err) {
    console.error("[email] error", {
      token,
      stage: "do_deposit",
      message: err instanceof Error ? err.message : String(err),
    });
    // 投递抛错也不抛出 handler（避免给上游退信/触发重投制造可观测的副作用）。
  }

  // 单条 ACCEPT 审计行：发件人已校验通过 + 成功提码。记 kind（绝不记码值）+ depositOk。
  console.log("[email] accepted", {
    token,
    userId: bind.userId,
    kind: hit.kind,
    depositOk,
  });
}
