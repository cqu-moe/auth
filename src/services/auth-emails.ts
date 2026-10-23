export interface AuthEmailRender {
  subject: string;
  html: string;
  text: string;
}

const ICON_URL = "https://auth.cqu.moe/brand/icon-192.png";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]!);
}

function renderEmail(email: {
  title: string;
  bodyHtml: string;
  bodyText: string;
}): AuthEmailRender {
  return {
    subject: `${email.title} - CQU Auth`,
    html: `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<style>
  a { text-decoration: none; }
  @media (max-width: 600px) { .email-padding { padding: 20px !important; } }
  @media (prefers-color-scheme: dark) {
    .email-shell { background: #0b1220 !important; }
    .email-card, .email-otp { background: #1f2937 !important; }
    .email-card, .email-content, .email-otp { color: #f9fafb !important; }
    .email-muted, .email-footer { color: #c3cad4 !important; }
    .email-link, .email-button-link { color: #93c5fd !important; }
    .email-border { border-color: rgba(255, 255, 255, 0.14) !important; }
  }
</style>
</head>
<body class="email-shell" style="margin:0;padding:32px 16px;background:#f3f5f8;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;">
  <table class="email-card email-border" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;border:1px solid rgba(0,0,0,.08);">
    <tr><td class="email-padding" style="padding:32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td class="email-border" style="padding-bottom:24px;border-bottom:1px solid rgba(0,0,0,.08);">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="width:32px;padding-right:10px;vertical-align:middle;">
                  <img src="${ICON_URL}" width="32" height="32" alt="CQU Auth" style="display:block;border-radius:8px;">
                </td>
                <td class="email-content" style="vertical-align:middle;font-size:16px;color:#111827;"><strong>CQU Auth</strong></td>
              </tr>
            </table>
          </td>
        </tr>
        <tr><td class="email-content" style="padding-top:28px;padding-bottom:32px;font-size:16px;line-height:1.6;color:#111827;">${email.bodyHtml}</td></tr>
        <tr><td class="email-footer email-border" style="padding-top:24px;border-top:1px solid rgba(0,0,0,.08);font-size:13px;line-height:1.6;color:#4b5563;">
          此邮件为系统通知，不接收回复。<br>
          <a class="email-link" href="https://auth.cqu.moe/" style="color:#0850ab;font-weight:600;">打开 CQU Auth</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    text: `CQU Auth\n\n${email.bodyText}\n\n此邮件为系统通知，不接收回复。\n打开 CQU Auth：https://auth.cqu.moe/`,
  };
}

function renderOtpEmail(title: string, intro: string, otp: string): AuthEmailRender {
  return renderEmail({
    title,
    bodyHtml: `<h1 style="margin:0 0 16px;font-size:26px;line-height:1.25;">${title}</h1>
<p style="margin:0 0 24px;">${intro}</p>
<div class="email-otp email-border" style="display:inline-block;padding:16px 20px;background:#f5f7fa;border:1px solid rgba(0,0,0,.08);border-radius:8px;font-size:28px;font-weight:700;letter-spacing:8px;color:#111827;">${escapeHtml(otp)}</div>
<p class="email-muted" style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#4b5563;">验证码 5 分钟内有效。请勿转发给他人；如非本人操作，可忽略这封邮件。</p>`,
    bodyText: `${title}\n\n${intro}\n\n${otp}\n\n验证码 5 分钟内有效。请勿转发给他人；如非本人操作，可忽略这封邮件。`,
  });
}

export function renderVerificationEmail(otp: string): AuthEmailRender {
  return renderOtpEmail("验证你的邮箱", "请输入以下验证码，完成邮箱验证。", otp);
}

export function renderEmailChangeEmail(otp: string): AuthEmailRender {
  return renderOtpEmail("验证新登录邮箱", "请输入以下验证码，完成登录邮箱更换。", otp);
}

export function renderPasswordResetEmail(url: string): AuthEmailRender {
  const safeUrl = escapeHtml(url);
  return renderEmail({
    title: "重置密码",
    bodyHtml: `<h1 style="margin:0 0 16px;font-size:26px;line-height:1.25;">重置密码</h1>
<p style="margin:0 0 24px;">请点击下方按钮重置密码。若非本人操作，可忽略这封邮件。</p>
<a class="email-button" href="${safeUrl}" style="display:inline-block;padding:12px 22px;background:#0850ab;color:#ffffff;border-radius:6px;font-size:16px;font-weight:600;">重置密码</a>
<p class="email-muted" style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#4b5563;">如果按钮无法使用，请将以下链接复制到浏览器：<br><a class="email-button-link" href="${safeUrl}" style="color:#0850ab;overflow-wrap:anywhere;">${safeUrl}</a></p>`,
    bodyText: `重置密码\n\n请打开以下链接重置密码。若非本人操作，可忽略这封邮件。\n\n${url}\n\n如果链接无法点击，请将它复制到浏览器。`,
  });
}
