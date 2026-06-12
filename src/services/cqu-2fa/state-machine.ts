export type CquStatus = "unbound" | "binding" | "active" | "relogging" | "expired" | "revoked";
export type CquEvent =
  | "START_BIND"
  | "FIRST_LOGIN_OK"
  | "RELOGIN_START"
  | "RELOGIN_OK"
  | "RELOGIN_FAIL"
  | "REVOKE"
  | "UNBIND";

const TABLE: Record<CquStatus, Partial<Record<CquEvent, CquStatus>>> = {
  unbound: { START_BIND: "binding" },
  binding: { FIRST_LOGIN_OK: "active", REVOKE: "revoked", UNBIND: "unbound" },
  active: { RELOGIN_START: "relogging", REVOKE: "revoked", UNBIND: "unbound" },
  relogging: { RELOGIN_OK: "active", RELOGIN_FAIL: "expired", REVOKE: "revoked" },
  expired: { RELOGIN_START: "relogging", REVOKE: "revoked", UNBIND: "unbound" },
  revoked: { UNBIND: "unbound" },
};

export function nextStatus(current: CquStatus, event: CquEvent): CquStatus {
  return TABLE[current]?.[event] ?? current;
}
