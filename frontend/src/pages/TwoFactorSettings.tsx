import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Download } from "lucide-react";
import QRCode from "qrcode";
import {
  ActionButton,
  Alert,
  AlertDescription,
  Button,
  Checkbox,
  Input,
  Label,
  PageHeader,
} from "@cqu-moe/ui";
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
    <div className="field">
      <Label htmlFor={id}>当前密码</Label>
      <Input
        id={id}
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
        autoComplete="current-password"
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
      <h2 id="backup-codes-heading" className="text-base font-semibold text-foreground">保存备用恢复码</h2>
      <p className="mt-1 text-sm text-muted-foreground">每个恢复码只能使用一次。请将它们保存在安全的位置。</p>
      <div className="mt-4 grid grid-cols-1 gap-2 rounded-lg border border-border bg-muted p-3 font-mono text-sm text-foreground sm:grid-cols-2">
        {codes.map((code) => <code key={code} className="break-all">{code}</code>)}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" onClick={downloadAll}>
          <Download aria-hidden="true" />
          下载恢复码
        </Button>
        <Button type="button" variant="outline" onClick={() => void copyAll()}>
          {copied ? "已复制" : "复制全部"}
        </Button>
      </div>
      <label className="mt-4 flex items-start gap-2 text-sm text-foreground">
        <Checkbox
          checked={acknowledged}
          onCheckedChange={(checked) => setAcknowledged(checked === true)}
        />
        <span>我已保存这些恢复码，知道关闭此页面后将无法再次查看。</span>
      </label>
      <Button type="button" disabled={!acknowledged} onClick={onComplete} className="mt-4">
        完成设置
      </Button>
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
    if (!("totpURI" in data)) {
      setError("无法获取身份验证器配置，请稍后重试");
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
      <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2 text-muted-foreground">
        <Link to="/settings">
          <ArrowLeft aria-hidden="true" />
          返回账户设置
        </Link>
      </Button>
      <PageHeader
        title="设置二次验证"
        description="使用身份验证器生成验证码，为账户增加一层保护。"
      />
      <div className="rounded-lg border border-border bg-surface p-6">
        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!enabled && step === "password" && (
          <form onSubmit={beginEnrollment} className="space-y-4" noValidate>
            <PasswordField id="two-factor-enrollment-password" value={password} onChange={setPassword} />
            <ActionButton
              type="submit"
              disabled={loading}
              state={loading ? "loading" : "idle"}
              labels={{ idle: "继续", loading: "验证中…", success: "已验证", error: "重试" }}
            />
          </form>
        )}

        {!enabled && step === "scan" && secret && (
          <section aria-labelledby="scan-authenticator-heading">
            <h2 id="scan-authenticator-heading" className="text-base font-semibold text-foreground">扫描二维码</h2>
            <p className="mt-1 text-sm text-muted-foreground">在身份验证器中添加账户后，输入生成的 6 位验证码。</p>
            <img src={qrDataUrl || undefined} alt="二次验证二维码" width={224} height={224} className="mt-4 rounded-lg border border-border bg-surface p-2" />
            <div className="mt-4 rounded-lg border border-border bg-muted p-3">
              <p className="text-xs font-medium text-muted-foreground">手动输入密钥</p>
              <code className="mt-1 block break-all text-sm text-foreground">{manualSecret}</code>
            </div>
            <form onSubmit={verifyTotp} className="mt-4 space-y-4" noValidate>
              <div className="field">
                <Label htmlFor="two-factor-totp">身份验证器验证码</Label>
                <Input
                  id="two-factor-totp"
                  value={totpCode}
                  onChange={(event) => setTotpCode(normalizeOtp(event.target.value))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={6}
                  required
                  className="font-mono tracking-widest"
                  placeholder="000000"
                />
              </div>
              <ActionButton
                type="submit"
                disabled={loading}
                state={loading ? "loading" : "idle"}
                labels={{ idle: "验证并继续", loading: "验证中…", success: "已验证", error: "重试验证" }}
              />
            </form>
          </section>
        )}

        {shouldShowEnrollmentBackupCodes(step, secret !== null) && secret && (
          <div className="mt-6"><BackupCodes codes={secret.backupCodes} onComplete={() => { setSecret(null); setStep("complete"); }} /></div>
        )}
        {step === "complete" && (
          <p className="mt-6 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success" role="status">二次验证已启用。</p>
        )}

        {enabled && step !== "backup-codes" && step !== "complete" && (
          <section aria-labelledby="manage-two-factor-heading">
            <h2 id="manage-two-factor-heading" className="text-base font-semibold text-foreground">二次验证已启用</h2>
            <p className="mt-1 text-sm text-muted-foreground">可生成新的恢复码，或关闭身份验证器保护。</p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button type="button" variant="outline" onClick={() => { setManagementAction("regenerate"); setGeneratedCodes(null); }}>
                重新生成恢复码
              </Button>
              <Button type="button" variant="destructive" onClick={() => { setManagementAction("disable"); setGeneratedCodes(null); }}>
                关闭二次验证
              </Button>
            </div>
            {managementAction && (
              <form onSubmit={submitManagement} className="mt-4 space-y-4 rounded-lg border border-border bg-muted p-4" noValidate>
                <p className={managementAction === "disable" ? "text-sm text-destructive" : "text-sm text-foreground"}>
                  {managementAction === "disable" ? "关闭后，登录将不再要求身份验证器验证码。" : "重新生成后，旧恢复码将立即失效。"}
                </p>
                <PasswordField id="two-factor-management-password" value={managementPassword} onChange={setManagementPassword} />
                <div className="flex gap-3">
                  <Button type="button" variant="outline" onClick={() => setManagementAction("")} disabled={loading}>
                    取消
                  </Button>
                  <ActionButton
                    type="submit"
                    variant={managementAction === "disable" ? "destructive" : "default"}
                    disabled={loading}
                    state={loading ? "loading" : "idle"}
                    labels={{
                      idle: managementAction === "disable" ? "确认关闭" : "生成新恢复码",
                      loading: "处理中…",
                      success: "已完成",
                      error: "重试",
                    }}
                  />
                </div>
              </form>
            )}
            {generatedCodes && <div className="mt-5"><BackupCodes codes={generatedCodes} onComplete={() => setGeneratedCodes(null)} /></div>}
          </section>
        )}
      </div>
    </Layout>
  );
}
