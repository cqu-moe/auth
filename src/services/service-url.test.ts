import { describe, it, expect } from "vitest";
import { validateCquServiceUrl } from "./service-url";

describe("validateCquServiceUrl", () => {
  it.each([
    "https://my.cqu.edu.cn/sso/login",
    "https://cqu.edu.cn/x",
    "https://my.cqu.edu.cn:443/x",            // 显式 443 必须 ACCEPT(防回归成 if(port)reject)
  ])("accepts %s and returns canonical href", (ok) => {
    expect(validateCquServiceUrl(ok)).toBe(new URL(ok).href);
  });
  // pinned 决策:纯数字子域属 *.cqu.edu.cn → 放行,CAS service registry 兜底
  it("accepts numeric-looking subdomain", () => {
    expect(() => validateCquServiceUrl("https://0x7f000001.cqu.edu.cn/x")).not.toThrow();
  });
  it.each([
    "http://my.cqu.edu.cn/x",                 // 非 https
    "https://evil-cqu.edu.cn/x",              // 缺前导点
    "https://cqu.edu.cn.evil.com/x",          // 后缀在中间
    "https://lib.cqu.edu.cn@evil.com/x",      // userinfo
    "https://lib.cqu.edu.cn\\@evil.com/x",    // 反斜杠(曾 ACCEPT 的 blocker)
    "https://my.cqu.edu.cn:8443/x",           // 异常端口
    "https://my.cqu.edu.cn./x",               // 尾点(pinned REJECT:cn.==cn 风险)
    "https://.cqu.edu.cn/x",                  // 前导空 label(defense-in-depth REJECT)
    "https://my..cqu.edu.cn/x",               // 中间空 label(defense-in-depth REJECT)
    "https://cqu.edu.cn../x",                 // 尾部空 label(已被尾点闸 REJECT,完整性收录)
    "https://my。cqu。edu。cn/x",              // 全角点(non-ascii,pinned REJECT)
    "https://my.cqu.edu.cn\r\n.evil.com/x",   // CRLF 注入形
    "https://my.cqu.edu.cn%252e.evil.com/x",  // 双重编码点
    "https://xn--cqu-evil.edu.cn/x",          // IDN(非 .cqu.edu.cn)
    "https://127.0.0.1/x",                    // IP literal
    "ftp://my.cqu.edu.cn/x",
    "javascript:alert(1)",
    "not a url",
  ])("rejects %s", (bad) => {
    expect(() => validateCquServiceUrl(bad)).toThrow();
  });
});
