import { Button } from "@cqu-moe/ui";
export type AuthenticationMethod = "password" | "passkey";
export default function AuthenticationMethodChoice({ value, onChange, disabled }: { value: AuthenticationMethod; onChange: (method: AuthenticationMethod) => void; disabled?: boolean }) {
  return <div role="group" aria-label="身份验证方式" className="flex gap-2">
    <Button type="button" variant="outline" disabled={disabled} aria-pressed={value === "password"} onClick={() => onChange("password")}>使用密码</Button>
    <Button type="button" variant="outline" disabled={disabled} aria-pressed={value === "passkey"} onClick={() => onChange("passkey")}>使用 Passkey</Button>
  </div>;
}
