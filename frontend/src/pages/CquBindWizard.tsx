import { useState, useEffect, useRef, useCallback, FormEvent } from "react";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

type Step = 1 | 2 | 3 | 4;

type BindKind = "direct" | "forward";

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(s: string): boolean {
  return EMAIL_RE.test(s.trim());
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
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
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
  2: "绑定邮箱",
  3: "录入凭证",
  4: "完成",
};

function StepIndicator({ current }: { current: Step }) {
  const steps: Step[] = [1, 2, 3, 4];
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
// Step 1 — Intro / consent + bind kind selection
// ────────────────────────────────────────────────────────────────────────────

function Step1Intro({
  onNext,
  bindKind,
  setBindKind,
  forwardAddress,
  setForwardAddress,
}: {
  onNext: () => void;
  bindKind: BindKind;
  setBindKind: (k: BindKind) => void;
  forwardAddress: string;
  setForwardAddress: (v: string) => void;
}) {
  const [forwardAddrTouched, setForwardAddrTouched] = useState(false);

  const forwardAddrValid = isValidEmail(forwardAddress);
  const showForwardError = forwardAddrTouched && forwardAddress.trim() !== "" && !forwardAddrValid;

  const canProceed =
    bindKind === "direct" ||
    (bindKind === "forward" && forwardAddrValid);

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
              我们为您生成一个专属收信地址，用于接收 CQU 安全邮箱的验证码。您需要将 CQU 自服务中心的密保邮箱设置为该地址（或设置转发规则）。
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

      {/* ── Bind kind selection ─────────────────────────────────────────────── */}
      <div className="space-y-3">
        <p className="text-sm font-medium text-gray-900">选择绑定方式</p>

        {/* Direct option */}
        <label
          className={`flex items-start gap-3 p-4 rounded-xl border-2 cursor-pointer transition-colors ${
            bindKind === "direct"
              ? "border-blue-500 bg-blue-50"
              : "border-gray-200 bg-white hover:border-gray-300"
          }`}
        >
          <input
            type="radio"
            name="bindKind"
            value="direct"
            checked={bindKind === "direct"}
            onChange={() => setBindKind("direct")}
            className="mt-0.5 accent-blue-600"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-900">直设模式</span>
              <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">推荐</span>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              将 CQU 密保邮箱直接改为我们为您生成的专属地址。安全性更高，验证码直达，无中间环节。
            </p>
          </div>
        </label>

        {/* Forward option — 暂时禁用：可见但不可选。
            代码保留（state/分支/Step2Forward 均未删），仅置灰禁用，待重新开放。 */}
        <label
          className="flex items-start gap-3 p-4 rounded-xl border-2 border-gray-200 bg-gray-50 cursor-not-allowed opacity-60"
          aria-disabled="true"
        >
          <input
            type="radio"
            name="bindKind"
            value="forward"
            checked={false}
            disabled
            onChange={() => {
              /* 暂时禁用：转发模式不可选 */
            }}
            className="mt-0.5 accent-blue-600 cursor-not-allowed"
          />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium text-gray-500">转发（暂不可用）</span>
            <p className="text-xs text-gray-400 mt-0.5">
              保留您自己的邮箱作为 CQU 密保邮箱，在邮箱里添加转发规则，将 CQU 的邮件自动转发到我们的地址。
            </p>
            <p className="text-xs text-gray-400 mt-1 font-medium">该模式暂未开放，请使用直设模式。</p>
          </div>
        </label>

        {/* Forward address input — shown only when forward is selected */}
        {bindKind === "forward" && (
          <div className="ml-0 space-y-3">
            <div>
              <label htmlFor="forward-addr" className="block text-sm font-medium text-gray-700 mb-1">
                您的转发邮箱（即当前 CQU 密保邮箱）
              </label>
              <input
                id="forward-addr"
                type="email"
                value={forwardAddress}
                onChange={(e) => setForwardAddress(e.target.value)}
                onBlur={() => setForwardAddrTouched(true)}
                placeholder="example@gmail.com"
                className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                  showForwardError ? "border-red-400 bg-red-50" : "border-gray-300"
                }`}
                autoComplete="email"
              />
              {showForwardError && (
                <p className="mt-1 text-xs text-red-600">请输入合法的邮箱地址</p>
              )}
            </div>

            {/* Deliverability notice */}
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800 space-y-1.5">
              <p className="font-semibold">转发器兼容性说明</p>
              <p>
                由于 CQU 域名不配置 DKIM，转发器必须能对转发邮件做 <strong>SRS 地址改写</strong>或用自身 DKIM 重签，
                否则邮件会被我们的收信服务器拒收。
              </p>
              <p>
                <strong>主流邮箱均支持</strong>：Gmail、QQ 邮箱、Outlook / Hotmail、163 / 126 等。
                若使用自建邮件服务，请确认其支持 SRS。
              </p>
            </div>

            {/* Security notice */}
            <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-xl text-xs text-yellow-800 space-y-1">
              <p className="font-semibold">安全说明</p>
              <p>
                转发模式依赖您邮箱的转发链，安全性略低于直设模式。
                即使出现最坏情况，风险也仅限于单次 CQU 会话重登失败，不会导致账号被他人接管。
              </p>
              <p>如果您对安全要求较高，建议使用直设模式。</p>
            </div>
          </div>
        )}
      </div>

      <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-xl text-xs text-yellow-800">
        <strong>信任须知：</strong>绑定完成后，您应改用短信或微信验证方式自行登录 CQU，
        不要再依赖密保邮箱人工登录——因为该邮箱已由本系统托管，验证码将被自动处理。
      </div>

      <button
        type="button"
        onClick={onNext}
        disabled={!canProceed}
        title={
          bindKind === "forward" && !forwardAddrValid
            ? "请填写合法的转发邮箱地址"
            : undefined
        }
        className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-medium rounded-lg transition-colors"
      >
        开始绑定
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Step 2 (direct) — Get dedicated address AND await confirmation code via WS
//
// The WS opens the moment the address is fetched and displayed, so we are
// already listening before the user navigates to CQU self-service. This
// eliminates the race where the CQU code email arrives while the user is
// still on this page but the socket has not been opened yet.
// ────────────────────────────────────────────────────────────────────────────

function Step2Direct({
  onNext,
  bindAddress,
  setBindAddress,
}: {
  onNext: () => void;
  bindAddress: string;
  setBindAddress: (addr: string) => void;
}) {
  // ── Address fetch state ──────────────────────────────────────────────────
  const [addrLoading, setAddrLoading] = useState(false);
  const [addrError, setAddrError] = useState("");

  // ── WebSocket state ──────────────────────────────────────────────────────
  const [wsState, setWsState] = useState<WsState>("idle");
  const [code, setCode] = useState<string>("");
  const [codeTs, setCodeTs] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // Ref mirror of `code` so the `connect` callback (dep array []) can read
  // the current value without capturing a stale closure.
  const codeRef = useRef("");

  // ── WS lifecycle ─────────────────────────────────────────────────────────
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
          codeRef.current = msg.code;
          setCode(msg.code);
          setCodeTs(msg.ts ?? Date.now());
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      // Stop reconnecting once unmounted or once a code has been received.
      // Use codeRef (not the `code` state) because this callback is closed
      // over the initial empty string due to useCallback([]).
      if (!mountedRef.current || codeRef.current) {
        setWsState("closed");
        return;
      }
      setWsState("closed");
      // reconnect after 3 s unless unmounted or code already in hand
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

  // ── Address fetch ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (bindAddress) return; // already fetched (e.g. user navigated back)
    setAddrLoading(true);
    fetch("/api/cqu/bind/address", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "direct" }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { detail?: { error?: { message?: string } } };
          throw new Error(data.detail?.error?.message ?? "获取地址失败，请稍后重试");
        }
        return res.json() as Promise<BindAddressResponse>;
      })
      .then((data) => {
        setBindAddress(data.address);
      })
      .catch((err: Error) => {
        setAddrError(err.message);
      })
      .finally(() => {
        setAddrLoading(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Code expiry countdown (10-minute validity) ────────────────────────────
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!codeTs) { setSecondsLeft(null); return; }
    const update = () => {
      const elapsed = Math.floor((Date.now() - codeTs) / 1000);
      const remaining = 600 - elapsed;
      setSecondsLeft(remaining > 0 ? remaining : 0);
    };
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [codeTs]);

  const codeExpired = secondsLeft !== null && secondsLeft <= 0;

  // Format seconds as m:ss for the countdown badge
  const formatCountdown = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">设置密保邮箱并等待验证码</h2>
        <p className="text-sm text-gray-500">
          将下方专属地址设置为 CQU 自服务中心的密保邮箱，CQU 随后会向该地址发送验证码——验证码到达后将立即显示在本页面。
        </p>
      </div>

      {addrError && <AlertBox variant="error">{addrError}</AlertBox>}

      {/* ── Dedicated address ─────────────────────────────────────────────── */}
      {addrLoading ? (
        <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-xl text-gray-400 text-sm">
          <Spinner size="sm" color="gray" />
          正在生成专属地址…
        </div>
      ) : bindAddress ? (
        <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl">
          <p className="text-xs text-blue-600 font-medium mb-2">您的专属密保邮箱</p>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="font-mono text-sm font-semibold text-blue-900 break-all">
              {bindAddress}
            </span>
            <CopyButton text={bindAddress} />
          </div>
        </div>
      ) : null}

      {/* ── CQU operation steps ───────────────────────────────────────────── */}
      {bindAddress && (
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
            <li>CQU 将发送一封验证邮件到该地址，验证码将自动显示在下方</li>
          </ol>
        </div>
      )}

      {/* ── WS connection status ──────────────────────────────────────────── */}
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

      {/* ── Code display ──────────────────────────────────────────────────── */}
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
                  : secondsLeft <= 60
                  ? "bg-red-100 text-red-600"
                  : "bg-blue-100 text-blue-700"
              }`}>
                {codeExpired ? "已过期" : formatCountdown(secondsLeft)}
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

      {/* ── Help tips ────────────────────────────────────────────────────── */}
      <div className="p-3 bg-gray-50 rounded-xl text-xs text-gray-500 space-y-1">
        <p className="font-medium text-gray-600">没有收到验证码？</p>
        <p>· 确认您已在 CQU 自服务中心点击「发送验证邮件」</p>
        <p>· 邮件通常在 1 分钟内到达，验证码有效期约 10 分钟</p>
        <p>· 如超时可在 CQU 页面重新发送，新验证码到达后会自动更新</p>
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onNext}
          disabled={!bindAddress || addrLoading}
          className="flex-1 py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-medium rounded-lg transition-colors"
        >
          已在 CQU 完成验证，继续
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Step 2 (forward) — Get dedicated forward-inbox address, show setup guide
//
// In forward mode there is no bind_confirm step from CQU (the user keeps
// their own mailbox as the security email and just adds a forward rule).
// Therefore we do NOT connect a WebSocket and do NOT wait for any code.
// The user reads the instructions, sets up the forward rule, then clicks
// "已设置转发，继续" to proceed to Step 3.
// ────────────────────────────────────────────────────────────────────────────

function Step2Forward({
  onNext,
  bindAddress,
  setBindAddress,
  forwardAddress,
}: {
  onNext: () => void;
  bindAddress: string;
  setBindAddress: (addr: string) => void;
  forwardAddress: string;
}) {
  const [addrLoading, setAddrLoading] = useState(false);
  const [addrError, setAddrError] = useState("");

  useEffect(() => {
    if (bindAddress) return; // already fetched (e.g. user navigated back)
    setAddrLoading(true);
    fetch("/api/cqu/bind/address", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "forward", forwardAddress }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { detail?: { error?: { message?: string; code?: string } } };
          const errCode = data.detail?.error?.code;
          if (errCode === "INVALID_FORWARD_ADDRESS") {
            throw new Error("转发邮箱地址格式不合法，请刷新页面后重新填写");
          }
          throw new Error(data.detail?.error?.message ?? "获取地址失败，请稍后重试");
        }
        return res.json() as Promise<BindAddressResponse>;
      })
      .then((data) => {
        setBindAddress(data.address);
      })
      .catch((err: Error) => {
        setAddrError(err.message);
      })
      .finally(() => {
        setAddrLoading(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">设置邮件转发规则</h2>
        <p className="text-sm text-gray-500">
          您选择了转发模式：CQU 密保邮箱保持不变，只需在您自己的邮箱里添加一条自动转发规则即可。
        </p>
      </div>

      {addrError && (
        <AlertBox variant="error">
          {addrError}
          {addrError.includes("刷新页面") && (
            <span className="block mt-1 text-xs">如需修改邮箱地址，请刷新页面后重新填写。</span>
          )}
        </AlertBox>
      )}

      {/* ── Dedicated inbox address ───────────────────────────────────────── */}
      {addrLoading ? (
        <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-xl text-gray-400 text-sm">
          <Spinner size="sm" color="gray" />
          正在生成专属转发地址…
        </div>
      ) : bindAddress ? (
        <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl">
          <p className="text-xs text-blue-600 font-medium mb-2">转发目标地址（请将 CQU 邮件转发到此处）</p>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="font-mono text-sm font-semibold text-blue-900 break-all">
              {bindAddress}
            </span>
            <CopyButton text={bindAddress} />
          </div>
        </div>
      ) : null}

      {/* ── Forward setup instructions ────────────────────────────────────── */}
      {bindAddress && (
        <div className="space-y-2 text-sm text-gray-600">
          <p className="font-medium text-gray-900">操作步骤：</p>
          <ol className="space-y-2 list-decimal list-inside">
            <li>
              登录您的邮箱{forwardAddress ? <strong>（{forwardAddress}）</strong> : ""}，进入「设置」→「过滤器」或「自动转发」
            </li>
            <li>
              新建一条过滤/转发规则：<strong>发件人为 sso@cqu.edu.cn 的邮件</strong>，自动转发到上方地址
            </li>
            <li>保存规则，完成后点击下方按钮继续</li>
          </ol>
        </div>
      )}

      {/* ── Compatibility reminder ────────────────────────────────────────── */}
      {bindAddress && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800 space-y-1">
          <p className="font-semibold">重要提示</p>
          <p>
            请确保您的邮箱在转发时会对邮件做地址改写（SRS）或用自身 DKIM 重签，
            Gmail、QQ 邮箱、Outlook 等主流服务均支持。
            若转发后我们未收到邮件，请检查转发器是否兼容。
          </p>
        </div>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onNext}
          disabled={!bindAddress || addrLoading}
          className="flex-1 py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-medium rounded-lg transition-colors"
        >
          已设置转发，继续
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Step 2 dispatcher — routes to direct or forward variant
// ────────────────────────────────────────────────────────────────────────────

function Step2AddressAndCode({
  onNext,
  bindAddress,
  setBindAddress,
  bindKind,
  forwardAddress,
}: {
  onNext: () => void;
  bindAddress: string;
  setBindAddress: (addr: string) => void;
  bindKind: BindKind;
  forwardAddress: string;
}) {
  if (bindKind === "forward") {
    return (
      <Step2Forward
        onNext={onNext}
        bindAddress={bindAddress}
        setBindAddress={setBindAddress}
        forwardAddress={forwardAddress}
      />
    );
  }
  return (
    <Step2Direct
      onNext={onNext}
      bindAddress={bindAddress}
      setBindAddress={setBindAddress}
    />
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Step 3 — Enter CQU credentials
// ────────────────────────────────────────────────────────────────────────────

function Step3Credentials({ onSuccess }: { onSuccess: (studentId: string) => void }) {
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

      const data = await res.json() as {
        success?: boolean;
        detail?: { error?: { code?: string; message?: string } };
      };

      if (res.ok && data.success) {
        onSuccess(studentId);
        return;
      }

      const codeMessages: Record<string, string> = {
        CQU_LOGIN_FAILED: "CQU 登录失败，请检查统一身份认证账号和密码是否正确",
        NO_BIND_ADDRESS: "尚未完成密保邮箱设置，请刷新页面后重新开始",
        INVALID_BODY: "请求格式错误，请刷新页面重试",
        BIND_ACTIVATE_FAILED: "首次登录成功，但激活状态写入失败，请稍后重试",
        MISSING_FIELDS: "请填写统一身份认证账号和密码",
      };
      const errCode = data.detail?.error?.code;
      const errMessage = data.detail?.error?.message;
      setError(
        (errCode && codeMessages[errCode])
          ? codeMessages[errCode]
          : errMessage ?? "绑定失败，请检查统一身份认证账号和密码"
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
          输入您的 CQU 统一身份认证账号和密码。系统将立即发起首次登录——由于需要等待 2FA 邮件，此过程可能需要几分钟，请耐心等待。
        </p>
      </div>

      {error && <AlertBox variant="error">{error}</AlertBox>}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="bind-studentId" className="block text-sm font-medium text-gray-700 mb-1">
            统一身份认证账号
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
            placeholder="输入您的统一身份认证账号"
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
// Step 4 — Done
// ────────────────────────────────────────────────────────────────────────────

function Step4Done({ studentId }: { studentId: string }) {
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
            <span className="text-gray-500">统一身份认证账号</span>
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

  // Bind kind selection — lifted to wizard root so Step2 can access it
  const [bindKind, setBindKind] = useState<BindKind>("direct");
  const [forwardAddress, setForwardAddress] = useState("");

  const goNext = () => setStep((s) => Math.min(s + 1, 4) as Step);

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
            {step === 1 && (
              <Step1Intro
                onNext={goNext}
                bindKind={bindKind}
                setBindKind={(k) => {
                  setBindKind(k);
                  // Reset the fetched address when the user changes kind
                  // so Step2 will re-fetch with the new parameters
                  setBindAddress("");
                }}
                forwardAddress={forwardAddress}
                setForwardAddress={setForwardAddress}
              />
            )}
            {step === 2 && (
              <Step2AddressAndCode
                onNext={goNext}
                bindAddress={bindAddress}
                setBindAddress={setBindAddress}
                bindKind={bindKind}
                forwardAddress={forwardAddress}
              />
            )}
            {step === 3 && (
              <Step3Credentials
                onSuccess={(sid) => {
                  setBoundStudentId(sid);
                  goNext();
                }}
              />
            )}
            {step === 4 && <Step4Done studentId={boundStudentId} />}
          </div>
        </div>
      </div>
    </Layout>
  );
}
