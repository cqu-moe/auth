import { Check, ShieldCheck } from "lucide-react";
import { refreshLoginSession } from "../lib/refresh-login-session";
import { getPostAuthNavigationDestination } from "../lib/login-routing";
import { useAuthHandoff } from "../lib/use-auth-handoff";
import { FormEvent, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ActionButton,
  Checkbox,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@cqu-moe/ui";
import PassportStep from "../components/PassportStep";
import { VerificationCodeInput } from "../components/VerificationCodeInput";
import { authClient } from "../lib/auth-client";
import {
  sanitizePostLoginRedirect,
  withRedirectParam,
} from "../lib/post-login-redirect";
import { normalizeOtp } from "../lib/two-factor";
import {
  getLoginChallengeError,
  loginChallengeMethods,
  verifyLoginChallenge,
  type LoginChallengeActions,
  type LoginChallengeError,
  type LoginChallengeMethod,
} from "../lib/two-factor-challenge";

const nativeTwoFactorActions: LoginChallengeActions = {
  verifyTotp: (input) => authClient.twoFactor.verifyTotp(input),
  verifyBackupCode: (input) => authClient.twoFactor.verifyBackupCode(input),
};

function ChallengeProgress() {
  return <div className="challenge-progress" aria-hidden="true">
    <span className="challenge-origin"><Check size={16} />账号登录</span>
    <span className="challenge-bridge" />
    <span className="challenge-destination"><ShieldCheck size={18} />身份确认</span>
  </div>;
}

export default function TwoFactorChallenge() {
  const handoff = useAuthHandoff();
  const [searchParams] = useSearchParams();
  const postLoginRedirect = sanitizePostLoginRedirect(searchParams.get("redirect"));
  const [method, setMethod] = useState<LoginChallengeMethod>("totp");
  const [methodChanged, setMethodChanged] = useState(false);
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState("");
  const [challengeExpired, setChallengeExpired] = useState(false);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const errorId = "two-factor-challenge-error";
  const showError = (responseError: LoginChallengeError, fallback: string) => {
    const mapped = getLoginChallengeError(responseError, fallback);
    setChallengeExpired(mapped.expired);
    setError(mapped.message);
  };

  const selectMethod = (nextMethod: string) => {
    if (nextMethod === method || loadingRef.current) return;
    setMethodChanged(true);
    setMethod(nextMethod as LoginChallengeMethod);
    setCode("");
    setError("");
    setChallengeExpired(false);
  };

  const handleVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loadingRef.current || challengeExpired) return;
    setError("");
    setChallengeExpired(false);

    const value = method === "backup-code" ? code.trim() : normalizeOtp(code);
    if (!value || (method === "totp" && value.length !== 6)) {
      setError(method === "backup-code" ? "请输入备用恢复码" : "请输入六位验证码");
      return;
    }

    setLoading(true);
    loadingRef.current = true;
    try {
      const result = await verifyLoginChallenge(
        nativeTwoFactorActions,
        method,
        value,
        trustDevice
      );

      if (result.error) {
        showError(result.error, "验证失败，请重试");
        return;
      }
      const session = await refreshLoginSession();
      handoff.go(getPostAuthNavigationDestination(session.user.emailVerified, postLoginRedirect));
    } catch {
      setError("网络错误，请检查连接后重试");
    } finally {
      if (handoff.canRetry()) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  };

  const isBackupCode = method === "backup-code";

  return (
    <PassportStep title="二次验证" description="请选择一种已启用的方式完成登录。" progress={<ChallengeProgress />}>
      <Tabs value={method} onValueChange={selectMethod}>
        <TabsList aria-label="验证方式" className="challenge-methods w-full" data-method={method}>
          {loginChallengeMethods.map(({ value, label }) => (
            <TabsTrigger key={value} value={value} className="challenge-method flex-1" disabled={loading}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={method} className="mt-5">
          <form id="two-factor-challenge" method="post" onSubmit={handleVerify} className="space-y-4" aria-busy={loading} noValidate>
            <div className="field" key={method} data-challenge-field={methodChanged ? method : undefined}>
              <Label htmlFor="twoFactorCode">{isBackupCode ? "备用恢复码" : "六位验证码"}</Label>
              {isBackupCode ? (
                <Input
                  id="twoFactorCode"
                  value={code}
                  onChange={(event) => { setCode(event.target.value); if (!challengeExpired) setError(""); }}
                  inputMode="text"
                  autoComplete="off"
                  required
                  disabled={challengeExpired}
                  readOnly={loading}
                  placeholder="输入备用恢复码"
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? errorId : undefined}
                />
              ) : (
                <VerificationCodeInput
                  id="twoFactorCode"
                  value={code}
                  onChange={(value) => {
                    setCode(value);
                    if (!challengeExpired) setError("");
                  }}
                  disabled={challengeExpired}
                  readOnly={loading}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? errorId : undefined}
                />
              )}
              <div className="login-feedback" aria-live="polite">
                {error && <p className="field-error" id={errorId}>
                  <span>{error}{challengeExpired && <> <Link to={withRedirectParam("/login", postLoginRedirect)} className="underline">返回登录</Link></>}</span>
                </p>}
              </div>
            </div>

            <label className="flex min-h-11 items-center gap-3">
              <Checkbox
                checked={trustDevice}
                onCheckedChange={(checked) => setTrustDevice(checked === true)}
                disabled={loading || challengeExpired}
                aria-label="在这台设备上保持信任 30 天"
              />
              <span className="text-sm text-muted-foreground">在这台设备上保持信任 30 天</span>
            </label>

            <ActionButton
              type="submit"
              className="w-full"
              disabled={loading || challengeExpired}
              state={loading ? "loading" : error ? "error" : "idle"}
              labels={{
                idle: "完成验证",
                loading: "验证中…",
                success: "已验证",
                error: "重试验证",
              }}
            />
          </form>
        </TabsContent>
      </Tabs>
    </PassportStep>
  );
}
