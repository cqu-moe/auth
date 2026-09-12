import type { ApiSuccess } from "../../../../shared/api-response";
import { ApiError, apiRequest } from "./http";

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

export interface DeviceQuickloginPreference {
  eligible: true;
  masterEnabled: boolean;
  deviceLimit: number;
  used: number;
}

export interface LegacyQuickloginPreference {
  eligible: boolean;
  enabled: boolean;
}

export type QuickloginPreference =
  | { eligible: false; enabled?: boolean }
  | DeviceQuickloginPreference
  | LegacyQuickloginPreference;

export interface QuotaPreview {
  token: string;
  expiresAt: number;
  revision: number;
  oldLimit: number;
  newLimit: number;
  kept: string[];
  disabled: string[];
  keptDevices: QuotaPreviewDevice[];
  disabledDevices: QuotaPreviewDevice[];
}

export interface QuotaPreviewDevice {
  deviceId: string;
  deviceName: string;
  browserVersion: string;
  lastSeenAt: number | null;
}

export function isDeviceQuickloginPreference(
  value: QuickloginPreference
): value is DeviceQuickloginPreference {
  return value.eligible === true && "masterEnabled" in value;
}

export async function getQuickloginPreference(
  signal?: AbortSignal
): Promise<QuickloginPreference> {
  return (await apiRequest<ApiSuccess<QuickloginPreference>>(
    "/cqu/quicklogin",
    signal ? { signal } : {}
  )).data;
}

export async function setQuickloginMasterEnabled(
  enabled: boolean
): Promise<QuickloginPreference> {
  return (await apiRequest<ApiSuccess<QuickloginPreference>>("/cqu/quicklogin", {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  })).data;
}

export function listQuickloginDevices(signal?: AbortSignal): Promise<DeviceListData> {
  return apiRequest<DeviceListData>(
    "/cqu/quicklogin/devices",
    signal ? { signal } : {}
  );
}

export async function revokeQuickloginDevice(deviceId: string): Promise<void> {
  await apiRequest<void>(
    `/cqu/quicklogin/devices/${encodeURIComponent(deviceId)}`,
    { method: "DELETE" }
  );
}

export async function previewQuickloginQuota(
  userId: string,
  deviceLimit: number
): Promise<QuotaPreview> {
  return (await apiRequest<ApiSuccess<QuotaPreview>>(
    `/admin/users/${encodeURIComponent(userId)}/quicklogin-quota/preview`,
    {
      method: "POST",
      body: JSON.stringify({ deviceLimit }),
    }
  )).data;
}

export async function applyQuickloginQuota(
  userId: string,
  preview: QuotaPreview
): Promise<DeviceListData> {
  return (await apiRequest<ApiSuccess<DeviceListData>>(
    `/admin/users/${encodeURIComponent(userId)}/quicklogin-quota`,
    {
      method: "PUT",
      body: JSON.stringify({ token: preview.token, newLimit: preview.newLimit }),
    }
  )).data;
}

function isQuotaPreview(value: unknown): value is QuotaPreview {
  if (!value || typeof value !== "object") return false;
  const preview = value as Partial<QuotaPreview>;
  return typeof preview.token === "string" &&
    Number.isSafeInteger(preview.expiresAt) &&
    Number.isSafeInteger(preview.revision) &&
    Number.isSafeInteger(preview.oldLimit) &&
    Number.isSafeInteger(preview.newLimit) &&
    Array.isArray(preview.kept) && preview.kept.every((id) => typeof id === "string") &&
    Array.isArray(preview.disabled) && preview.disabled.every((id) => typeof id === "string") &&
    Array.isArray(preview.keptDevices) && preview.keptDevices.every(isQuotaPreviewDevice) &&
    Array.isArray(preview.disabledDevices) && preview.disabledDevices.every(isQuotaPreviewDevice);
}

function isQuotaPreviewDevice(value: unknown): value is QuotaPreviewDevice {
  if (!value || typeof value !== "object") return false;
  const device = value as Partial<QuotaPreviewDevice>;
  return typeof device.deviceId === "string" && device.deviceId.length > 0 &&
    typeof device.deviceName === "string" && device.deviceName.length > 0 &&
    typeof device.browserVersion === "string" &&
    (device.lastSeenAt === null || Number.isSafeInteger(device.lastSeenAt));
}

export function previewFromApiError(error: unknown): QuotaPreview | null {
  if (!(error instanceof ApiError) || error.code !== "PREVIEW_CHANGED") return null;
  const preview = error.body?.preview;
  return isQuotaPreview(preview) ? preview : null;
}
