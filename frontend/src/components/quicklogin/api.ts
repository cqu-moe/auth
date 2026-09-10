export interface PublicDevice {
  deviceId: string;
  deviceName: string;
  browserFamily: "chrome";
  browserVersion: string;
  enabled: boolean;
  enabledAt: number | null;
  lastSeenAt: number | null;
  lastIp: string | null;
  revokedAt: number | null;
  generation: number;
  disabledReason: "user" | "quota_reduced" | null;
  appliedVersion: number | null;
  online: boolean;
}

export interface DeviceListData {
  masterEnabled: boolean;
  deviceLimit: number;
  used: number;
  revision: number;
  devices: PublicDevice[];
}

export interface QuotaPreview {
  token: string;
  expiresAt: number;
  revision: number;
  oldLimit: number;
  newLimit: number;
  kept: string[];
  disabled: string[];
}

async function read<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>;
  const body = await response.json().catch(() => null) as {
    error?: { code?: string; message?: string };
    detail?: { error?: { code?: string; message?: string } };
    preview?: QuotaPreview;
  } | null;
  const error = new Error(
    body?.error?.message ?? body?.detail?.error?.message ?? "请求失败"
  ) as Error & { code?: string; preview?: QuotaPreview; status?: number };
  error.code = body?.error?.code ?? body?.detail?.error?.code;
  error.preview = body?.preview;
  error.status = response.status;
  throw error;
}

export function getQuicklogin(): Promise<DeviceListData> {
  return fetch("/api/cqu/quicklogin/devices", { credentials: "include" })
    .then(read<DeviceListData>);
}

export function setMasterEnabled(enabled: boolean): Promise<Pick<
  DeviceListData, "masterEnabled" | "deviceLimit" | "used"
>> {
  return fetch("/api/cqu/quicklogin", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  }).then(read<Pick<DeviceListData, "masterEnabled" | "deviceLimit" | "used">>);
}

export async function revokeDevice(deviceId: string): Promise<void> {
  const response = await fetch(
    `/api/cqu/quicklogin/devices/${encodeURIComponent(deviceId)}`,
    { method: "DELETE", credentials: "include" }
  );
  if (!response.ok) await read(response);
}

export function previewQuota(userId: string, deviceLimit: number): Promise<QuotaPreview> {
  return fetch(`/api/admin/users/${encodeURIComponent(userId)}/quicklogin-quota/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceLimit }),
  }).then(read<QuotaPreview>);
}

export function applyQuota(
  userId: string,
  preview: QuotaPreview
): Promise<DeviceListData> {
  return fetch(`/api/admin/users/${encodeURIComponent(userId)}/quicklogin-quota`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: preview.token, newLimit: preview.newLimit }),
  }).then(read<DeviceListData>);
}
