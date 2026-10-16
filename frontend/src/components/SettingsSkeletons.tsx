import { Button, Skeleton } from "@cqu-moe/ui";
import SettingsCard from "./SettingsCard";
import "./quicklogin/DeviceList.css";

export function PasskeySkeleton() {
  return <div aria-busy="true">
    <span className="sr-only" role="status">正在读取 Passkey…</span>
    <div aria-hidden="true" className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <Skeleton className="size-5 shrink-0" /><Skeleton className="h-5 w-40 max-w-full" />
      </div>
      <div className="flex shrink-0 gap-2 self-end sm:self-auto">
        {["重命名", "删除"].map(label => <Button key={label} type="button" variant="ghost" size="sm" className="min-h-11" disabled><Skeleton><span className="invisible">{label}</span></Skeleton></Button>)}
      </div>
    </div>
  </div>;
}

export function CquBindingSkeleton() {
  return <div aria-busy="true">
    <span className="sr-only" role="status">正在读取 CQU 绑定状态…</span>
    <div className="space-y-5" aria-hidden="true">
      <div className="flex flex-col divide-y divide-border">
        <div className="flex flex-wrap items-center justify-between gap-2 py-3">
          <span className="text-sm text-muted-foreground">统一身份认证账号</span><Skeleton className="h-5 w-24" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 py-3">
          <span className="text-sm text-muted-foreground">Auth 服务端会话</span><span className="badge badge-muted"><Skeleton><span className="invisible">正常</span></Skeleton></span>
        </div>
        <div className="py-4">
          <div className="mb-2">
            <p className="text-sm font-medium text-foreground">专属密保邮箱</p>
            <p className="mt-0.5 text-xs text-muted-foreground">需将此地址设置为 CQU 自服务中心的密保邮箱，系统才能自动接收 2FA 验证码。</p>
          </div>
          <div className="flex min-h-10 flex-wrap items-center gap-3 sm:min-h-0"><Skeleton className="h-5 min-w-0 flex-1" /><Button type="button" variant="outline" size="sm" disabled><Skeleton><span className="invisible">复制</span></Skeleton></Button></div>
        </div>
      </div>
      <div className="rounded-lg border border-border px-4 py-3"><Skeleton className="h-5 w-24" /></div>
      <div className="flex flex-wrap gap-2 sm:gap-3">{["重新绑定邮箱", "重新设置密码", "解除绑定"].map(label => <Button key={label} type="button" variant="outline" size="sm" className="min-h-11" disabled><Skeleton><span className="invisible">{label}</span></Skeleton></Button>)}</div>
    </div>
  </div>;
}

export function QuickloginSkeleton() {
  return <div aria-busy="true">
    <span className="sr-only" role="status">正在读取快捷登录设备…</span>
    <ul aria-hidden="true" className="divide-y divide-border">
      <li className="quicklogin-device">
        <div className="quicklogin-device-info">
          <Skeleton className="h-5 w-36 max-w-full" />
          <Skeleton className="mt-1 h-5 w-48 max-w-full" />
          <Skeleton className="mt-1 h-4 w-60 max-w-full" />
        </div>
        <Skeleton className="quicklogin-device-menu size-11" />
      </li>
    </ul>
  </div>;
}

export function AccountSkeleton() {
  return <SettingsCard title="个人信息">
    <div className="divide-y divide-border" aria-hidden="true">
      {["昵称", "邮箱"].map((label, index) => <div key={label} className={`flex items-center gap-4 ${index ? "pt-4" : "pb-4"}`}>
        <span className="w-16 shrink-0 text-sm text-muted-foreground">{label}</span>
        <Skeleton className="h-5 min-w-0 flex-1" /><Skeleton className="h-8 w-14" />
      </div>)}
    </div>
  </SettingsCard>;
}
