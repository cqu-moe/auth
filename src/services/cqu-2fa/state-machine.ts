export type CquStatus =
  | "unbound"
  | "binding"
  | "active"
  | "relogging"
  | "expired"
  | "needs_reauth"
  | "revoked";
export type CquEvent =
  | "START_BIND"
  | "FIRST_LOGIN_OK"
  | "FIRST_LOGIN_FAIL"
  | "RELOGIN_START"
  | "RELOGIN_OK"
  | "RELOGIN_FAIL"
  | "REAUTH_REQUIRED"
  | "REVOKE"
  | "UNBIND";

const TABLE: Record<CquStatus, Partial<Record<CquEvent, CquStatus>>> = {
  unbound: { START_BIND: "binding" },
  binding: {
    FIRST_LOGIN_OK: "active",
    // 首登失败回到 unbound（route 已回滚 D1 行）。
    FIRST_LOGIN_FAIL: "unbound",
    REVOKE: "revoked",
    UNBIND: "unbound",
  },
  active: { RELOGIN_START: "relogging", REVOKE: "revoked", UNBIND: "unbound" },
  relogging: { RELOGIN_OK: "active", RELOGIN_FAIL: "expired", REVOKE: "revoked" },
  // 熔断: 连续凭据失败 → needs_reauth 终态(凭据真死, 需用户重绑)。
  expired: {
    RELOGIN_START: "relogging",
    REAUTH_REQUIRED: "needs_reauth",
    REVOKE: "revoked",
    UNBIND: "unbound",
  },
  // needs_reauth 终态: alarm 不再保活/重排; 仅靠用户重绑(START_BIND)或撤销/解绑退出。
  needs_reauth: { START_BIND: "binding", REVOKE: "revoked", UNBIND: "unbound" },
  revoked: { UNBIND: "unbound" },
};

export function nextStatus(current: CquStatus, event: CquEvent): CquStatus {
  return TABLE[current]?.[event] ?? current;
}
