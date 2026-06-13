import PostalMime from "postal-mime";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { cquBindAddresses } from "./db/schema";
import { localPart } from "./services/cqu-2fa/address";
import { extractCode } from "./services/cqu-2fa/extract-code";
import {
  envelopeSenderAllowed,
  forwardSenderAllowed,
} from "./services/cqu-2fa/sender-auth";
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
// 安全顺序（先校验、后解析正文）—— 按 bind.kind 分叉：
//   1. token → bind（D1），缺失/已 revoked 立即 setReject（pending 与 active 都收码）
//   2. rawSize 上限校验
//   3. 解析 senderWhitelist（JSON 数组）
//   4a. kind=direct：envelopeSenderAllowed(message.from, whitelist=["sso@cqu.edu.cn"]) 不过即
//       setReject → 过后 PostalMime.parse → extractCode。**现状不变。**
//   4b. kind=forward：先 envelopeSenderAllowed(message.from, whitelist=[用户转发地址])——
//       不过即 setReject 且 **不 parse**（不解析未过 envelope 闸的邮件）；过后 PostalMime.parse →
//       取 header From 地址 → forwardSenderAllowed（再校验 header From===sso@cqu.edu.cn）→ extractCode。
//
// 信封发件人校验必须在 extractCode 之前运行：提码器信任正文来自 CQU，只有确认信封发件人在白名单内
// （direct：叠加 CF 平台 SPF 门，白名单内的 cqu.edu.cn 地址必来自 CQU 授权 IP）后，才允许把正文里的
// 6 位数字当作可信验证码提取。
//
// ⚠️ forward 的 CQU 来源信号在 *header From*（MIME 内、可伪造），**本质弱于直设**：direct 的
// envelope=sso@cqu.edu.cn 由 CF SPF 闸背书来自 CQU IP；forward 的 envelope 只是用户转发方地址，
// CQU 来源仅靠 header From===sso@cqu.edu.cn 这一可伪造信号补回。最坏后果是注入假码致单次重登失败
// （DoS 级），非账号接管。详见 src/services/cqu-2fa/sender-auth.ts 的信任模型注释。
//
// ⚠️ 勿重新引入 ARC 头方案：旧实现读 `ARC-Authentication-Results` 并要求 CF 盖章
// （trustedCfArc/parseInboundAuth/senderVerified）。但 `ARC-*` 是「转发链」认证头，只在 *转发*
// 路径上添加，*不会* 出现在投递给 Worker email() handler 的入站邮件里——该头恒缺失，导致真实 CQU
// 邮件被全部误拒。已改为「CF 平台 SPF 门 + 信封发件人白名单 + 不可枚举地址」模型。
//
// 审计日志约定（Phase 7 加固）：每个有意义的「结果」只打一行，避免逐微步刷屏。
//   - ACCEPT（成功提码 **且** 投递到 DO 成功）：一行 console.log `[email] accepted`，含 kind（绝不含码值）。
//     ⚠️ accepted 只在 depositOk 时打——提码后投递失败属丢码，记 error 而非 accepted（见末尾分叉），
//     避免「确认发件人后丢码」被「accepted」措辞掩盖。
//   - REJECT（每条预期内拒绝）：一行 console.warn `[email] rejected`，reason 为稳定短码；
//     from（信封 MAIL FROM）仅在发件人门相关 reason 打出（sender_not_allowed /
//     forward_envelope_mismatch / forward_header_from_mismatch），便于发现伪造/配置错、校正转发地址。
//     forward_header_from_mismatch **不**打印 header From 全文（避免噪声/日志注入）。
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

  // PostalMime.parse 的统一封装：parse 失败记 error（stage=parse）+ setReject，返回 null。
  // direct 与 forward 共用同一段 parse 错误处理。
  async function parseEmail(): Promise<Awaited<
    ReturnType<typeof PostalMime.parse>
  > | null> {
    try {
      return await PostalMime.parse(message.raw);
    } catch (err) {
      console.error("[email] error", {
        token,
        stage: "parse",
        message: err instanceof Error ? err.message : String(err),
      });
      message.setReject("parse failure");
      return null;
    }
  }

  // 信封 + 发件人门（按 kind 分叉），通过后产出已解析的 email 供下游提码。
  // message.from 是信封 MAIL FROM（CF 文档：用于安全判断的字段）。
  let email: Awaited<ReturnType<typeof PostalMime.parse>>;

  if (bind.kind === "forward") {
    // forward：whitelist=[用户登记的转发地址]。先校验 envelope ∈ 转发地址（证明穿过该用户转发器）。
    // 不过即拒，且 **不 parse**（不解析未过 envelope 闸的邮件——降低对未授信邮件的解析面，
    // 且 message.from 即用户需登记的实际 envelope，记录它便于校正登记地址 / SRS 兜底）。
    if (!envelopeSenderAllowed(message.from, whitelist)) {
      console.warn("[email] rejected", {
        token,
        reason: "forward_envelope_mismatch",
        from: message.from,
      });
      return message.setReject("sender not allowed");
    }

    // envelope 已过 → 解析正文以读取 header From。
    const parsed = await parseEmail();
    if (!parsed) return; // parseEmail 已 setReject + 记 error
    email = parsed;

    // 校验 header From===sso@cqu.edu.cn（补回 CQU 来源信号，可伪造）。
    // ⚠️ 实现铁律（待真实样本确认）：header From 在不同转发器下可能是 sso@cqu.edu.cn，也可能被
    // SRS 改写为别的地址或挪到 Reply-To。本实现按 email.from.address===sso@cqu.edu.cn 做 v1，
    // **必须用一封真实转发样本确认实际形状后才能信任上线**（项目历史三次栽在凭样本猜）。
    // 不要凭空加 Reply-To 兜底（无样本佐证，YAGNI），仅在此标注此校验项待核。
    const headerFrom = email.from?.address ?? "";
    if (!forwardSenderAllowed(message.from, headerFrom, whitelist)) {
      // header From 不是 CQU。不打印 headerFrom 全文（避免噪声/日志注入），只记 reason + envelope from。
      console.warn("[email] rejected", {
        token,
        reason: "forward_header_from_mismatch",
        from: message.from,
      });
      return message.setReject("sender not allowed");
    }
  } else {
    // direct：whitelist=["sso@cqu.edu.cn"]。CF 平台 SPF 门已保证 envelope=sso@cqu.edu.cn 来自被授权 IP。
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

    // 发件人已确认为 CQU 官方后，才解析正文并提码（extractCode 信任正文来源）。
    const parsed = await parseEmail();
    if (!parsed) return; // parseEmail 已 setReject + 记 error
    email = parsed;
  }

  // —— 自此以下，发件人已确认为可信来源（direct: CQU IP；forward: 穿过用户转发器 + header From=CQU）——
  // 之后任何基础设施故障都可能导致「合法验证码丢失」，必须 console.error 留痕，不得静默吞。

  const hit = extractCode(email.subject ?? "", email.text ?? email.html ?? "");
  if (!hit) {
    // 邮件已解析但未提到验证码：静默 drop（不出站、不回弹），但记 warn——发件人已校验通过却提不到码，
    // 多半是 CQU 邮件格式变更，需在日志里可见以便及时修提码正则。不记原始正文。
    console.warn("[email] rejected", {
      token,
      reason: "no_code_extracted",
      kind: bind.kind,
    });
    return;
  }

  // 投递到用户的 Durable Object —— 复用 src/routes/cqu.ts 的寻址约定：
  // idFromName(userId) → get(id) → fetch(new Request(...))。
  // deposit-code action 已在 DO 实现（src/durable-objects/cqu-session.ts 的 case "deposit-code"）。
  // DO 恒返回 200 {success:true, delivered}；delivered 才反映码是否真送达容器/暂存。
  // 仅凭 res.ok 会把「DO 收到请求但码被静默 drop」（如 login_2fa 无在途锁）误记为 accepted，
  // 掩盖丢码——故此处要求 res.ok && body.delivered===true 才算投递成功。
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
    // 解析 body 取 delivered；解析失败按未送达处理（false），并在下方 do_deposit 分叉记 error。
    let delivered = false;
    try {
      const body = await res.json<{ delivered?: boolean }>();
      delivered = body.delivered === true;
    } catch {
      // 响应体解析失败：无法确认送达，保守按未送达。
    }
    depositOk = res.ok && delivered;
    // 非 2xx 或码未真送达（delivered!==true）：码实际未入站，记 error 留痕。
    if (!depositOk) {
      console.error("[email] error", {
        token,
        stage: "do_deposit",
        message: `deposit-code returned status=${res.status} delivered=${delivered}`,
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

  // 终局审计行按投递结果分叉，避免「accepted」措辞掩盖丢码：
  //   - depositOk：码已成功投递到 DO → 单条 ACCEPT（记 kind，绝不记码值）。
  //   - 否则：码提取成功但投递失败（已在上方记过 do_deposit 故障），码被丢弃 →
  //     终局记 error 而非 accepted，使「确认发件人后丢码」显眼可见（不退信/不重投，仅留痕）。
  if (depositOk) {
    console.log("[email] accepted", {
      token,
      userId: bind.userId,
      kind: hit.kind,
    });
  } else {
    console.error("[email] error", {
      token,
      userId: bind.userId,
      stage: "do_deposit_outcome",
      kind: hit.kind,
      message: "code extracted but deposit failed — code dropped",
    });
  }
}
