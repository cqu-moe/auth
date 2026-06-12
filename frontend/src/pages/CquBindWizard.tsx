import { useState, useEffect, useRef, useCallback, FormEvent } from "react";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

type Step = 1 | 2 | 3 | 4 | 5;

type WsState = "idle" | "connecting" | "open" | "closed" | "error";

interface BindAddressResponse {
  address: string;
  status: string;
}

interface BindStatusResponse {
  address?: string;
  bindStatus: "pending" | "active" | "revoked" | "unbound";
  sessionStatus: unknown;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function buildWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/cqu/bind/ws`;
}

// ────────────────────────────────────────────────────────────────────────────
// Shared UI atoms — matches existing app conventions exactly
// ────────────────────────────────────────────────────────────────────────────

function Spinner({ size = "md", color = "blue" }: { size?: "sm" | "md" | "lg"; color?: "blue" | "white" | "gray" }) {
  const sizeClass = size === "sm" ? "w-4 h-4 border-2" : size === "lg" ? "w-8 h-8 border-4" : "w-5 h-5 border-2";
  const colorClass =
    color === "white"
      ? "border-white border-t-transparent"
      : color === "gray"
      ? "border-gray-300 border-t-transparent"
      : "border-blue-600 border-t-transparent";
  return <span className={`${sizeClass} ${colorClass} rounded-full animate-spin inline-block`} />;
}

function AlertBox({ variant, children }: { variant: "error" | "success" | "info" | "warning"; children: React.ReactNode }) {
  const styles = {
    error: "bg-red-50 border-red-200 text-red-700",
    success: "bg-green-50 border-green-200 text-green-700",
    info: "bg-blue-50 border-blue-200 text-blue-700",
    warning: "bg-yellow-50 border-yellow-200 text-yellow-700",
  };
  return (
    <div className={`p-3 border rounded-lg text-sm ${styles[variant]}`}>
      {children}
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
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors"
      aria-label="复制到剪贴板"
    >
      {copied ? (
        <>
          <svg className="w-3.5 h-3.5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          已复制
        </>
      ) : (
        <>
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          复制
        </>
      )}
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Step indicator
// ────────────────────────────────────────────────────────────────────────────

const STEP_LABELS: Record<Step, string> = {
  1: "说明",
  2: "获取地址",
  3: "验证邮箱",
  4: "录入凭证",
  5: "完成",
};

function StepIndicator({ current }: { current: Step }) {
  const steps: Step[] = [1, 2, 3, 4, 5];
  return (
    <nav aria-label="绑定进度" className="mb-8">
      <ol className="flex items-center gap-0">
        {steps.map((step, idx) => {
          const done = step < current;
          const active = step === current;
          return (
            <li key={step} className="flex items-center flex-1 last:flex-none">
              <div className="flex flex-col items-center">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors ${
                    done
                      ? "bg-blue-600 text-white"
                      : active
                      ? "bg-blue-600 text-white ring-4 ring-blue-100"
                      : "bg-gray-100 text-gray-400"
                  }`}
                  aria-current={active ? "step" : undefined}
                >
                  {done ? (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    step
                  )}
                </div>
                <span className={`mt-1 text-xs font-medium hidden sm:block ${active ? "text-blue-600" : done ? "text-gray-600" : "text-gray-400"}`}>
                  {STEP_LABELS[step]}
                </span>
              </div>
              {idx < steps.length - 1 && (
                <div className={`flex-1 h-0.5 mx-1 transition-colors ${done ? "bg-blue-600" : "bg-gray-200"}`} />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Step 1 — Intro / consent
// ────────────────────────────────────────────────────────────────────────────

function Step1Intro({ onNext }: { onNext: () => void }) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">绑定 CQU 账户</h2>
        <p className="text-sm text-gray-500">
          绑定后，本系统将代您持续维护与重庆大学统一认证（CAS）的会话，让第三方应用能以您的身份安全访问教务、图书馆等 CQU 系统。
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-start gap-3 p-4 bg-gray-50 rounded-xl">
          <div className="mt-0.5 w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-gray-900">专属密保邮箱</p>
            <p className="text-xs text-gray-500 mt-0.5">
              我们为您生成一个专属收信地址，用于接收 CQU 安全邮箱的验证码。您需要将 CQU 自服务中心的密保邮箱设置为该地址。
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 p-4 bg-gray-50 rounded-xl">
          <div className="mt-0.5 w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-gray-900">凭证加密存储</p>
            <p className="text-xs text-gray-500 mt-0.5">
              您的 CQU 密码将以 AES-256-GCM 加密存储，仅用于自动维护会话，不会明文记录或对外透露。
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 p-4 bg-gray-50 rounded-xl">
          <div className="mt-0.5 w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-gray-900">无人值守保活</p>
            <p className="text-xs text-gray-500 mt-0.5">
              系统每 15 分钟自动刷新 CQU 会话。当 CQU 要求 2FA 时，验证码将通过密保邮箱实时捕获并自动填入。
            </p>
          </div>
        </div>
      </div>

      <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-xl text-xs text-yellow-800">
        <strong>信任须知：</strong>绑定完成后，您应改用短信或微信验证方式自行登录 CQU，
        不要再依赖密保邮箱人工登录——因为该邮箱已由本系统托管，验证码将被自动处理。
      </div>

      <button
        type="button"
        onClick={onNext}
        className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
      >
        开始绑定
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Step 2 — Get dedicated address
// ────────────────────────────────────────────────────────────────────────────

function Step2Address({
  onNext,
  bindAddress,
  setBindAddress,
}: {
  onNext: () => void;
  bindAddress: string;
  setBindAddress: (addr: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (bindAddress) return; // already fetched
    setLoading(true);
    fetch("/api/cqu/bind/address", { method: "POST", credentials: "include" })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(data.error ?? "获取地址失败，请稍后重试");
        }
        return res.json() as Promise<BindAddressResponse>;
      })
      .then((data) => {
        setBindAddress(data.address);
      })
      .catch((err: Error) => {
        setError(err.message);
      })
      .finally(() => {
        setLoading(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">您的专属密保邮箱地址</h2>
        <p className="text-sm text-gray-500">
          请将以下地址设置为您在 CQU 自服务中心的密保邮箱，CQU 随后会向该地址发送验证码。
        </p>
      </div>

      {error && <AlertBox variant="error">{error}</AlertBox>}

      {loading ? (
        <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-xl text-gray-400 text-sm">
          <Spinner size="sm" color="gray" />
          正在生成专属地址…
        </div>
      ) : bindAddress ? (
        <div className="space-y-3">
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl">
            <p className="text-xs text-blue-600 font-medium mb-2">您的专属密保邮箱</p>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <span className="font-mono text-sm font-semibold text-blue-900 break-all">
                {bindAddress}
              </span>
              <CopyButton text={bindAddress} />
            </div>
          </div>

          <div className="space-y-2 text-sm text-gray-600">
            <p className="font-medium text-gray-900">操作步骤：</p>
            <ol className="space-y-2 list-decimal list-inside">
              <li>
                打开{" "}
                <a
                  href="https://self.cqu.edu.cn"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:text-blue-700 font-medium underline underline-offset-2"
                >
                  self.cqu.edu.cn
                </a>
                {" "}并登录
              </li>
              <li>进入「安全设置」→「绑定密保邮箱」</li>
              <li>将密保邮箱设置为上方地址并保存</li>
              <li>CQU 将发送一封验证邮件到该地址</li>
            </ol>
          </div>
        </div>
      ) : null}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onNext}
          disabled={!bindAddress || loading}
          className="flex-1 py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-medium rounded-lg transition-colors"
        >
          我已设置，继续
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Step 3 — Await confirmation code via WebSocket
// ────────────────────────────────────────────────────────────────────────────

function Step3AwaitCode({ onNext }: { onNext: () => void }) {
  const [wsState, setWsState] = useState<WsState>("idle");
  const [code, setCode] = useState<string>("");
  const [codeTs, setCodeTs] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }

    setWsState("connecting");
    const ws = new WebSocket(buildWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      setWsState("open");
    };

    ws.onmessage = (evt) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(evt.data as string) as { type: string; code?: string; ts?: number };
        if (msg.type === "bind_code" && msg.code) {
          setCode(msg.code);
          setCodeTs(msg.ts ?? Date.now());
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setWsState("closed");
      // reconnect after 3 s unless unmounted
      reconnectTimer.current = setTimeout(() => {
        if (mountedRef.current) connect();
      }, 3000);
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      setWsState("error");
      ws.close();
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  // Code expiry countdown (2-minute validity)
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!codeTs) { setSecondsLeft(null); return; }
    const update = () => {
      const elapsed = Math.floor((Date.now() - codeTs) / 1000);
      const remaining = 120 - elapsed;
      setSecondsLeft(remaining > 0 ? remaining : 0);
    };
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [codeTs]);

  const codeExpired = secondsLeft !== null && secondsLeft <= 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">等待 CQU 验证码</h2>
        <p className="text-sm text-gray-500">
          CQU 自服务中心保存密保邮箱后，会发送一封验证邮件。验证码将在到达时立即显示在下方——请在 2 分钟内将其填入 CQU 页面完成绑定。
        </p>
      </div>

      {/* WS connection status */}
      <div className={`flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-lg ${
        wsState === "open"
          ? "bg-green-50 text-green-700"
          : wsState === "connecting"
          ? "bg-blue-50 text-blue-600"
          : wsState === "error" || wsState === "closed"
          ? "bg-yellow-50 text-yellow-700"
          : "bg-gray-50 text-gray-500"
      }`}>
        {wsState === "open" && (
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
        )}
        {wsState === "connecting" && <Spinner size="sm" color="blue" />}
        {(wsState === "closed" || wsState === "error") && (
          <Spinner size="sm" color="gray" />
        )}
        {wsState === "open" && "实时监听中，验证码到达将立即显示"}
        {wsState === "connecting" && "正在建立连接…"}
        {wsState === "closed" && "连接中断，正在重连…"}
        {wsState === "error" && "连接出错，正在重连…"}
        {wsState === "idle" && "准备连接…"}
      </div>

      {/* Code display */}
      {code ? (
        <div className={`p-5 rounded-xl border-2 ${codeExpired ? "border-gray-200 bg-gray-50" : "border-blue-300 bg-blue-50"}`}>
          <div className="flex items-center justify-between mb-3">
            <p className={`text-xs font-semibold uppercase tracking-wide ${codeExpired ? "text-gray-400" : "text-blue-600"}`}>
              密保邮箱验证码
            </p>
            {secondsLeft !== null && (
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                codeExpired
                  ? "bg-gray-200 text-gray-500"
                  : secondsLeft <= 30
                  ? "bg-red-100 text-red-600"
                  : "bg-blue-100 text-blue-700"
              }`}>
                {codeExpired ? "已过期" : `${secondsLeft}s`}
              </span>
            )}
          </div>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <span className={`font-mono text-4xl font-bold tracking-[0.25em] ${codeExpired ? "text-gray-400" : "text-blue-900"}`}>
              {code}
            </span>
            <CopyButton text={code} />
          </div>
          {codeExpired && (
            <p className="mt-3 text-xs text-gray-500">
              验证码已过期，请在 CQU 自服务中心重新发送验证邮件。
            </p>
          )}
        </div>
      ) : (
        <div className="p-8 border-2 border-dashed border-gray-200 rounded-xl text-center">
          <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-3">
            <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <p className="text-sm text-gray-400">等待验证码到达…</p>
        </div>
      )}

      <div className="p-3 bg-gray-50 rounded-xl text-xs text-gray-500 space-y-1">
        <p className="font-medium text-gray-600">没有收到验证码？</p>
        <p>· 确认您已在 CQU 自服务中心点击「发送验证邮件」</p>
        <p>· 邮件通常在 1 分钟内到达；如超时可在 CQU 页面重新发送</p>
        <p>· 此页面保持打开，新验证码到达后会自动更新</p>
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onNext}
          className="flex-1 py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          已在 CQU 完成验证，继续
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Step 4 — Enter CQU credentials
// ────────────────────────────────────────────────────────────────────────────

function Step4Credentials({ onSuccess }: { onSuccess: (studentId: string) => void }) {
  const [studentId, setStudentId] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    abortRef.current = new AbortController();

    try {
      const res = await fetch("/api/cqu/bind/credentials", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId, password }),
        // Long-lived request: backend triggers first CQU login which can take several minutes.
        // We intentionally do not set a short timeout — let it complete.
        signal: abortRef.current.signal,
      });

      const data = await res.json() as { success?: boolean; error?: string; code?: string };

      if (res.ok && data.success) {
        onSuccess(studentId);
        return;
      }

      const codeMessages: Record<string, string> = {
        CQU_LOGIN_FAILED: "CQU 登录失败，请检查学号和密码是否正确",
        NO_BIND_ADDRESS: "请先完成密保邮箱设置（请返回上一步）",
        INVALID_BODY: "请求格式错误，请刷新页面重试",
        BIND_ACTIVATE_FAILED: "首次登录成功，但激活状态写入失败，请稍后重试",
        MISSING_FIELDS: "请填写学号和密码",
      };
      setError(
        (data.code && codeMessages[data.code])
          ? codeMessages[data.code]
          : data.error ?? "绑定失败，请检查学号和密码"
      );
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      setError("请求失败，请检查网络连接后重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">录入 CQU 凭证</h2>
        <p className="text-sm text-gray-500">
          输入您的 CQU 统一认证学号和密码。系统将立即发起首次登录——由于需要等待 2FA 邮件，此过程可能需要几分钟，请耐心等待。
        </p>
      </div>

      {error && <AlertBox variant="error">{error}</AlertBox>}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="bind-studentId" className="block text-sm font-medium text-gray-700 mb-1">
            学号
          </label>
          <input
            id="bind-studentId"
            type="text"
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
            required
            disabled={loading}
            autoComplete="username"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-50 disabled:text-gray-500"
            placeholder="输入您的学号"
          />
        </div>

        <div>
          <label htmlFor="bind-cquPassword" className="block text-sm font-medium text-gray-700 mb-1">
            CQU 统一认证密码
          </label>
          <input
            id="bind-cquPassword"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={loading}
            autoComplete="current-password"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-50 disabled:text-gray-500"
            placeholder="输入 CQU 统一认证密码"
          />
        </div>

        {loading && (
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl">
            <div className="flex items-center gap-3 mb-2">
              <Spinner size="sm" color="blue" />
              <p className="text-sm font-medium text-blue-800">正在完成首次登录…</p>
            </div>
            <p className="text-xs text-blue-600 pl-6">
              系统正在以您的身份登录 CQU，可能需要等待 2FA 验证码邮件，
              预计需要 1–5 分钟。请保持页面打开，不要刷新。
            </p>
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          {loading && <Spinner size="sm" color="white" />}
          {loading ? "首次登录中，请稍候…" : "确认绑定"}
        </button>
      </form>

      <div className="p-3 bg-gray-50 rounded-xl text-xs text-gray-500">
        <p className="font-medium text-gray-600 mb-1">安全提示</p>
        <p>您的密码将以 AES-256-GCM 加密存储，仅用于维护 CQU 会话，不会明文记录或对外共享。</p>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Step 5 — Done
// ────────────────────────────────────────────────────────────────────────────

function Step5Done({ studentId }: { studentId: string }) {
  const [bindStatus, setBindStatus] = useState<BindStatusResponse | null>(null);

  useEffect(() => {
    fetch("/api/cqu/bind/status", { credentials: "include" })
      .then((r) => r.ok ? r.json() as Promise<BindStatusResponse> : Promise.reject())
      .then(setBindStatus)
      .catch(() => {/* best-effort */});
  }, []);

  const isActive = bindStatus?.bindStatus === "active";

  return (
    <div className="space-y-6">
      <div className="text-center py-4">
        <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 ${isActive || !bindStatus ? "bg-green-100" : "bg-yellow-100"}`}>
          {isActive || !bindStatus ? (
            <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-8 h-8 text-yellow-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          )}
        </div>
        <h2 className="text-xl font-semibold text-gray-900 mb-1">
          {isActive || !bindStatus ? "绑定成功！" : "绑定处理中…"}
        </h2>
        <p className="text-sm text-gray-500">
          {isActive || !bindStatus
            ? "CQU 账户已成功绑定，系统将自动维护您的 CQU 会话。"
            : "首次登录仍在处理中，稍后请在账户设置中确认绑定状态。"}
        </p>
      </div>

      {(isActive || !bindStatus) && (
        <div className="p-4 bg-gray-50 rounded-xl text-sm space-y-2">
          <p className="font-medium text-gray-900">绑定信息</p>
          <div className="flex items-center justify-between py-1 border-b border-gray-200">
            <span className="text-gray-500">学号</span>
            <span className="font-medium text-gray-900">{studentId}</span>
          </div>
          {bindStatus?.bindStatus && (
            <div className="flex items-center justify-between py-1">
              <span className="text-gray-500">状态</span>
              <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full ${
                bindStatus.bindStatus === "active"
                  ? "bg-green-100 text-green-700"
                  : "bg-yellow-100 text-yellow-700"
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${bindStatus.bindStatus === "active" ? "bg-green-500" : "bg-yellow-500"}`} />
                {bindStatus.bindStatus === "active" ? "已激活" : bindStatus.bindStatus}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl text-sm text-blue-800 space-y-1">
        <p className="font-semibold">接下来需要注意：</p>
        <ul className="list-disc list-inside space-y-1 text-xs">
          <li>请改用<strong>短信验证码</strong>或<strong>微信</strong>方式自行登录 CQU</li>
          <li>密保邮箱已由系统托管，验证码将被自动处理，请勿人工干预</li>
          <li>系统每 15 分钟自动保活会话，无需您手动操作</li>
        </ul>
      </div>

      <Link
        to="/settings"
        className="block w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors text-center"
      >
        返回账户设置
      </Link>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Main wizard page
// ────────────────────────────────────────────────────────────────────────────

export default function CquBindWizard() {
  const [step, setStep] = useState<Step>(1);
  const [bindAddress, setBindAddress] = useState("");
  const [boundStudentId, setBoundStudentId] = useState("");

  const goNext = () => setStep((s) => Math.min(s + 1, 5) as Step);

  return (
    <Layout>
      <div className="max-w-xl mx-auto">
        {/* Page header */}
        <div className="mb-6">
          <Link to="/settings" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            返回设置
          </Link>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-6 sm:p-8">
          <StepIndicator current={step} />

          <div>
            {step === 1 && <Step1Intro onNext={goNext} />}
            {step === 2 && (
              <Step2Address
                onNext={goNext}
                bindAddress={bindAddress}
                setBindAddress={setBindAddress}
              />
            )}
            {step === 3 && <Step3AwaitCode onNext={goNext} />}
            {step === 4 && (
              <Step4Credentials
                onSuccess={(sid) => {
                  setBoundStudentId(sid);
                  goNext();
                }}
              />
            )}
            {step === 5 && <Step5Done studentId={boundStudentId} />}
          </div>
        </div>
      </div>
    </Layout>
  );
}
