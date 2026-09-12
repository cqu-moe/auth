import { useState, ReactNode, useEffect, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
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
// DO /status 返回的会话状态对象（active/relogin_required/... + studentId）；
// 后端在 DO 非 2xx 或解析失败时回传 { error: true } sentinel。
interface CquSessionStatus {
  status?: string;
  studentId?: string;
  error?: boolean;
}

// GET /api/v1/cqu/binding 的响应形状。
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
  // 用 ref 持有最新 onExpire，避免 callback identity 变化重置 expiredFiredRef
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
  }, [deadline]); // onExpire 通过 ref 访问，不需要列为 dep

  const expired = secondsLeft <= 0;
  const m = Math.floor(secondsLeft / 60);
  const s = secondsLeft % 60;
  const countdown = `${m}:${s.toString().padStart(2, "0")}`;

  if (expired) {
    return (
      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-400">
        可能已过期
      </span>
    );
  }

  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
      secondsLeft <= 60 ? "bg-red-100 text-red-600" : "bg-blue-100 text-blue-700"
    }`}>
      {countdown}
    </span>
  );
}

let liveCodeIdCounter = 0;

const MAX_RETRIES = 5;

function LiveCodeSection() {
  const [open, setOpen] = useState(false);
  const [wsState, setWsState] = useState<WsState>("idle");
  const [codes, setCodes] = useState<LiveCode[]>([]);
  const [connectionKey, setConnectionKey] = useState(0);

  const connectionRef = useRef<{ close(): void } | null>(null);
  const openRef = useRef(false);

  // Keep openRef in sync so WS close handler can check whether to reconnect
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

  // 稳定引用：避免 onExpire 每轮渲染变化导致 CodeCountdown 的 expiredFiredRef 被重置
  const markExpired = useCallback((id: number) => {
    setCodes((prev) =>
      prev.map((c) => (c.id === id ? { ...c, expired: true } : c))
    );
  }, []);

  const typeLabelMap: Record<LiveCode["type"], string> = {
    login_2fa: "登录码",
    bind_code: "绑定码",
  };

  const typeBadgeClass: Record<LiveCode["type"], string> = {
    login_2fa: "bg-indigo-100 text-indigo-700",
    bind_code: "bg-blue-100 text-blue-700",
  };

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      {/* ── Collapsible header ─────────────────────────────────────────────── */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-gray-50"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <span className="text-sm font-semibold text-gray-900">实时验证码</span>
          {open && wsState === "open" && (
            <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" aria-hidden="true" />
          )}
        </div>
        <svg
          className={`h-4 w-4 text-gray-400 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* ── Collapsible body ───────────────────────────────────────────────── */}
      {open && (
        <div className="space-y-4 border-t border-gray-100 px-4 pb-4 pt-3">
          {/* WS connection status */}
          <div className={`flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-lg ${
            wsState === "open"
              ? "bg-green-50 text-green-700"
              : wsState === "connecting"
              ? "bg-blue-50 text-blue-600"
              : wsState === "error" || wsState === "closed"
              ? "bg-yellow-50 text-yellow-700"
              : wsState === "failed"
              ? "bg-red-50 text-red-700"
              : "bg-gray-50 text-gray-500"
          }`}>
            {wsState === "open" && (
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            )}
            {wsState === "connecting" && (
              <span className="w-3.5 h-3.5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            )}
            {(wsState === "closed" || wsState === "error") && (
              <span className="w-3.5 h-3.5 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin" />
            )}
            {wsState === "failed" && (
              <span className="w-3.5 h-3.5 text-red-500" aria-hidden="true">✕</span>
            )}
            {wsState === "open" && "实时监听中，验证码到达将立即显示"}
            {wsState === "connecting" && "正在建立连接…"}
            {wsState === "closed" && "连接中断，正在重连…"}
            {wsState === "error" && "连接出错，正在重连…"}
            {wsState === "idle" && "准备连接…"}
            {wsState === "failed" && (
              <>
                <span>连接多次失败，请检查网络或登录状态</span>
                <button
                  type="button"
                  onClick={() => setConnectionKey((key) => key + 1)}
                  className="ml-auto shrink-0 px-2 py-0.5 rounded border border-red-300 bg-white text-red-600 hover:bg-red-50 transition-colors"
                >
                  重试
                </button>
              </>
            )}
          </div>

          {/* Code list or empty hint */}
          {codes.length === 0 ? (
            <div className="p-6 border-2 border-dashed border-gray-200 rounded-xl text-center">
              <svg className="w-8 h-8 text-gray-300 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              <p className="text-sm text-gray-400 leading-relaxed">
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
                    className={`p-4 rounded-xl border-2 ${
                      expired ? "border-gray-200 bg-gray-50" : "border-blue-200 bg-blue-50"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${typeBadgeClass[item.type]}`}>
                          {typeLabelMap[item.type]}
                        </span>
                        <span className="text-xs text-gray-400">{formatTime(item.ts)}</span>
                      </div>
                      <CodeCountdown
                        deadline={item.deadline}
                        onExpire={() => markExpired(item.id)}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <span className={`font-mono text-3xl font-bold tracking-[0.25em] ${
                        expired ? "text-gray-400" : "text-blue-900"
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

          <p className="text-xs text-gray-400">
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

  // ── Loading skeleton ────────────────────────────────────────────────────────
  if (statusLoading) {
    return (
      <SettingsCard title="CQU 账户绑定">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-transparent" />
          加载中...
        </div>
      </SettingsCard>
    );
  }

  // ── Status fetch error ──────────────────────────────────────────────────────
  if (statusError) {
    return (
      <SettingsCard title="CQU 账户绑定">
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
          获取绑定状态失败，请稍后重试。
        </div>
        <button
          type="button"
          onClick={() => void fetchStatus()}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
        >
          重新加载
        </button>
      </SettingsCard>
    );
  }

  const isBound = status != null && status.bindStatus !== "unbound";
  const hasSessionError = status?.sessionStatus?.error === true;
  const sessionActive = !hasSessionError && status?.sessionStatus?.status === "active";
  const studentId = status?.sessionStatus?.studentId;

  // Session status badge
  type BadgeVariant = "green" | "yellow" | "gray";
  const sessionBadge: { label: string; variant: BadgeVariant } = hasSessionError
    ? { label: "状态未知", variant: "gray" }
    : sessionActive
    ? { label: "正常", variant: "green" }
    : { label: "需要重新登录", variant: "yellow" };

  const badgeClasses: Record<BadgeVariant, { pill: string; dot: string }> = {
    green: { pill: "bg-green-100 text-green-700", dot: "bg-green-500" },
    yellow: { pill: "bg-yellow-100 text-yellow-700", dot: "bg-yellow-500" },
    gray: { pill: "bg-gray-100 text-gray-500", dot: "bg-gray-400" },
  };

  return (
    <SettingsCard title="CQU 账户绑定" description="绑定后由系统代你维护与重庆大学统一认证的会话。">

      {/* Action feedback */}
      {actionError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
          {actionError}
        </div>
      )}
      {actionSuccess && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700" role="status">
          {actionSuccess}
        </div>
      )}

      {isBound ? (
        <div className="space-y-5">
          {/* ── Bound info card ─────────────────────────────────────────────── */}
          <div className="flex flex-col gap-0 divide-y divide-gray-100 rounded-xl border border-gray-200">
            {/* Student ID row */}
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-gray-500">统一身份认证账号</span>
              <span className="text-sm font-medium tabular-nums text-gray-900">{studentId ?? "—"}</span>
            </div>

            {/* Session status row */}
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-gray-500">会话状态</span>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${badgeClasses[sessionBadge.variant].pill}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${badgeClasses[sessionBadge.variant].dot}`} />
                {sessionBadge.label}
              </span>
            </div>

            {/* Dedicated inbox address — given extra prominence */}
            {status?.address && (
              <div className="bg-blue-50/70 px-4 py-4">
                <div className="mb-2 flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-blue-700">专属密保邮箱</p>
                    <p className="mt-0.5 text-xs text-blue-600">
                      需将此地址设置为 CQU 自服务中心的密保邮箱，系统才能自动接收 2FA 验证码。
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 flex-1 break-all font-mono text-sm font-semibold text-blue-900">
                    {status.address}
                  </span>
                  <CopyButton text={status.address} />
                </div>
              </div>
            )}
          </div>

          {/* ── 实时验证码 — 仅 active 时显示 ─────────────────────────────────── */}
          {status?.bindStatus === "active" && <LiveCodeSection />}

          {/* ── Action buttons ───────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/cqu/bind"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
            >
              绑定新账号
            </Link>
            <button
              type="button"
              onClick={() => void handleUnbind()}
              disabled={unbindLoading}
              className="px-4 py-2 border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50 text-sm font-medium rounded-lg transition-colors flex items-center gap-2"
            >
              {unbindLoading && (
                <span className="w-4 h-4 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
              )}
              {unbindLoading ? "解绑中..." : "解除绑定"}
            </button>
          </div>
        </div>
      ) : (
        /* ── Unbound state ────────────────────────────────────────────────── */
        <div className="space-y-4">
          <p className="text-sm text-gray-500">
            绑定 CQU 账户后，系统将代您持续维护与重庆大学统一认证（CAS）的会话，让第三方应用能以您的身份安全访问教务、图书馆等 CQU 系统。
          </p>
          <Link
            to="/cqu/bind"
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
            绑定 CQU 账户
          </Link>
        </div>
      )}
    </SettingsCard>
  );
}

export default function Settings() {
  const { data: session, refetch: refetchSession } = authClient.useSession();
  const user = session?.user as { email?: string; name?: string; createdAt?: string; twoFactorEnabled?: boolean } | undefined;

  return (
    <Layout>
      <div className="max-w-3xl">
        <h1 className="text-2xl font-bold text-gray-900">账户设置</h1>
        <p className="mt-1 text-sm text-gray-500">管理账户信息、安全设置与 CQU 服务集成。</p>

        <div className="mt-8 space-y-10">
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
            {/* CQU 绑定 */}
            <CquBindingSection />

            <QuickloginSettings
              currentDeviceHint={
                new URLSearchParams(window.location.search).get("quickloginDevice") ?? undefined
              }
            />
          </SettingsGroup>
        </div>
      </div>
    </Layout>
  );
}

function SettingsGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label}>
      <h2 className="mb-3 px-1 text-xs font-semibold uppercase tracking-widest text-gray-400">
        {label}
      </h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}
