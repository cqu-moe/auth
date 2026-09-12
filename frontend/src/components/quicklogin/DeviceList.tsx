import type { DeviceListData } from "../../lib/api/quicklogin";
import { isDeviceOnline, QUICKLOGIN_REVOKE_WARNING } from "./device-list";

function fullTime(value: number | null): string {
  return value === null ? "从未联系" : new Date(value).toLocaleString("zh-CN");
}

export default function DeviceList({
  data,
  currentDeviceHint,
  busy = false,
  revokingDeviceId,
  onRevoke,
}: {
  data: DeviceListData;
  currentDeviceHint?: string;
  busy?: boolean;
  revokingDeviceId?: string | null;
  onRevoke: (id: string) => Promise<void>;
}) {
  const devices = data.devices.filter((device) => device.revokedAt === null);
  if (devices.length === 0) {
    return (
      <div className="py-3 text-sm text-gray-500">
        <p className="font-medium text-gray-800">还没有授权的浏览器</p>
        <p className="mt-1">安装插件并登录 Auth 后，设备会出现在这里。</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-gray-500">
        在线状态根据最近联系时间估计。{QUICKLOGIN_REVOKE_WARNING}
      </p>
      <ul className="divide-y divide-gray-100 rounded-xl border border-gray-950/[0.08]">
        {devices.map((device) => {
          const online = isDeviceOnline(device.lastSeenAt);
          const revoking = revokingDeviceId === device.deviceId;
          return (
            <li
              key={device.deviceId}
              className="flex flex-wrap items-start gap-3 px-4 py-3 sm:flex-nowrap"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p className="break-words text-sm font-medium text-gray-900">
                    {device.deviceName}
                  </p>
                  {currentDeviceHint === device.deviceId && (
                    <span className="text-xs font-medium text-blue-700">当前插件</span>
                  )}
                  <span className={online ? "text-xs text-green-700" : "text-xs text-gray-500"}>
                    {online ? "在线" : "离线"}
                  </span>
                </div>
                <p className="mt-1 break-words text-xs text-gray-500">
                  Chrome {device.browserVersion} · 最近 IP：{device.lastIp ?? "暂无"}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-gray-500">
                  最近联系：
                  <time dateTime={device.lastSeenAt === null
                    ? undefined
                    : new Date(device.lastSeenAt).toISOString()}
                  >
                    {fullTime(device.lastSeenAt)}
                  </time>
                  {device.disabledReason === "quota_reduced" && " · 因额度调整停用"}
                  {device.disabledReason === "user" && " · 已在插件中关闭"}
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(QUICKLOGIN_REVOKE_WARNING)) {
                    void onRevoke(device.deviceId);
                  }
                }}
                className="min-h-11 shrink-0 rounded-lg border border-red-200 px-3 text-sm font-medium text-red-700 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:border-gray-200 disabled:text-gray-400"
              >
                {revoking ? "正在退出…" : "退出设备"}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
