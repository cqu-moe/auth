import {
  derivePresentation,
  type ActionCode,
  type Overview,
} from "../../lib/api/quicklogin-protocol.generated";
import {
  ActionButton,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cqu-moe/ui";
import { Ellipsis, LogOut, RefreshCw } from "lucide-react";
import "./DeviceList.css";
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
    <ul aria-label="快捷登录设备" className="divide-y divide-border">
      {data.devices.map((device) => {
        const presentation = derivePresentation(device, unreachable ? { observation: "unreachable" } : {});
        const id = device.identity.deviceId;
        const client = device.reportedLocal?.client;
        const revoked = device.authorization.state === "revoked";
        const name = device.identity.deviceName?.trim() || "未命名浏览器";
        const reconnecting = reconnectingDeviceId === id;
        const revoking = revokingDeviceId === id;
        const title = presentation.statusCode === "disabled" ? "此设备已关闭快捷登录" : presentation.statusCode === "syncing" && !device.reportedLocal
          ? "等待插件同步" : presentation.title;

        return (
          <li key={id} className="quicklogin-device" aria-busy={reconnecting || revoking}>
            <div className="quicklogin-device-info">
              <div className="flex flex-wrap items-center gap-2">
                <span className="quicklogin-device-name text-sm font-medium text-foreground">
                  {name}
                </span>
                {currentDeviceHint === id && (
                  <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">当前插件</span>
                )}
              </div>
              <div className={`mt-1 text-sm ${presentation.statusCode === "ready" ? "text-success" : "text-muted-foreground"}`}>
                {revoking ? "正在退出设备…" : title}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {presentation.actionCode === "complete_verification"
                  ? "请在对应设备的插件中选择「前往学校手动登录」，完成本次验证。"
                  : presentation.detail}
              </p>
              <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                {client && `插件 ${client.extensionVersion} · `}
                最近联系：
                <time dateTime={device.presence.lastSeenAt === null
                  ? undefined : new Date(device.presence.lastSeenAt).toISOString()}>
                  {contactTime(device.presence.lastSeenAt)}
                </time>
              </p>
            </div>
            <div className="quicklogin-device-action">
              {presentation.actionCode === "connect_auth" || reconnectDeviceHint === id ? (
                <ActionButton
                  type="button"
                  variant="outline"
                  state={reconnecting ? "loading" : "idle"}
                  labels={{ idle: "重新连接", loading: "正在连接…", success: "已连接", error: "重新连接" }}
                  disabled={busy && !reconnecting}
                  onClick={() => void onReconnect(id)}
                />
              ) : presentation.actionTarget && actionLabels[presentation.actionCode] ? (
                <Button asChild variant="outline" size="default">
                  <a href={presentation.actionTarget}>
                    {actionLabels[presentation.actionCode]}
                  </a>
                </Button>
              ) : presentation.actionCode === "reconcile" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="default"
                  disabled={busy}
                  onClick={() => void onRefresh()}
                >
                  <RefreshCw aria-hidden="true" className="size-4" />
                  重新检查
                </Button>
              ) : null}
            </div>
            {!revoked && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="quicklogin-device-menu min-h-11 min-w-11 text-muted-foreground"
                    aria-label={`${name}的更多操作`}
                    disabled={busy}
                  >
                    <Ellipsis aria-hidden="true" className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    variant="destructive"
                    className="min-h-11"
                    disabled={busy}
                    onSelect={() => {
                      if (window.confirm(QUICKLOGIN_REVOKE_WARNING)) void onRevoke(id);
                    }}
                  >
                    <LogOut aria-hidden="true" className="size-4" />
                    退出设备
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </li>
        );
      })}
    </ul>
  );
}
