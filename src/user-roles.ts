export const USER_ROLE_OPTIONS = [
  { value: "user", label: "普通用户" },
  { value: "admin", label: "管理员" },
  { value: "superAdmin", label: "超级管理员" },
] as const;

export function canAccessAdmin(role: string | undefined): boolean {
  return role === "admin" || role === "superAdmin";
}
