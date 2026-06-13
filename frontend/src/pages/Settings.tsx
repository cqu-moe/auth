import { useState, FormEvent, useEffect, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import { authClient } from "../lib/auth-client";
import Layout from "../components/Layout";

// DO /status 返回的会话状态对象（active/relogin_required/... + studentId）；
// 后端在 DO 非 2xx 或解析失败时回传 { error: true } sentinel。
interface CquSessionStatus {
  status?: string;
  studentId?: string;
  error?: boolean;
}

// GET /api/cqu/binding 的响应形状。
interface CquBindStatus {
  address?: string;
  bindStatus: "pending" | "active" | "revoked" | "unbound";
  sessionStatus: CquSessionStatus;
}

function ChangePasswordSection() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess(false);

    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      return;
    }

    if (newPassword.length < 8) {
      setError("新密码至少需要 8 个字符");
      return;
    }

    setLoading(true);
    const { error } = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: false,
    });
    setLoading(false);

    if (error) {
      setError(error.message ?? "修改失败，请检查当前密码是否正确");
    } else {
      setSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <h3 className="text-base font-semibold text-gray-900 mb-4">修改密码</h3>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
          密码已成功修改
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="currentPassword" className="block text-sm font-medium text-gray-700 mb-1">
            当前密码
          </label>
          <input
            id="currentPassword"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            autoComplete="current-password"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        <div>
          <label htmlFor="newPassword" className="block text-sm font-medium text-gray-700 mb-1">
            新密码
          </label>
          <input
            id="newPassword"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            autoComplete="new-password"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="至少 8 个字符"
          />
        </div>

        <div>
          <label htmlFor="confirmNewPassword" className="block text-sm font-medium text-gray-700 mb-1">
            确认新密码
          </label>
          <input
            id="confirmNewPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            autoComplete="new-password"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2"
        >
          {loading && (
            <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          )}
          {loading ? "保存中..." : "保存修改"}
        </button>
      </form>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback: select + execCommand
      const el = document.createElement("textarea");
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors flex-shrink-0"
      aria-label="复制到剪贴板"
    >
      {copied ? (
        <>
          <svg className="w-3.5 h-3.5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          已复制
        </>
      ) : (
        <>
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          复制
        </>
      )}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LiveCodeSection — 实时验证码面板（仅 bindStatus === "active" 时渲染）
// ─────────────────────────────────────────────────────────────────────────────

type WsState = "idle" | "connecting" | "open" | "closed" | "error" | "failed";

interface LiveCode {
  id: number;
  type: "login_2fa" | "bind_code";
  code: string;
  ts: number;        // 原始收码时刻，仅用于「到达时间」展示
  deadline: number;  // Date.now() + remainingMs，本地时钟 deadline，用于倒计时
  expired?: boolean;
}

function buildWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/cqu/binding/events`;
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

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(false);
  const openRef = useRef(false);
  const retryCountRef = useRef(0);

  // Keep openRef in sync so WS close handler can check whether to reconnect
  openRef.current = open;

  const connect = useCallback(() => {
    if (!mountedRef.current || !openRef.current) return;
    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    setWsState("connecting");
    const ws = new WebSocket(buildWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      retryCountRef.current = 0; // 连接成功 → 清零重试计数
      setWsState("open");
      // keepalive：每 30s 发一次 ping，防止代理/CF 因空闲断连
      if (pingTimer.current) clearInterval(pingTimer.current);
      pingTimer.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("ping");
        }
      }, 30000);
    };

    ws.onmessage = (evt) => {
      if (!mountedRef.current) return;
      // 服务端 keepalive pong（非 JSON），直接忽略
      if (evt.data === "pong") return;
      try {
        const msg = JSON.parse(evt.data as string) as {
          type: string;
          code?: string;
          ts?: number;
          remainingMs?: number;
        };
        if (
          (msg.type === "login_2fa" || msg.type === "bind_code") &&
          msg.code
        ) {
          const deadline = Date.now() + (typeof msg.remainingMs === "number" ? msg.remainingMs : 600000);
          const entry: LiveCode = {
            id: ++liveCodeIdCounter,
            type: msg.type as "login_2fa" | "bind_code",
            code: msg.code,
            ts: msg.ts ?? Date.now(),
            deadline,
          };
          // 去重：已有相同 code 的卡不再新增（回放/重连不堆重复卡）
          setCodes((prev) => {
            if (prev.some((c) => c.code === entry.code)) return prev;
            return [entry, ...prev].slice(0, 3);
          });
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (pingTimer.current) { clearInterval(pingTimer.current); pingTimer.current = null; }
      if (!mountedRef.current) return;
      if (!openRef.current) return;
      // 面板仍展开 → 有限重试（上限 MAX_RETRIES 次）
      if (retryCountRef.current < MAX_RETRIES) {
        retryCountRef.current += 1;
        setWsState("closed");
        reconnectTimer.current = setTimeout(() => {
          if (mountedRef.current && openRef.current) connect();
        }, 3000);
      } else {
        // 超过上限 → 终态，停止重连
        setWsState("failed");
      }
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      setWsState("error");
      ws.close();
    };
  }, []); // stable — reads state only via refs

  // 展开时建立连接，折叠时关闭
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (open) {
      connect();
    } else {
      // 折叠 → 关闭 WS、重连定时器、ping 定时器，清零重试计数
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      if (pingTimer.current) {
        clearInterval(pingTimer.current);
        pingTimer.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
      retryCountRef.current = 0;
      setWsState("idle");
    }
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (pingTimer.current) { clearInterval(pingTimer.current); pingTimer.current = null; }
      wsRef.current?.close();
      retryCountRef.current = 0;
    };
  }, [open, connect]);

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
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
      {/* ── Collapsible header ─────────────────────────────────────────────── */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-gray-50 transition-colors"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <span className="text-base font-semibold text-gray-900">实时验证码</span>
          {open && wsState === "open" && (
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" aria-hidden="true" />
          )}
        </div>
        <svg
          className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
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
        <div className="border-t border-gray-100 px-6 pb-6 pt-4 space-y-4">
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
                  onClick={() => {
                    retryCountRef.current = 0;
                    connect();
                  }}
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
      const res = await fetch("/api/cqu/binding", { credentials: "include" });
      if (res.ok) {
        const data = await res.json() as CquBindStatus;
        setStatus(data);
      } else {
        setStatusError(true);
      }
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
      const res = await fetch("/api/cqu/binding", {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        setActionSuccess("已成功解除 CQU 账户绑定");
        await fetchStatus();
      } else {
        const data = await res.json().catch(() => ({})) as {
          detail?: { error?: { message?: string } };
        };
        setActionError(data.detail?.error?.message ?? "解绑失败，请稍后重试");
      }
    } catch {
      setActionError("请求失败，请检查网络连接后重试");
    } finally {
      setUnbindLoading(false);
    }
  };

  // ── Loading skeleton ────────────────────────────────────────────────────────
  if (statusLoading) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h3 className="text-base font-semibold text-gray-900 mb-4">CQU 账户绑定</h3>
        <div className="flex items-center gap-2 text-gray-400 text-sm">
          <span className="w-4 h-4 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
          加载中...
        </div>
      </div>
    );
  }

  // ── Status fetch error ──────────────────────────────────────────────────────
  if (statusError) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h3 className="text-base font-semibold text-gray-900 mb-4">CQU 账户绑定</h3>
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 mb-4">
          获取绑定状态失败，请稍后重试。
        </div>
        <button
          type="button"
          onClick={() => void fetchStatus()}
          className="px-4 py-2 border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm font-medium rounded-lg transition-colors"
        >
          重新加载
        </button>
      </div>
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
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <h3 className="text-base font-semibold text-gray-900 mb-4">CQU 账户绑定</h3>

      {/* Action feedback */}
      {actionError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {actionError}
        </div>
      )}
      {actionSuccess && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
          {actionSuccess}
        </div>
      )}

      {isBound ? (
        <div className="space-y-5">
          {/* ── Bound info card ─────────────────────────────────────────────── */}
          <div className="flex flex-col gap-0 divide-y divide-gray-100 border border-gray-200 rounded-xl overflow-hidden">
            {/* Student ID row */}
            <div className="flex items-center justify-between px-4 py-3 bg-gray-50">
              <span className="text-sm text-gray-500">统一身份认证账号</span>
              <span className="text-sm font-medium text-gray-900">{studentId ?? "—"}</span>
            </div>

            {/* Session status row */}
            <div className="flex items-center justify-between px-4 py-3 bg-gray-50">
              <span className="text-sm text-gray-500">会话状态</span>
              <span
                className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-0.5 rounded-full ${badgeClasses[sessionBadge.variant].pill}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${badgeClasses[sessionBadge.variant].dot}`} />
                {sessionBadge.label}
              </span>
            </div>

            {/* Dedicated inbox address — given extra prominence */}
            {status?.address && (
              <div className="px-4 py-4 bg-blue-50">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div>
                    <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide">专属密保邮箱</p>
                    <p className="mt-0.5 text-xs text-blue-600">
                      需将此地址设置为 CQU 自服务中心的密保邮箱，系统才能自动接收 2FA 验证码。
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="font-mono text-sm font-semibold text-blue-900 break-all flex-1 min-w-0">
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
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
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
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
            绑定 CQU 账户
          </Link>
        </div>
      )}
    </div>
  );
}

export default function Settings() {
  const { data: session } = authClient.useSession();
  const user = session?.user as { email?: string; name?: string; createdAt?: string } | undefined;

  return (
    <Layout>
      <div className="max-w-2xl">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">账户设置</h1>

        <div className="space-y-6">
          {/* 个人信息 */}
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <h3 className="text-base font-semibold text-gray-900 mb-4">个人信息</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between py-2 border-b border-gray-100">
                <span className="text-sm text-gray-500">昵称</span>
                <span className="text-sm font-medium text-gray-900">{user?.name ?? "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-sm text-gray-500">邮箱</span>
                <span className="text-sm font-medium text-gray-900">{user?.email ?? "—"}</span>
              </div>
            </div>
          </div>

          {/* 修改密码 */}
          <ChangePasswordSection />

          {/* CQU 绑定 */}
          <CquBindingSection />
        </div>
      </div>
    </Layout>
  );
}
