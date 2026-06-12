import { describe, it, expect } from "vitest";
import { extractCode } from "./extract-code";

const LOGIN_SUBJECT = "邮件验证码登录";
const LOGIN_TEXT =
  "您正在进行统一身份认证，请在页面中输入下方验证码完成验证 740004 安全提示：若并非你本人在操作，请忽略此邮件，切勿将验证码告知他人 为保障您的帐户安全，请在 600 秒内完成验证，否则验证码将自动失效。";

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
