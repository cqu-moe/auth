import type { DeviceRecord } from "./contracts";

export function validateDeviceLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("INVALID_REQUEST");
  }
  return value;
}

function compareNullableDescending(
  left: number | null,
  right: number | null
): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

export function selectQuotaDevices(
  devices: DeviceRecord[],
  limit: number
): { kept: string[]; disabled: string[] } {
  validateDeviceLimit(limit);

  const eligible = devices
    .filter((device) => device.enabled && device.revokedAt === null)
    .slice()
    .sort((left, right) => {
      const byLastSeen = compareNullableDescending(
        left.lastSeenAt,
        right.lastSeenAt
      );
      if (byLastSeen !== 0) return byLastSeen;

      const byEnabledAt = compareNullableDescending(
        left.enabledAt,
        right.enabledAt
      );
      if (byEnabledAt !== 0) return byEnabledAt;

      if (left.deviceId < right.deviceId) return -1;
      if (left.deviceId > right.deviceId) return 1;
      return 0;
    });

  return {
    kept: eligible.slice(0, limit).map((device) => device.deviceId),
    disabled: eligible.slice(limit).map((device) => device.deviceId),
  };
}
