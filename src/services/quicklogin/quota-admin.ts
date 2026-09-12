import type { DeviceList, QuotaApply, QuotaPreview } from "./contracts";
import { DEVICE_LIMIT_KEY, MASTER_KEY } from "./contracts";
import { validateDeviceLimit } from "./policy";

export interface EntitlementItem {
  subsystem: string;
  capability: string;
  value: string;
}

export interface QuickloginQuotaCoordinator {
  previewQuota(userId: string, limit: number, now: number): Promise<QuotaPreview>;
  applyQuota(userId: string, input: QuotaApply, now: number): Promise<DeviceList>;
}

export type QuickloginQuotaAdminErrorCode =
  | "FORBIDDEN"
  | "INVALID_REQUEST"
  | "QUICKLOGIN_PREVIEW_REQUIRED";

export class QuickloginQuotaAdminError extends Error {
  constructor(readonly code: QuickloginQuotaAdminErrorCode) {
    super(code);
    this.name = "QuickloginQuotaAdminError";
  }
}

export function isQuickloginPolicyItem(item: Pick<
  EntitlementItem,
  "subsystem" | "capability"
>): boolean {
  const key = `${item.subsystem}.${item.capability}`;
  return key === DEVICE_LIMIT_KEY || key === MASTER_KEY;
}

export function assertGenericEntitlementWriteAllowed(
  incoming: EntitlementItem[]
): void {
  if (incoming.some(isQuickloginPolicyItem)) {
    throw new QuickloginQuotaAdminError("QUICKLOGIN_PREVIEW_REQUIRED");
  }
}

export async function routeQuickloginEntitlementWrite(input: {
  userId: string;
  actorId: string;
  items: EntitlementItem[];
  previewToken?: string;
  now: number;
  coordinator: QuickloginQuotaCoordinator;
}): Promise<
  | { kind: "preview"; preview: QuotaPreview }
  | { kind: "applied"; list: DeviceList }
> {
  if (!input.userId || !input.actorId) {
    throw new QuickloginQuotaAdminError("FORBIDDEN");
  }
  const item = input.items[0];
  if (
    input.items.length !== 1 ||
    !item ||
    `${item.subsystem}.${item.capability}` !== DEVICE_LIMIT_KEY ||
    !/^\d+$/.test(item.value)
  ) {
    throw new QuickloginQuotaAdminError("INVALID_REQUEST");
  }

  let limit: number;
  try {
    limit = validateDeviceLimit(Number(item.value));
  } catch {
    throw new QuickloginQuotaAdminError("INVALID_REQUEST");
  }

  if (!input.previewToken) {
    return {
      kind: "preview",
      preview: await input.coordinator.previewQuota(input.userId, limit, input.now),
    };
  }

  return {
    kind: "applied",
    list: await input.coordinator.applyQuota(
      input.userId,
      { token: input.previewToken, newLimit: limit },
      input.now
    ),
  };
}
