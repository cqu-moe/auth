import { describe, it, expect } from "vitest";
import { pickServiceTicketMode } from "./service-ticket-mode";

describe("pickServiceTicketMode", () => {
  it("serviceUrl 在场 → url 模式", () => {
    expect(
      pickServiceTicketMode({ serviceUrl: "https://my.cqu.edu.cn/x" })
    ).toEqual({ mode: "url", serviceUrl: "https://my.cqu.edu.cn/x" });
  });

  it("serviceUrl 优先于 service", () => {
    expect(
      pickServiceTicketMode({
        service: "jwxt",
        serviceUrl: "https://my.cqu.edu.cn/x",
      })
    ).toEqual({ mode: "url", serviceUrl: "https://my.cqu.edu.cn/x" });
  });

  it("仅 service → symbolic 模式", () => {
    expect(pickServiceTicketMode({ service: "jwxt" })).toEqual({
      mode: "symbolic",
      service: "jwxt",
    });
  });

  it("两者皆缺 → none", () => {
    expect(pickServiceTicketMode({})).toEqual({ mode: "none" });
  });

  it("空字符串视为缺省 → none", () => {
    expect(pickServiceTicketMode({ service: "", serviceUrl: "" })).toEqual({
      mode: "none",
    });
  });

  it("null 视为缺省 → none", () => {
    expect(
      pickServiceTicketMode({ service: null, serviceUrl: null })
    ).toEqual({ mode: "none" });
  });
});
