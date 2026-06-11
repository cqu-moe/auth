import { createHash } from "@better-auth/utils/hash";
import { base64Url } from "@better-auth/utils/base64";

// 复刻 @better-auth/oauth-provider 的 defaultHasher：SHA-256 → base64url（无填充）。
// 项目以 "hashed" 模式存 client secret（启用了 jwt 插件），admin 层轮换必须产出
// 与插件 validateClientCredentials 期望一致的哈希，否则新密钥无法通过校验。
export async function hashOAuthClientSecret(secret: string): Promise<string> {
  const hash = await createHash("SHA-256").digest(new TextEncoder().encode(secret));
  return base64Url.encode(new Uint8Array(hash), { padding: false });
}

// 生成 32 字符 URL-safe 随机 secret（明文仅在创建/轮换时返回一次）。
export function generateOAuthClientSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return base64Url.encode(bytes, { padding: false }).slice(0, 32);
}
