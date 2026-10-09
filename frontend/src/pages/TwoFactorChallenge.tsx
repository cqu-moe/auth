import { FormEvent, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  ActionButton,
  Alert,
  AlertDescription,
  Checkbox,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@cqu-moe/ui";
import AuthLayout from "../components/AuthLayout";
import { authClient } from "../lib/auth-client";
import {
  isExternalHttpTarget,
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

export default function TwoFactorChallenge() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { refetch: refetchSession } = authClient.useSession();
  const postLoginRedirect = sanitizePostLoginRedirect(searchParams.get("redirect"));
  const [method, setMethod] = useState<LoginChallengeMethod>("totp");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState("");
  const [challengeExpired, setChallengeExpired] = useState(false);
  const [loading, setLoading] = useState(false);
  const showError = (responseError: LoginChallengeError, fallback: string) => {
    const mapped = getLoginChallengeError(responseError, fallback);
    setChallengeExpired(mapped.expired);
    setError(mapped.message);
  };

  const selectMethod = (nextMethod: string) => {
    setMethod(nextMethod as LoginChallengeMethod);
    setCode("");
    setError("");
    setChallengeExpired(false);
  };

  const handleVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setChallengeExpired(false);

    const value = method === "backup-code" ? code.trim() : normalizeOtp(code);
    if (!value) {
      setError(method === "backup-code" ? "请输入备用恢复码" : "请输入六位验证码");
      return;
    }

    setLoading(true);
    const result = await verifyLoginChallenge(
      nativeTwoFactorActions,
      method,
      value,
      trustDevice,
      refetchSession
    );
    setLoading(false);

    if (result.error) {
      showError(result.error, "验证失败，请重试");
      return;
    }
    const destination = postLoginRedirect ?? "/settings";
    if (isExternalHttpTarget(destination)) {
      window.location.assign(destination);
      return;
    }
    navigate(destination, { replace: true });
  };

  const isBackupCode = method === "backup-code";

  return (
    <AuthLayout title="二次验证" description="请选择一种已启用的方式完成登录。">
      <Tabs value={method} onValueChange={selectMethod}>
        <TabsList aria-label="验证方式" className="w-full">
          {loginChallengeMethods.map(({ value, label }) => (
            <TabsTrigger key={value} value={value} className="flex-1">
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        {loginChallengeMethods.map(({ value }) => (
          <TabsContent key={value} value={value} className="mt-5" />
        ))}
      </Tabs>

      {error && (
        <Alert variant="destructive" className="mt-5">
          <AlertDescription>
            {error}{" "}
            {challengeExpired && (
              <Link
                to={withRedirectParam("/login", postLoginRedirect)}
                className="underline"
              >
                返回登录
              </Link>
            )}
          </AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleVerify} className="mt-5 space-y-4" noValidate>
        <div className="field">
          <Label htmlFor="twoFactorCode">{isBackupCode ? "备用恢复码" : "六位验证码"}</Label>
          <Input
            id="twoFactorCode"
            value={code}
            onChange={(event) =>
              setCode(isBackupCode ? event.target.value : normalizeOtp(event.target.value))
            }
            inputMode={isBackupCode ? "text" : "numeric"}
            autoComplete="one-time-code"
            maxLength={isBackupCode ? undefined : 6}
            required
            disabled={loading || challengeExpired}
            className={isBackupCode ? undefined : "font-mono tracking-widest"}
            placeholder={isBackupCode ? "输入备用恢复码" : "000000"}
          />
        </div>

        <label className="flex items-start gap-3">
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
          disabled={challengeExpired}
          state={loading ? "loading" : error ? "error" : "idle"}
          labels={{
            idle: "完成验证",
            loading: "验证中…",
            success: "已验证",
            error: "重试验证",
          }}
        />
      </form>
    </AuthLayout>
  );
}
