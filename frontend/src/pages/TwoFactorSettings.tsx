import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import QRCode from "qrcode";
import Layout from "../components/Layout";
import { authClient } from "../lib/auth-client";
import {
  completeTotpEnrollment,
  createBackupCodesDownload,
  mapAuthError,
  normalizeOtp,
  shouldShowEnrollmentBackupCodes,
} from "../lib/two-factor";

export type EnrollmentStep = "password" | "scan" | "backup-codes" | "complete";
export interface EnrollmentSecret {
  totpURI: string;
  backupCodes: string[];
}

interface TwoFactorSettingsProps {
  /** Used only by the static rendering test to represent an in-progress enrollment. */
  initialEnrollment?: EnrollmentSecret;
}

type AuthError = { code?: string; message?: string } | null | undefined;

function errorMessage(error: AuthError, fallback: string) {
  return mapAuthError(error?.code, error?.message ?? fallback);
}

function PasswordField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-gray-700">当前密码</label>
      <input
        id={id}
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
        autoComplete="current-password"
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  );
}

export function BackupCodes({ codes, onComplete }: { codes: string[]; onComplete: () => void }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);

  const downloadAll = () => {
    const { filename, content } = createBackupCodesDownload(codes);
    const objectUrl = URL.createObjectURL(
      new Blob([content], { type: "text/plain;charset=utf-8" })
    );
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;

    try {
      document.body.appendChild(anchor);
      anchor.click();
    } finally {
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    }
  };

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section aria-labelledby="backup-codes-heading">
      <h2 id="backup-codes-heading" className="text-base font-semibold text-gray-900">保存备用恢复码</h2>
      <p className="mt-1 text-sm text-gray-500">每个恢复码只能使用一次。请将它们保存在安全的位置。</p>
      <div className="mt-4 grid grid-cols-1 gap-2 rounded-xl border border-gray-200 bg-gray-50 p-3 font-mono text-sm text-gray-800 sm:grid-cols-2">
        {codes.map((code) => <code key={code} className="break-all">{code}</code>)}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={downloadAll}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="1.8">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 3v9m0 0 3-3m-3 3-3-3M4 14.5V16h12v-1.5" />
          </svg>
          下载恢复码
        </button>
        <button
          type="button"
          onClick={() => void copyAll()}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
        >
          {copied ? "已复制" : "复制全部"}
        </button>
      </div>
      <label className="mt-4 flex items-start gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
        />
        <span>我已保存这些恢复码，知道关闭此页面后将无法再次查看。</span>
      </label>
      <button
        type="button"
        disabled={!acknowledged}
        onClick={onComplete}
        className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:bg-blue-400"
      >
        完成设置
      </button>
    </section>
  );
}

export default function TwoFactorSettings({ initialEnrollment }: TwoFactorSettingsProps) {
  const { data: session, refetch: refetchSession } = authClient.useSession();
  const sessionUser = session?.user as { twoFactorEnabled?: boolean } | undefined;
  const enabled = sessionUser?.twoFactorEnabled === true;
  const [step, setStep] = useState<EnrollmentStep>(initialEnrollment ? "scan" : "password");
  const [secret, setSecret] = useState<EnrollmentSecret | null>(initialEnrollment ?? null);
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [managementAction, setManagementAction] = useState<"" | "regenerate" | "disable">("");
  const [managementPassword, setManagementPassword] = useState("");
  const [generatedCodes, setGeneratedCodes] = useState<string[] | null>(null);

  const manualSecret = useMemo(() => {
    if (!secret) return "";
    try {
      return new URL(secret.totpURI).searchParams.get("secret") ?? "";
    } catch {
      return "";
    }
  }, [secret]);

  useEffect(() => {
    if (!secret) return;
    let current = true;
    void QRCode.toDataURL(secret.totpURI, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 224,
    }).then((dataUrl) => {
      if (current) setQrDataUrl(dataUrl);
    }).catch(() => {
      if (current) setError("二维码生成失败，请使用手动密钥设置身份验证器");
    });
    return () => { current = false; };
  }, [secret]);

  const beginEnrollment = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setLoading(true);
    const { data, error: authError } = await authClient.twoFactor.enable({ password });
    setLoading(false);
    if (authError || !data) {
      setError(errorMessage(authError, "无法开启二次验证，请检查当前密码"));
      return;
    }
    setPassword("");
    setSecret({ totpURI: data.totpURI, backupCodes: data.backupCodes });
    setStep("scan");
  };

  const verifyTotp = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    const code = normalizeOtp(totpCode);
    if (code.length !== 6) {
      setError("请输入 6 位验证码");
      return;
    }
    setLoading(true);
    const authError = await completeTotpEnrollment({
      verifyTotp: () => authClient.twoFactor.verifyTotp({ code }),
      revealBackupCodes: () => {
        setTotpCode("");
        setStep("backup-codes");
        setLoading(false);
      },
      refetchSession,
    });
    if (authError) {
      setLoading(false);
      setError(errorMessage(authError, "验证失败，请重试"));
      return;
    }
  };

  const submitManagement = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setLoading(true);
    if (managementAction === "regenerate") {
      const { data, error: authError } = await authClient.twoFactor.generateBackupCodes({ password: managementPassword });
      setLoading(false);
      if (authError || !data) {
        setError(errorMessage(authError, "恢复码生成失败，请检查当前密码"));
        return;
      }
      setManagementPassword("");
      setGeneratedCodes(data.backupCodes);
      return;
    }

    const { error: authError } = await authClient.twoFactor.disable({ password: managementPassword });
    setLoading(false);
    if (authError) {
      setError(errorMessage(authError, "关闭失败，请检查当前密码"));
      return;
    }
    setManagementPassword("");
    setManagementAction("");
    setGeneratedCodes(null);
    await refetchSession();
  };

  return (
    <Layout>
      <div className="max-w-2xl">
        <Link to="/settings" className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 transition-colors hover:text-blue-600">
          <span aria-hidden="true">←</span> 返回账户设置
        </Link>
        <div className="rounded-2xl border border-gray-200 bg-white p-6">
          <h1 className="text-xl font-semibold text-gray-900">设置二次验证</h1>
          <p className="mt-1 text-sm text-gray-500">使用身份验证器生成验证码，为账户增加一层保护。</p>
          {error && <p className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}

          {!enabled && step === "password" && (
            <form onSubmit={beginEnrollment} className="mt-6 space-y-4">
              <PasswordField id="two-factor-enrollment-password" value={password} onChange={setPassword} />
              <button type="submit" disabled={loading} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:bg-blue-400">
                {loading ? "验证中..." : "继续"}
              </button>
            </form>
          )}

          {!enabled && step === "scan" && secret && (
            <section className="mt-6" aria-labelledby="scan-authenticator-heading">
              <h2 id="scan-authenticator-heading" className="text-base font-semibold text-gray-900">扫描二维码</h2>
              <p className="mt-1 text-sm text-gray-500">在身份验证器中添加账户后，输入生成的 6 位验证码。</p>
              <img src={qrDataUrl || undefined} alt="二次验证二维码" width={224} height={224} className="mt-4 rounded-lg border border-gray-200 bg-white p-2" />
              <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-3">
                <p className="text-xs font-medium text-gray-600">手动输入密钥</p>
                <code className="mt-1 block break-all text-sm text-gray-900">{manualSecret}</code>
              </div>
              <form onSubmit={verifyTotp} className="mt-4 space-y-4">
                <div>
                  <label htmlFor="two-factor-totp" className="mb-1.5 block text-sm font-medium text-gray-700">身份验证器验证码</label>
                  <input id="two-factor-totp" value={totpCode} onChange={(event) => setTotpCode(normalizeOtp(event.target.value))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} required className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm tracking-[0.25em] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="000000" />
                </div>
                <button type="submit" disabled={loading} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:bg-blue-400">{loading ? "验证中..." : "验证并继续"}</button>
              </form>
            </section>
          )}

          {shouldShowEnrollmentBackupCodes(step, secret !== null) && secret && (
            <div className="mt-6"><BackupCodes codes={secret.backupCodes} onComplete={() => { setSecret(null); setStep("complete"); }} /></div>
          )}
          {step === "complete" && <p className="mt-6 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700" role="status">二次验证已启用。</p>}

          {enabled && step !== "backup-codes" && step !== "complete" && (
            <section className="mt-6" aria-labelledby="manage-two-factor-heading">
              <h2 id="manage-two-factor-heading" className="text-base font-semibold text-gray-900">二次验证已启用</h2>
              <p className="mt-1 text-sm text-gray-500">可生成新的恢复码，或关闭身份验证器保护。</p>
              <div className="mt-4 flex flex-wrap gap-3">
                <button type="button" onClick={() => { setManagementAction("regenerate"); setGeneratedCodes(null); }} className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">重新生成恢复码</button>
                <button type="button" onClick={() => { setManagementAction("disable"); setGeneratedCodes(null); }} className="rounded-lg border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50">关闭二次验证</button>
              </div>
              {managementAction && (
                <form onSubmit={submitManagement} className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-4">
                  <p className={managementAction === "disable" ? "text-sm text-red-700" : "text-sm text-gray-700"}>
                    {managementAction === "disable" ? "关闭后，登录将不再要求身份验证器验证码。" : "重新生成后，旧恢复码将立即失效。"}
                  </p>
                  <PasswordField id="two-factor-management-password" value={managementPassword} onChange={setManagementPassword} />
                  <div className="flex gap-3">
                    <button type="button" onClick={() => setManagementAction("")} disabled={loading} className="rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-200">取消</button>
                    <button type="submit" disabled={loading} className={managementAction === "disable" ? "rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:bg-red-400" : "rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-400"}>{loading ? "处理中..." : managementAction === "disable" ? "确认关闭" : "生成新恢复码"}</button>
                  </div>
                </form>
              )}
              {generatedCodes && <div className="mt-5"><BackupCodes codes={generatedCodes} onComplete={() => setGeneratedCodes(null)} /></div>}
            </section>
          )}
        </div>
      </div>
    </Layout>
  );
}
