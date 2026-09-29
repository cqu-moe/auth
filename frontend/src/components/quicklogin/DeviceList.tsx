import {
  derivePresentation,
  type ActionCode,
  type Overview,
} from "../../lib/api/quicklogin-protocol.generated";
import { Button } from "@cqu-moe/ui";
import { QUICKLOGIN_REVOKE_WARNING } from "./device-list";

function contactTime(value: number | null): string {
  return value === null ? "从未联系" : new Date(value).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

const actionLabels: Partial<Record<ActionCode, string>> = {
  bind_school: "绑定学校账号",
  update_password: "更新学校密码",
  open_auth: "查看总开关",
  manage_devices: "管理设备",
};

export default function DeviceList({
  data,
  currentDeviceHint,
  reconnectDeviceHint,
  busy = false,
  revokingDeviceId,
  reconnectingDeviceId,
  unreachable = false,
  onRevoke,
  onReconnect,
  onRefresh,
}: {
  data: Overview;
  currentDeviceHint?: string;
  reconnectDeviceHint?: string;
  busy?: boolean;
  revokingDeviceId?: string | null;
  reconnectingDeviceId?: string | null;
  unreachable?: boolean;
  onRevoke: (id: string) => Promise<void>;
  onReconnect: (id: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  if (data.devices.length === 0) return (
    <div className="py-3 text-sm text-muted-foreground">
      <p className="font-medium text-foreground">还没有授权的浏览器</p>
      <p className="mt-1">安装插件并登录 Auth 后，设备会出现在这里。</p>
    </div>
  );

  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {data.devices.map((device) => {
        const presentation = derivePresentation(device, unreachable ? { observation: "unreachable" } : {});
        const id = device.identity.deviceId;
        const client = device.reportedLocal?.client;
        const revoked = device.authorization.state === "revoked";
        const title = presentation.actionCode === "complete_verification" ? "需手动登录" : presentation.statusCode === "syncing" && !device.reportedLocal
          ? "等待插件同步" : presentation.title;

        return (
          <li key={id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="break-words text-sm font-medium text-foreground">
                  {device.identity.deviceName ?? "未命名浏览器"}
                </span>
                {currentDeviceHint === id && (
                  <span className="badge badge-info">当前插件</span>
                )}
                <span className={`text-xs ${presentation.statusCode === "ready" ? "text-success" : "text-muted-foreground"}`}>
                  {title}
                </span>
              </div>
              <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                {client && `插件 ${client.extensionVersion} · `}
                最近联系：
                <time dateTime={device.presence.lastSeenAt === null
                  ? undefined : new Date(device.presence.lastSeenAt).toISOString()}>
                  {contactTime(device.presence.lastSeenAt)}
                </time>
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2 sm:max-w-40">
              {presentation.actionCode === "connect_auth" || reconnectDeviceHint === id ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11"
                  disabled={busy}
                  onClick={() => void onReconnect(id)}
                >
                  {reconnectingDeviceId === id ? "正在连接…" : "重新连接"}
                </Button>
              ) : presentation.actionTarget && actionLabels[presentation.actionCode] ? (
                <Button asChild variant="outline" size="sm" className="min-h-11">
                  <a href={presentation.actionTarget}>
                    {actionLabels[presentation.actionCode]}
                  </a>
                </Button>
              ) : presentation.actionCode === "reconcile" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11"
                  disabled={busy}
                  onClick={() => void onRefresh()}
                >
                  重新检查
                </Button>
              ) : null}
              {!revoked && (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="min-h-11"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(QUICKLOGIN_REVOKE_WARNING)) void onRevoke(id);
                  }}
                >
                  {revokingDeviceId === id ? "正在退出…" : "退出设备"}
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
