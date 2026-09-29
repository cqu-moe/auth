import { useState, useEffect, useRef, useCallback, FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowLeft, Check, Loader2, Lock, Mail, RefreshCw } from "lucide-react";
import { ActionButton, Alert, AlertDescription, Button, Input, Label, PageHeader } from "@cqu-moe/ui";
import Layout from "../components/Layout";
import CquBindSuccess from "../components/CquBindSuccess";
import { authClient } from "../lib/auth-client";
import { bindingReturnTarget } from "../lib/cqu-bind-continuation";
import { createBinding, getBinding, updateCredentials } from "../lib/api/cqu";
import { ApiError } from "../lib/api/http";
import { openBindingEvents } from "../lib/api/binding-events";
import {
  bindScreen,
  clearBindProgress,
  parseBindingSnapshot,
  readBindProgress,
  writeBindProgress,
  type BindingSnapshot,
  type BindKind,
  type BindScreen,
} from "../lib/cqu-bind-progress";

import CopyButton from "../components/CopyButton";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

type Step = 1 | 2 | 3 | 4;

type WsState = "idle" | "connecting" | "open" | "closed" | "error";

const STEP_LABELS: Record<Step, string> = {
  1: "说明",
  2: "绑定邮箱",
  3: "录入凭证",
  4: "完成",
};

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

class BindingRequestError extends Error {
  constructor(readonly status: number) {
    super("Binding status request failed");
  }
}

async function fetchBindingSnapshot(signal: AbortSignal): Promise<BindingSnapshot> {
  try {
    return parseBindingSnapshot(await getBinding(signal));
  } catch (error) {
    if (error instanceof ApiError) throw new BindingRequestError(error.status);
    throw error;
  }
}

function progressStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const replaceLocation = (url: string) => window.location.replace(url);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(s: string): boolean {
  return EMAIL_RE.test(s.trim());
}

// ────────────────────────────────────────────────────────────────────────────
// Shared UI atoms
// ────────────────────────────────────────────────────────────────────────────

function Spinner({ size = 16, className = "" }: { size?: number; className?: string }) {
  return <Loader2 aria-hidden="true" size={size} className={`animate-spin ${className}`} />;
}

function AlertBox({ variant, children }: { variant: "error" | "success" | "info" | "warning"; children: React.ReactNode }) {
  if (variant === "error") {
    return (
      <Alert variant="destructive">
        <AlertDescription>{children}</AlertDescription>
      </Alert>
    );
  }
  const styles = {
    success: "border-success/40 bg-success/10 text-success",
    info: "border-link/40 bg-link/10 text-link",
    warning: "border-warning/40 bg-warning/10 text-warning",
  } as const;
  return (
    <div className={`rounded-lg border p-3 text-sm ${styles[variant]}`}>{children}</div>
  );
}

function StepIndicator({ current }: { current: Step }) {
  const steps: Step[] = [1, 2, 3, 4];
  return (
    <nav aria-label="绑定进度" className="mb-8">
      <ol className="step-indicator">
        {steps.map((step) => {
          const state = step < current ? "done" : step === current ? "active" : "todo";
          return (
            <li key={step} data-step-state={state} aria-current={state === "active" ? "step" : undefined}>
              <div className="step-dot" data-state={state}>
                {state === "done" ? <Check aria-hidden="true" size={16} /> : step}
              </div>
              <span className="step-label">{STEP_LABELS[step]}</span>
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

  const introItems = [
    {
      icon: <Mail aria-hidden="true" size={16} />,
      title: "专属密保邮箱",
      body: "我们为您生成一个专属收信地址，用于接收 CQU 安全邮箱的验证码。您需要将 CQU 自服务中心的密保邮箱设置为该地址（或设置转发规则）。",
    },
    {
      icon: <Lock aria-hidden="true" size={16} />,
      title: "凭证加密存储",
      body: "您的 CQU 密码将以 AES-256-GCM 加密存储，仅用于自动维护会话，不会明文记录或对外透露。",
    },
    {
      icon: <RefreshCw aria-hidden="true" size={16} />,
      title: "无人值守保活",
      body: "系统自动刷新 CQU 会话。当 CQU 要求 2FA 时，验证码将通过密保邮箱实时捕获并自动填入。",
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-2 text-xl font-semibold text-foreground">绑定重庆大学统一认证账号</h2>
        <p className="text-sm text-muted-foreground">
          绑定后，系统会安全维护统一认证会话，供已授权的校内服务使用。
        </p>
      </div>

      <div className="divide-y divide-border">
        {introItems.map((item) => (
          <div key={item.title} className="flex items-start gap-3 py-4 first:pt-0">
            <div className="mt-1 shrink-0 text-muted-foreground">
              {item.icon}
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">{item.title}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.body}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <p className="text-sm font-medium text-foreground">选择绑定方式</p>

        <label
          className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors ${
            bindKind === "direct"
              ? "border-primary bg-surface"
              : "border-border bg-surface hover:border-muted-foreground/40"
          }`}
        >
          <input
            type="radio"
            name="bindKind"
            value="direct"
            checked={bindKind === "direct"}
            onChange={() => setBindKind("direct")}
            className="mt-0.5 accent-primary"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">直设模式</span>
              <span className="badge badge-info">推荐</span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              将 CQU 密保邮箱直接改为我们为您生成的专属地址。安全性更高，验证码直达，无中间环节。
            </p>
          </div>
        </label>

        <label
          className="flex cursor-not-allowed items-start gap-3 rounded-lg border border-border bg-muted p-4 opacity-60"
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
            className="mt-0.5 cursor-not-allowed accent-primary"
          />
          <div className="min-w-0 flex-1">
            <span className="text-sm font-medium text-muted-foreground">转发（暂不可用）</span>
            <p className="mt-0.5 text-xs text-muted-foreground">
              保留您自己的邮箱作为 CQU 密保邮箱，在邮箱里添加转发规则，将 CQU 的邮件自动转发到我们的地址。
            </p>
            <p className="mt-1 text-xs font-medium text-muted-foreground">该模式暂未开放，请使用直设模式。</p>
          </div>
        </label>

        {bindKind === "forward" && (
          <div className="ml-0 space-y-3">
            <div>
              <Label htmlFor="forward-addr" className="mb-1 block">您的转发邮箱（即当前 CQU 密保邮箱）</Label>
              <Input
                id="forward-addr"
                type="email"
                value={forwardAddress}
                onChange={(e) => setForwardAddress(e.target.value)}
                onBlur={() => setForwardAddrTouched(true)}
                placeholder="example@gmail.com"
                autoComplete="email"
                aria-invalid={showForwardError || undefined}
              />
              {showForwardError && (
                <p className="field-error mt-1">请输入合法的邮箱地址</p>
              )}
            </div>

            <div className="space-y-1.5 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
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

            <div className="space-y-1 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
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

      <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-xs text-warning">
        <strong>信任须知：</strong>绑定完成后，您应改用短信或微信验证方式自行登录 CQU，
        不要再依赖密保邮箱人工登录——因为该邮箱已由本系统托管，验证码将被自动处理。
      </div>

      <Button
        type="button"
        className="w-full"
        onClick={onNext}
        disabled={!canProceed}
        title={
          bindKind === "forward" && !forwardAddrValid
            ? "请填写合法的转发邮箱地址"
            : undefined
        }
      >
        开始绑定
      </Button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Step 2 (direct) — Get dedicated address AND await confirmation code via WS
// ────────────────────────────────────────────────────────────────────────────

const step2WsStatusText: Record<WsState, string> = {
  idle: "准备连接…",
  connecting: "正在建立连接…",
  open: "实时监听中，验证码到达将立即显示",
  closed: "连接中断，正在重连…",
  error: "连接出错，正在重连…",
};

function Step2Direct({
  onNext,
  bindAddress,
  setBindAddress,
}: {
  onNext: () => void;
  bindAddress: string;
  setBindAddress: (addr: string) => void;
}) {
  const [addrLoading, setAddrLoading] = useState(false);
  const [addrError, setAddrError] = useState("");
  const [wsState, setWsState] = useState<WsState>("idle");
  const [code, setCode] = useState<string>("");
  const [codeTs, setCodeTs] = useState<number | null>(null);
  const connectionRef = useRef<{ close(): void } | null>(null);
  const codeRef = useRef("");

  useEffect(() => {
    connectionRef.current = openBindingEvents({
      onState: (state) => setWsState(state === "failed" ? "error" : state),
      shouldReconnect: () => !codeRef.current,
      retry: { delayMs: 3000, maxAttempts: null },
      heartbeatMs: null,
      onEvent: (event) => {
        if (event.type !== "bind_code") return;
        codeRef.current = event.code;
        setCode(event.code);
        setCodeTs(event.ts ?? Date.now());
      },
    });
    return () => {
      connectionRef.current?.close();
      connectionRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (bindAddress) return; // already fetched (e.g. user navigated back)
    setAddrLoading(true);
    createBinding("direct")
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

  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!codeTs) { setSecondsLeft(null); return; }
    const update = () => {
      const elapsed = Math.floor((Date.now() - codeTs) / 1000);
      const remaining = 600 - elapsed;
      setSecondsLeft(remaining > 0 ? remaining : 0);
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [codeTs]);

  const codeExpired = secondsLeft !== null && secondsLeft <= 0;

  const formatCountdown = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-2 text-xl font-semibold text-foreground">设置密保邮箱</h2>
        <p className="text-sm text-muted-foreground">
          复制下方地址，在学校页面将密保邮箱改为该地址。
        </p>
      </div>

      {addrError && (
        <AlertBox variant="error">
          {addrError}
          {addrError.includes("刷新页面") && (
            <span className="mt-1 block text-xs">如需修改邮箱地址，请刷新页面后重新填写。</span>
          )}
        </AlertBox>
      )}

      {addrLoading ? (
        <div className="flex items-center gap-3 rounded-lg bg-muted p-4 text-sm text-muted-foreground">
          <Spinner />
          正在生成专属地址…
        </div>
      ) : bindAddress ? (
        <div className="rounded-lg border border-link/40 bg-link/10 p-4">
          <p className="mb-2 text-xs font-medium text-link">您的专属密保邮箱</p>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="break-all font-mono text-sm font-semibold text-foreground">
              {bindAddress}
            </span>
            <CopyButton text={bindAddress} />
          </div>
        </div>
      ) : null}

      {bindAddress && (
        <div className="space-y-2">
          <Button asChild variant="outline">
            <a
              href="https://self.cqu.edu.cn/cas-success/safe-center/email-bind-way/rebind"
              target="_blank"
              rel="noopener noreferrer"
            >
              前往修改密保邮箱
              <span className="sr-only">（在新标签页打开）</span>
            </a>
          </Button>
          <p className="text-xs text-muted-foreground">发送验证邮件后，回到这里查看验证码。</p>
        </div>
      )}

      <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium ${
        wsState === "open"
          ? "bg-success/10 text-success"
          : wsState === "connecting"
          ? "bg-link/10 text-link"
          : wsState === "error" || wsState === "closed"
          ? "bg-warning/10 text-warning"
          : "bg-muted text-muted-foreground"
      }`}>
        {wsState === "open" && (
          <span className="h-2 w-2 animate-pulse rounded-full bg-success" aria-hidden="true" />
        )}
        {wsState === "connecting" && <Spinner className="text-link" />}
        {(wsState === "closed" || wsState === "error") && <Spinner className="text-warning" />}
        <span>{step2WsStatusText[wsState]}</span>
      </div>

      {code ? (
        <div className={`rounded-lg border p-5 ${codeExpired ? "border-border bg-muted" : "border-link/50 bg-link/10"}`}>
          <div className="mb-3 flex items-center justify-between">
            <p className={`text-xs font-semibold tracking-wide ${codeExpired ? "text-muted-foreground" : "text-link"}`}>
              密保邮箱验证码
            </p>
            {secondsLeft !== null && (
              <span className={`badge ${
                codeExpired
                  ? "badge-muted"
                  : secondsLeft <= 60
                  ? "badge-warning"
                  : "badge-info"
              }`}>
                {codeExpired ? "已过期" : formatCountdown(secondsLeft)}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <span className={`font-mono text-4xl font-bold tracking-widest ${codeExpired ? "text-muted-foreground" : "text-foreground"}`}>
              {code}
            </span>
            <CopyButton text={code} />
          </div>
          {codeExpired && (
            <p className="mt-3 text-xs text-muted-foreground">
              验证码已过期，请在 CQU 自服务中心重新发送验证邮件。
            </p>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Mail aria-hidden="true" size={24} />
          </div>
          <p className="text-sm text-muted-foreground">等待验证码到达…</p>
        </div>
      )}

      <div className="space-y-1 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">没有收到验证码？</p>
        <p>· 确认您已在 CQU 自服务中心点击「发送验证邮件」</p>
        <p>· 邮件通常在 1 分钟内到达，验证码有效期约 10 分钟</p>
        <p>· 如超时可在 CQU 页面重新发送，新验证码到达后会自动更新</p>
      </div>

      <Button
        type="button"
        className="w-full"
        onClick={onNext}
        disabled={!bindAddress || addrLoading}
      >
        已在 CQU 完成验证，继续
      </Button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Step 2 (forward) — Get dedicated forward-inbox address, show setup guide
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
    createBinding("forward")
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
        <h2 className="mb-2 text-xl font-semibold text-foreground">设置邮件转发规则</h2>
        <p className="text-sm text-muted-foreground">
          您选择了转发模式：CQU 密保邮箱保持不变，只需在您自己的邮箱里添加一条自动转发规则即可。
        </p>
      </div>

      {addrError && (
        <AlertBox variant="error">
          {addrError}
          {addrError.includes("刷新页面") && (
            <span className="mt-1 block text-xs">如需修改邮箱地址，请刷新页面后重新填写。</span>
          )}
        </AlertBox>
      )}

      {addrLoading ? (
        <div className="flex items-center gap-3 rounded-lg bg-muted p-4 text-sm text-muted-foreground">
          <Spinner />
          正在生成专属转发地址…
        </div>
      ) : bindAddress ? (
        <div className="rounded-lg border border-link/40 bg-link/10 p-4">
          <p className="mb-2 text-xs font-medium text-link">转发目标地址（请将 CQU 邮件转发到此处）</p>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="break-all font-mono text-sm font-semibold text-foreground">
              {bindAddress}
            </span>
            <CopyButton text={bindAddress} />
          </div>
        </div>
      ) : null}

      {bindAddress && (
        <div className="space-y-2 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">操作步骤：</p>
          <ol className="list-inside list-decimal space-y-2 marker:text-muted-foreground">
            <li>
              登录您的邮箱{forwardAddress ? <strong>（{forwardAddress}）</strong> : ""}，进入「设置」→「过滤器」或「自动转发」
            </li>
            <li>
              新建一条过滤/转发规则：<strong className="text-foreground">发件人为 sso@cqu.edu.cn 的邮件</strong>，自动转发到上方地址
            </li>
            <li>保存规则，完成后点击下方按钮继续</li>
          </ol>
        </div>
      )}

      {bindAddress && (
        <div className="space-y-1 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          <p className="font-semibold">重要提示</p>
          <p>
            请确保您的邮箱在转发时会对邮件做地址改写（SRS）或用自身 DKIM 重签，
            Gmail、QQ 邮箱、Outlook 等主流服务均支持。
            若转发后我们未收到邮件，请检查转发器是否兼容。
          </p>
        </div>
      )}

      <Button
        type="button"
        className="w-full"
        onClick={onNext}
        disabled={!bindAddress || addrLoading}
      >
        已设置转发，继续
      </Button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Step 2 dispatcher
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

function Step3Credentials({
  onSuccess,
  repair = false,
}: {
  onSuccess: (studentId: string) => void | Promise<void>;
  repair?: boolean;
}) {
  const [studentId, setStudentId] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    abortRef.current = new AbortController();

    try {
      await updateCredentials(studentId, password, abortRef.current.signal);
      await onSuccess(studentId);
      return;
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      const apiError = err instanceof ApiError ? err : null;
      const codeMessages: Record<string, string> = {
        CQU_LOGIN_FAILED: "CQU 登录失败，请检查统一身份认证账号和密码是否正确",
        CQU_LOGIN_IN_FLIGHT: "已有 CQU 登录正在进行，请等待当前登录完成",
        NO_BIND_ADDRESS: "尚未完成密保邮箱设置，请刷新页面后重新开始",
        INVALID_BODY: "请求格式错误，请刷新页面重试",
        BIND_ACTIVATE_FAILED: "首次登录成功，但激活状态写入失败，请稍后重试",
        MISSING_FIELDS: "请填写统一身份认证账号和密码",
      };
      setError(apiError ? codeMessages[apiError.code] ?? apiError.message : "请求失败，请检查网络连接后重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-2 text-xl font-semibold text-foreground">
          {repair ? "重新设置 CQU 密码" : "登录重庆大学统一认证账号"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {repair
            ? "输入统一身份认证账号和新密码。系统会验证新密码，并重新建立 CQU 会话，过程可能需要几分钟。"
            : "输入您的 CQU 统一身份认证账号和密码。系统将立即发起首次登录。由于需要等待 2FA 邮件，此过程可能需要几分钟。"}
        </p>
      </div>

      {error && <AlertBox variant="error">{error}</AlertBox>}

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="field">
          <Label htmlFor="bind-studentId">统一身份认证账号</Label>
          <Input
            id="bind-studentId"
            type="text"
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
            required
            disabled={loading}
            autoComplete="username"
            placeholder="输入您的统一身份认证账号"
          />
        </div>

        <div className="field">
          <Label htmlFor="bind-cquPassword">CQU 统一认证密码</Label>
          <Input
            id="bind-cquPassword"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={loading}
            autoComplete="current-password"
            placeholder="输入 CQU 统一认证密码"
          />
        </div>

        {loading && (
          <div className="rounded-lg border border-link/40 bg-link/10 p-4">
            <div className="mb-2 flex items-center gap-3">
              <Spinner className="text-link" />
              <p className="text-sm font-medium text-foreground">
                {repair ? "正在验证新密码…" : "正在完成首次登录…"}
              </p>
            </div>
            <p className="pl-6 text-xs text-muted-foreground">
              {repair
                ? "系统正在使用新密码重新登录 CQU，可能需要等待 2FA 验证码邮件。请保持页面打开。"
                : "系统正在以您的身份登录 CQU，可能需要等待 2FA 验证码邮件，预计需要 1–5 分钟。请保持页面打开，不要刷新。"}
            </p>
          </div>
        )}

        <ActionButton
          type="submit"
          className="w-full"
          disabled={loading}
          state={loading ? "loading" : "idle"}
          labels={{
            idle: repair ? "保存并重新登录" : "确认绑定",
            loading: repair ? "正在保存，请稍候…" : "首次登录中，请稍候…",
            success: "已完成",
            error: "重试",
          }}
        />
      </form>

      <div className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
        <p className="mb-1 font-medium text-foreground">安全提示</p>
        <p>您的密码将以 AES-256-GCM 加密存储，仅用于维护 CQU 会话，不会明文记录或对外共享。</p>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Main wizard page
// ────────────────────────────────────────────────────────────────────────────

export interface CquBindWizardProps {
  onReturn?: (url: string) => void;
}

const stepForScreen: Record<BindScreen, Step> = {
  intro: 1,
  address: 2,
  credentials: 3,
  waiting: 4,
  complete: 4,
};

export default function CquBindWizard({ onReturn = replaceLocation }: CquBindWizardProps) {
  const location = useLocation();
  const { data: session } = authClient.useSession();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const search = new URLSearchParams(location.search);
  const returnTo = bindingReturnTarget(search.get("redirect"), window.location.origin);
  const repair = search.get("repair") === "1";

  const [screen, setScreen] = useState<BindScreen | null>(null);
  const [bootstrapError, setBootstrapError] = useState(false);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [bindAddress, setBindAddress] = useState("");
  const [bindKind, setBindKind] = useState<BindKind>("direct");
  const [forwardAddress, setForwardAddress] = useState("");
  const [boundThisVisit, setBoundThisVisit] = useState(false);
  const [waitTimedOut, setWaitTimedOut] = useState(false);
  const [pollDelay, setPollDelay] = useState(3000);
  const [pollVersion, setPollVersion] = useState(0);
  const requestSequenceRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const waitStartedAtRef = useRef<number | null>(null);

  const finishBinding = useCallback(() => {
    const storage = progressStorage();
    if (storage && userId) clearBindProgress(storage, userId);
    setBoundThisVisit(true);
    setWaitTimedOut(false);
    waitStartedAtRef.current = null;
    setScreen("complete");
  }, [userId]);

  const checkBindingConfirmation = useCallback(async () => {
    if (!userId) return;
    setScreen("waiting");
    setWaitTimedOut(false);
    if (waitStartedAtRef.current === null) waitStartedAtRef.current = Date.now();

    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    const requestSequence = ++requestSequenceRef.current;

    try {
      const snapshot = await fetchBindingSnapshot(controller.signal);
      if (controller.signal.aborted || requestSequence !== requestSequenceRef.current) return;
      if (snapshot.bindStatus === "active") {
        finishBinding();
        return;
      }
      setPollDelay(3000);
      setPollVersion((value) => value + 1);
    } catch (error) {
      if (controller.signal.aborted || requestSequence !== requestSequenceRef.current) return;
      const temporary = error instanceof BindingRequestError || error instanceof TypeError;
      setPollDelay((value) => temporary ? Math.min(Math.max(value, 3000) * 2, 30000) : 3000);
      setPollVersion((value) => value + 1);
    }
  }, [finishBinding, userId]);

  useEffect(() => {
    if (!userId) return;
    setScreen(null);
    setBootstrapError(false);
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    const requestSequence = ++requestSequenceRef.current;

    void fetchBindingSnapshot(controller.signal)
      .then((snapshot) => {
        if (controller.signal.aborted || requestSequence !== requestSequenceRef.current) return;
        setBindAddress(snapshot.address ?? "");
        if (snapshot.kind) setBindKind(snapshot.kind);
        setForwardAddress(snapshot.forwardAddress ?? "");

        const storage = progressStorage();
        const saved = storage ? readBindProgress(storage, userId) : null;
        const nextScreen = bindScreen(snapshot, saved, userId, repair);
        if (nextScreen === "complete" && returnTo && !repair) {
          onReturn(returnTo);
          return;
        }
        if (nextScreen === "waiting") {
          waitStartedAtRef.current = Date.now();
          setPollDelay(3000);
          setPollVersion((value) => value + 1);
        }
        setScreen(nextScreen);
      })
      .catch(() => {
        if (controller.signal.aborted || requestSequence !== requestSequenceRef.current) return;
        setBootstrapError(true);
      });

    return () => controller.abort();
  }, [bootstrapAttempt, onReturn, repair, returnTo, userId]);

  useEffect(() => {
    if (screen !== "waiting" || waitTimedOut) return;
    const startedAt = waitStartedAtRef.current ?? Date.now();
    waitStartedAtRef.current = startedAt;
    const remaining = 10 * 60 * 1000 - (Date.now() - startedAt);
    if (remaining <= 0) {
      setWaitTimedOut(true);
      return;
    }
    const timer = window.setTimeout(() => {
      if (Date.now() - startedAt >= 10 * 60 * 1000) {
        setWaitTimedOut(true);
        return;
      }
      void checkBindingConfirmation();
    }, Math.min(pollDelay, remaining));
    return () => window.clearTimeout(timer);
  }, [checkBindingConfirmation, pollDelay, pollVersion, screen, waitTimedOut]);

  useEffect(() => () => requestControllerRef.current?.abort(), []);

  const continueToCredentials = () => {
    if (userId && bindAddress) {
      const storage = progressStorage();
      if (storage) {
        writeBindProgress(storage, {
          userId,
          address: bindAddress,
          kind: bindKind,
          step: 3,
        });
      }
    }
    setScreen("credentials");
  };

  const content = bootstrapError ? (
    <div className="space-y-4 text-center">
      <div>
        <h2 className="text-xl font-semibold text-foreground">暂时无法确认绑定状态</h2>
        <p className="mt-2 text-sm text-muted-foreground">请检查网络连接后重试。</p>
      </div>
      <Button
        type="button"
        className="w-full"
        onClick={() => setBootstrapAttempt((value) => value + 1)}
      >
        重试
      </Button>
    </div>
  ) : screen === null ? (
    <div className="flex min-h-24 items-center justify-center gap-3 text-sm text-muted-foreground">
      <Spinner className="text-link" />
      正在确认绑定状态…
    </div>
  ) : screen === "intro" ? (
    <Step1Intro
      onNext={() => setScreen("address")}
      bindKind={bindKind}
      setBindKind={(kind) => {
        setBindKind(kind);
        setBindAddress("");
      }}
      forwardAddress={forwardAddress}
      setForwardAddress={setForwardAddress}
    />
  ) : screen === "address" ? (
    <Step2AddressAndCode
      onNext={continueToCredentials}
      bindAddress={bindAddress}
      setBindAddress={setBindAddress}
      bindKind={bindKind}
      forwardAddress={forwardAddress}
    />
  ) : screen === "credentials" ? (
    <Step3Credentials repair={repair} onSuccess={async () => {
      waitStartedAtRef.current = Date.now();
      setPollDelay(3000);
      await checkBindingConfirmation();
    }} />
  ) : screen === "waiting" ? (
    <div className="space-y-4 text-center">
      <div className="flex justify-center"><Spinner size={32} className="text-link" /></div>
      <div>
        <h2 className="text-xl font-semibold text-foreground">
          {repair
            ? waitTimedOut ? "尚未确认密码更新" : "正在确认密码更新"
            : waitTimedOut ? "尚未确认绑定结果" : "正在确认绑定结果"}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {repair
            ? waitTimedOut ? "新密码可能仍在验证，请重新检查。" : "系统正在使用新密码恢复 CQU 会话。"
            : waitTimedOut ? "首次登录可能仍在处理，请重新检查。" : "首次登录可能需要几分钟。"}
        </p>
      </div>
      {waitTimedOut && (
        <Button
          type="button"
          className="w-full"
          onClick={() => {
            waitStartedAtRef.current = Date.now();
            void checkBindingConfirmation();
          }}
        >
          重新检查
        </Button>
      )}
    </div>
  ) : (
    <CquBindSuccess
      key={returnTo ?? "standalone"}
      returnTo={returnTo}
      autoReturn={boundThisVisit && Boolean(returnTo)}
      onReturn={onReturn}
      title={repair ? "密码已重新设置" : undefined}
      description={repair ? "系统已使用新密码恢复 CQU 会话。" : undefined}
    />
  );

  const currentStep = screen ? stepForScreen[screen] : null;

  return (
    <Layout>
      <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2 text-muted-foreground">
        <Link to="/settings">
          <ArrowLeft aria-hidden="true" />
          返回设置
        </Link>
      </Button>
      <PageHeader
        title={repair ? "重新设置 CQU 密码" : "绑定 CQU 账号"}
        description={repair ? "验证新密码并恢复统一认证会话。" : "按步骤完成统一认证账号绑定。"}
      />
      <div className="content-panel">
        {currentStep && !repair && <StepIndicator current={currentStep} />}
        <div>{content}</div>
      </div>
    </Layout>
  );
}
