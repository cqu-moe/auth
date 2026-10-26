import type { TurnstileVerificationState } from "../lib/use-turnstile";

export default function TurnstileVerification({ verification }: { verification: TurnstileVerificationState }) {
  const { status, waiting, ref } = verification;
  const expanded = status === "interactive" || status === "error";
  const message = status === "error" ? "安全验证加载失败，请重试后再次提交"
    : waiting ? "请完成下方的安全验证，完成后会自动继续。" : "请完成下方的安全验证。";
  return (
    <div className="contents">
      <div className="turnstile-disclosure" data-open={expanded} aria-hidden={!expanded}>
        <div className="turnstile-disclosure-clip">
          <div className="turnstile-disclosure-content">
            {expanded && (
              <p className={`text-sm ${status === "error" ? "text-destructive" : "text-muted-foreground"}`} role="status" aria-live="polite" aria-atomic="true">
                {message}
              </p>
            )}
            <div ref={ref} className="flex justify-center" />
          </div>
        </div>
      </div>
    </div>
  );
}
