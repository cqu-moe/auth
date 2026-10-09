import { isBanned, type OAuthTokenAdapter } from "./oauth-tokens";

interface DeviceUser {
  id: string; name: string; email: string; image?: string | null; role?: string | null;
  banned?: boolean | null; banExpires?: Date | string | null;
}
interface DeviceClient { clientId: string; disabled?: boolean | null; skipConsent?: boolean | null; metadata?: Record<string, unknown> | null }

/** Call only after cryptographic/native token validation. JWTs need no access row. */
export async function currentDeviceAuthority(adapter: OAuthTokenAdapter, payload: Record<string, unknown>) {
  const clientId = payload.azp ?? payload.client_id;
  if (typeof payload.sid !== "string" || !payload.sid || typeof payload.sub !== "string" || typeof clientId !== "string") return null;
  const [session, client] = await Promise.all([
    adapter.findOne<{ userId: string; expiresAt: Date }>({ model: "session", where: [{ field: "id", value: payload.sid }] }),
    adapter.findOne<DeviceClient>({ model: "oauthClient", where: [{ field: "clientId", value: clientId }] }),
  ]);
  const expiresAt = session ? new Date(session.expiresAt).getTime() : NaN;
  if (!session || session.userId !== payload.sub || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || !client || client.disabled) return null;
  const user = await adapter.findOne<DeviceUser>({ model: "user", where: [{ field: "id", value: session.userId }] });
  if (!user || isBanned(user)) return null;
  return { user, client };
}
