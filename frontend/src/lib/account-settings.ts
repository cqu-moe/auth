export interface AccountFieldValidation {
  value: string | null;
  error: string | null;
}

export function validateDisplayName(input: string): AccountFieldValidation {
  const value = input.trim();
  if (!value) return { value: null, error: "请输入昵称" };
  if (value.length > 64) {
    return { value: null, error: "昵称不能超过 64 个字符" };
  }
  return { value, error: null };
}

export function validateNewEmail(
  currentEmail: string,
  input: string
): AccountFieldValidation {
  const value = input.trim().toLowerCase();
  if (!value) return { value: null, error: "请输入新邮箱" };
  if (value === currentEmail.trim().toLowerCase()) {
    return { value: null, error: "新邮箱不能与当前邮箱相同" };
  }
  return { value, error: null };
}
