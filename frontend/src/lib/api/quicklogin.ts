import type { ApiSuccess } from "../../../../shared/api-response";
import type { components } from "../../../../shared/api-types.generated";
import { ApiError, apiRequest } from "./http";
import { ContractError, parseApiResponse, parseOverview, type Overview } from "./quicklogin-protocol.generated";

export async function getQuickloginOverview(signal?: AbortSignal): Promise<Overview> {
  return parseApiResponse(await apiRequest<unknown>("/cqu/quicklogin/overview", { signal }), parseOverview).data;
}

type ResumeTicket = { resumeTicket: string; deviceId: string; expiresAt: number };
type ChromeRuntime = {
  sendMessage: (extensionId: string, message: unknown) => Promise<unknown>;
};

const QUICKLOGIN_EXTENSION_IDS = [
  "ainapeknaclcpoioimonkodmoakhacjd",
  "igfidegfgfoofnoncpmbcokbffjmmook",
] as const;
const DISCOVERY_TIMEOUT_MS = 1_500;
const RESUME_TIMEOUT_MS = 5_000;

async function withTimeout<T>(request: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
}

async function findMatchingExtension(deviceId: string, runtime: ChromeRuntime): Promise<string> {
  const discovered = await Promise.all(QUICKLOGIN_EXTENSION_IDS.map(async (extensionId) => {
    try {
      const response = await withTimeout(
        runtime.sendMessage(extensionId, { type: "GET_DEVICE_INFO" }),
        DISCOVERY_TIMEOUT_MS,
      );
      const info = response as { deviceId?: unknown } | null;
      if (!info || typeof info !== "object" || Object.keys(info).join(",") !== "deviceId" ||
        (typeof info.deviceId !== "string" && info.deviceId !== null)) return { extensionId, valid: false };
      return { extensionId, valid: true, deviceId: info.deviceId };
    } catch {
      return { extensionId, valid: false };
    }
  }));
  const matches = discovered.filter((item) => item.valid && "deviceId" in item && item.deviceId === deviceId);
  if (matches.length === 1) return matches[0].extensionId;
  if (matches.length > 1) {
    throw new Error("检测到多个 QuickLogin 插件报告同一设备，请只保留一个安装实例后重试。");
  }
  if (discovered.some((item) => item.valid)) {
    throw new Error("这台浏览器不是要重新连接的设备。请回到原浏览器重试；若已重装插件，请退出旧设备后重新授权。");
  }
  throw new Error("无法确认 QuickLogin 插件设备信息，请确认插件已启用并更新后重试。");
}

function parseResumeTicket(value: unknown): ResumeTicket {
  if (!value || typeof value !== "object") throw new ContractError();
  const ticket = value as Partial<ResumeTicket>;
  if (typeof ticket.resumeTicket !== "string" || ticket.resumeTicket.length === 0 || ticket.resumeTicket.length > 4096 ||
    typeof ticket.deviceId !== "string" || !ticket.deviceId || typeof ticket.expiresAt !== "number" || !Number.isSafeInteger(ticket.expiresAt)) throw new ContractError();
  return { resumeTicket: ticket.resumeTicket, deviceId: ticket.deviceId, expiresAt: ticket.expiresAt };
}

export async function reconnectQuickloginDevice(deviceId: string): Promise<void> {
  const runtime = (globalThis as typeof globalThis & {
    chrome?: { runtime?: ChromeRuntime };
  }).chrome?.runtime;
  if (!runtime?.sendMessage) throw new Error("未找到快捷登录插件，请在安装此插件的浏览器中重试。");
  const extensionId = await findMatchingExtension(deviceId, runtime);
  const ticket = parseApiResponse(await apiRequest<unknown>(
    `/cqu/quicklogin/devices/${encodeURIComponent(deviceId)}/resume-ticket`, { method: "POST" }
  ), parseResumeTicket).data;
  if (ticket.deviceId !== deviceId || ticket.expiresAt <= Date.now()) throw new ContractError();
  let response: unknown;
  try {
    response = await withTimeout(
      runtime.sendMessage(extensionId, { type: "RESUME_DEVICE", ...ticket }),
      RESUME_TIMEOUT_MS,
    );
  } catch {
    throw new Error("无法连接快捷登录插件，请确认插件已启用并更新后重试。");
  }
  if (!response || typeof response !== "object" || !("accepted" in response) || response.accepted !== true) {
    throw new Error("插件未接受重新连接，请在对应浏览器中更新插件后重试。");
  }
}


export type PublicDevice = components["schemas"]["PublicDevice"];
export type DeviceListData = components["schemas"]["DeviceListData"];
export type DeviceQuickloginPreference =
  components["schemas"]["QuickloginDevicePreference"];
export type LegacyQuickloginPreference =
  components["schemas"]["QuickloginLegacyPreference"];
export type QuickloginPreference = components["schemas"]["QuickloginPreference"];
export type QuickloginPreferenceUpdateResult =
  components["schemas"]["QuickloginPreferenceUpdateResult"];
export type QuotaPreview = components["schemas"]["QuickloginQuotaPreview"];
export type QuotaPreviewDevice = components["schemas"]["QuickloginQuotaDevice"];

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
): Promise<QuickloginPreferenceUpdateResult> {
  return (await apiRequest<ApiSuccess<QuickloginPreferenceUpdateResult>>("/cqu/quicklogin", {
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
