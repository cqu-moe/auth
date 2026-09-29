import { useState, ReactNode, useEffect, useRef, useCallback } from "react";
import { Link, useLocation } from "react-router-dom";
import { ChevronDown, Link2, Loader2, Mail } from "lucide-react";
import { Alert, AlertDescription, Button, PageHeader, Skeleton } from "@cqu-moe/ui";
import { authClient } from "../lib/auth-client";
import {
  deleteBinding,
  getBinding,
} from "../lib/api/cqu";
import { openBindingEvents } from "../lib/api/binding-events";
import Layout from "../components/Layout";
import AccountProfileSection from "../components/AccountProfileSection";
import SecuritySection from "../components/SecuritySection";
import SettingsCard from "../components/SettingsCard";
import QuickloginSettings from "../components/quicklogin/QuickloginSettings";

import CopyButton from "../components/CopyButton";

interface CquSessionStatus {
  status?: string;
  studentId?: string;
  error?: boolean;
}

interface CquBindStatus {
  address?: string;
  bindStatus: "pending" | "active" | "revoked" | "unbound";
  sessionStatus: CquSessionStatus;
}

type WsState = "idle" | "connecting" | "open" | "closed" | "error" | "failed";

interface LiveCode {
  id: number;
  type: "login_2fa" | "bind_code";
  code: string;
  ts: number;
  deadline: number;
  expired?: boolean;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function CodeCountdown({ deadline, onExpire }: { deadline: number; onExpire?: () => void }) {
  const [secondsLeft, setSecondsLeft] = useState<number>(() =>
    Math.max(0, Math.round((deadline - Date.now()) / 1000))
  );
  const expiredFiredRef = useRef(false);
  const onExpireRef = useRef(onExpire);
  useEffect(() => { onExpireRef.current = onExpire; }, [onExpire]);

  useEffect(() => {
    expiredFiredRef.current = false;
    const update = () => {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0 && !expiredFiredRef.current) {
        expiredFiredRef.current = true;
        onExpireRef.current?.();
      }
    };
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [deadline]);

  const expired = secondsLeft <= 0;
  const m = Math.floor(secondsLeft / 60);
  const s = secondsLeft % 60;
  const countdown = `${m}:${s.toString().padStart(2, "0")}`;

  if (expired) {
    return <span className="badge badge-muted">可能已过期</span>;
  }

  return (
    <span className={`badge ${secondsLeft <= 60 ? "badge-warning" : "badge-info"}`}>
      {countdown}
    </span>
  );
}

let liveCodeIdCounter = 0;

const MAX_RETRIES = 5;

const wsStatusText: Record<WsState, string> = {
  idle: "准备连接…",
  connecting: "正在建立连接…",
  open: "实时监听中，验证码到达将立即显示",
  closed: "连接中断，正在重连…",
  error: "连接出错，正在重连…",
  failed: "连接多次失败，请检查网络或登录状态",
};

function LiveCodeSection() {
  const [open, setOpen] = useState(false);
  const [wsState, setWsState] = useState<WsState>("idle");
  const [codes, setCodes] = useState<LiveCode[]>([]);
  const [connectionKey, setConnectionKey] = useState(0);

  const connectionRef = useRef<{ close(): void } | null>(null);
  const openRef = useRef(false);

  openRef.current = open;

  useEffect(() => {
    connectionRef.current?.close();
    connectionRef.current = null;
    if (!open) {
      setWsState("idle");
      return;
    }
    connectionRef.current = openBindingEvents({
      onState: setWsState,
      shouldReconnect: () => openRef.current,
      retry: { delayMs: 3000, maxAttempts: MAX_RETRIES },
      heartbeatMs: 30000,
      onEvent: (msg) => {
        const deadline = Date.now() + (msg.remainingMs ?? 600000);
        const entry: LiveCode = {
          id: ++liveCodeIdCounter,
          type: msg.type,
          code: msg.code,
          ts: msg.ts ?? Date.now(),
          deadline,
        };
        setCodes((prev) => prev.some((code) => code.code === entry.code)
          ? prev
          : [entry, ...prev].slice(0, 3));
      },
    });
    return () => {
      connectionRef.current?.close();
      connectionRef.current = null;
    };
  }, [open, connectionKey]);

  const markExpired = useCallback((id: number) => {
    setCodes((prev) =>
      prev.map((c) => (c.id === id ? { ...c, expired: true } : c))
    );
  }, []);

  const typeLabelMap: Record<LiveCode["type"], string> = {
    login_2fa: "登录码",
    bind_code: "绑定码",
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-muted"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          <Mail className="text-muted-foreground" aria-hidden="true" size={16} />
          <span className="text-sm font-semibold text-foreground">实时验证码</span>
          {open && wsState === "open" && (
            <span className="h-2 w-2 animate-pulse rounded-full bg-success" aria-hidden="true" />
          )}
        </span>
        <ChevronDown
          className={`text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
          size={16}
        />
      </button>

      {open && (
        <div className="space-y-4 border-t border-border px-4 pb-4 pt-3">
          <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium ${
            wsState === "open"
              ? "bg-success/10 text-success"
              : wsState === "connecting"
              ? "bg-link/10 text-link"
              : wsState === "error" || wsState === "closed"
              ? "bg-warning/10 text-warning"
              : wsState === "failed"
              ? "bg-destructive/10 text-destructive"
              : "bg-muted text-muted-foreground"
          }`}>
            {wsState === "open" && (
              <span className="h-2 w-2 animate-pulse rounded-full bg-success" aria-hidden="true" />
            )}
            {wsState === "connecting" && (
              <Loader2 className="animate-spin" aria-hidden="true" size={14} />
            )}
            {(wsState === "closed" || wsState === "error") && (
              <Loader2 className="animate-spin" aria-hidden="true" size={14} />
            )}
            {wsState === "failed" && <span aria-hidden="true">✕</span>}
            <span>{wsStatusText[wsState]}</span>
            {wsState === "failed" && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="ml-auto shrink-0"
                onClick={() => setConnectionKey((key) => key + 1)}
              >
                重试
              </Button>
            )}
          </div>

          {codes.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center">
              <Mail className="mx-auto mb-2 text-muted-foreground/60" aria-hidden="true" size={32} />
              <p className="text-sm leading-relaxed text-muted-foreground">
                去 CQU 登录页选「邮箱验证码」登录，<br />验证码会实时显示在这里。
              </p>
            </div>
          ) : (
            <ul className="space-y-3" role="list" aria-label="验证码列表">
              {codes.map((item) => {
                const expired = !!item.expired;
                return (
                  <li
                    key={item.id}
                    className={`rounded-lg border p-4 ${
                      expired ? "border-border bg-muted" : "border-link/40 bg-link/10"
                    }`}
                  >
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="badge badge-info">{typeLabelMap[item.type]}</span>
                        <span className="text-xs text-muted-foreground">{formatTime(item.ts)}</span>
                      </div>
                      <CodeCountdown
                        deadline={item.deadline}
                        onExpire={() => markExpired(item.id)}
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <span className={`font-mono text-3xl font-bold tracking-widest ${
                        expired ? "text-muted-foreground" : "text-foreground"
                      }`}>
                        {item.code}
                      </span>
                      <CopyButton text={item.code} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="text-xs text-muted-foreground">
            最多显示最近 3 条；验证码自到达起约 10 分钟内有效。
          </p>
        </div>
      )}
    </div>
  );
}

function CquBindingSection() {
  const [status, setStatus] = useState<CquBindStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState(false);
  const [unbindLoading, setUnbindLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionSuccess, setActionSuccess] = useState("");

  const fetchStatus = async () => {
    setStatusLoading(true);
    setStatusError(false);
    try {
      setStatus(await getBinding() as CquBindStatus);
    } catch {
      setStatusError(true);
    } finally {
      setStatusLoading(false);
    }
  };

  useEffect(() => {
    void fetchStatus();
  }, []);

  const handleUnbind = async () => {
    if (
      !confirm(
        "确认解除 CQU 账户绑定？\n\n解绑后将删除保存的 CQU 凭证，系统将停止维护 CQU 会话，相关第三方应用将无法继续访问重庆大学服务。"
      )
    )
      return;

    setActionError("");
    setActionSuccess("");
    setUnbindLoading(true);

    try {
      await deleteBinding();
      setActionSuccess("已成功解除 CQU 账户绑定");
      await fetchStatus();
    } catch {
      setActionError("请求失败，请检查网络连接后重试");
    } finally {
      setUnbindLoading(false);
    }
  };

  if (statusLoading) {
    return (
      <SettingsCard title="CQU 账户绑定">
        <div className="space-y-3">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </SettingsCard>
    );
  }

  if (statusError) {
    return (
      <SettingsCard title="CQU 账户绑定">
        <div className="space-y-4">
          <Alert variant="destructive">
            <AlertDescription>获取绑定状态失败，请稍后重试。</AlertDescription>
          </Alert>
          <Button type="button" variant="outline" onClick={() => void fetchStatus()}>
            重新加载
          </Button>
        </div>
      </SettingsCard>
    );
  }

  const isBound = status != null && status.bindStatus !== "unbound";
  const hasSessionError = status?.sessionStatus?.error === true;
  const sessionActive = !hasSessionError && status?.sessionStatus?.status === "active";
  const studentId = status?.sessionStatus?.studentId;

  type BadgeVariant = "success" | "warning" | "muted";
  const sessionBadge: { label: string; variant: BadgeVariant } = hasSessionError
    ? { label: "状态未知", variant: "muted" }
    : sessionActive
    ? { label: "正常", variant: "success" }
    : { label: "需要重新登录", variant: "warning" };

  return (
    <SettingsCard title="CQU 账户绑定" description="绑定后由系统代你维护与重庆大学统一认证的会话。">
      {actionError && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}
      {actionSuccess && (
        <Alert className="mb-4 border-success/40 bg-success/10 text-success">
          <AlertDescription className="text-success">{actionSuccess}</AlertDescription>
        </Alert>
      )}

      {isBound ? (
        <div className="space-y-5">
          <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-muted-foreground">统一身份认证账号</span>
              <span className="text-sm font-medium tabular-nums text-foreground">{studentId ?? "—"}</span>
            </div>

            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-muted-foreground">Auth 服务端会话</span>
              <span className={`badge badge-${sessionBadge.variant}`}>
                <i aria-hidden="true" />
                {sessionBadge.label}
              </span>
            </div>

            {status?.address && (
              <div className="bg-link/10 px-4 py-4">
                <div className="mb-2 flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold tracking-wider text-link">专属密保邮箱</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      需将此地址设置为 CQU 自服务中心的密保邮箱，系统才能自动接收 2FA 验证码。
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 flex-1 break-all font-mono text-sm font-semibold text-foreground">
                    {status.address}
                  </span>
                  <CopyButton text={status.address} />
                </div>
              </div>
            )}
          </div>

          {status?.bindStatus === "active" && <LiveCodeSection />}

          <div
            className="flex flex-nowrap items-center gap-2 sm:gap-3"
            role="group"
            aria-label="CQU 绑定操作"
          >
            <Button asChild variant="outline" size="sm" className="min-h-11">
              <a
                href="https://self.cqu.edu.cn/cas-success/safe-center/email-bind-way/rebind"
                target="_blank"
                rel="noopener noreferrer"
              >
                重新绑定邮箱
                <span className="sr-only">（在新标签页打开）</span>
              </a>
            </Button>

            <Button asChild variant="outline" size="sm" className="min-h-11">
              <Link to="/cqu/bind?repair=1">重新设置密码</Link>
            </Button>

            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="min-h-11"
              onClick={() => void handleUnbind()}
              disabled={unbindLoading}
              aria-busy={unbindLoading}
            >
              {unbindLoading && <Loader2 className="animate-spin" aria-hidden="true" />}
              {unbindLoading ? "正在解除…" : "解除绑定"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            绑定 CQU 账户后，系统将代您持续维护与重庆大学统一认证（CAS）的会话，让第三方应用能以您的身份安全访问教务、图书馆等 CQU 系统。
          </p>
          <Button asChild>
            <Link to="/cqu/bind">
              <Link2 aria-hidden="true" />
              绑定 CQU 账户
            </Link>
          </Button>
        </div>
      )}
    </SettingsCard>
  );
}

export default function Settings() {
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  const cquAction = search.get("cqu");
  const currentDeviceHint = search.get("quickloginDevice") ?? undefined;
  const reconnectDeviceHint = search.get("quickloginReconnect") === "1" ? currentDeviceHint : undefined;
  const recovery = cquAction === "bind" ? { to: "/cqu/bind", label: "绑定学校账号" }
    : cquAction === "repair" ? { to: "/cqu/bind?repair=1", label: "更新学校密码" }
    : cquAction === "verify" ? { to: "/cqu/bind?repair=1", label: "完成学校验证" } : null;
  const { data: session, refetch: refetchSession } = authClient.useSession();
  const user = session?.user as { email?: string; name?: string; createdAt?: string; twoFactorEnabled?: boolean } | undefined;

  return (
    <Layout>
      <PageHeader
        title="账户设置"
        description="管理账户信息、安全设置与 CQU 服务集成。"
        actions={recovery ? (
          <Button asChild data-cqu-action>
            <Link to={recovery.to}>{recovery.label}</Link>
          </Button>
        ) : undefined}
      />

      <div className="space-y-10">
        <SettingsGroup label="账户">
          <AccountProfileSection
            name={user?.name ?? ""}
            email={user?.email ?? ""}
            onSessionRefresh={refetchSession}
          />
        </SettingsGroup>

        <SettingsGroup label="安全">
          <SecuritySection twoFactorEnabled={user?.twoFactorEnabled === true} />
        </SettingsGroup>

        <SettingsGroup label="CQU 集成">
          <CquBindingSection />

          <QuickloginSettings
            currentDeviceHint={currentDeviceHint}
            reconnectDeviceHint={reconnectDeviceHint}
          />
        </SettingsGroup>
      </div>
    </Layout>
  );
}

function SettingsGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label}>
      <h2 className="mb-3 px-1 text-xs font-semibold tracking-widest text-muted-foreground">
        {label}
      </h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}
