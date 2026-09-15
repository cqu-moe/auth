import type { ReasonCode } from '../quicklogin/protocol-v3';

const CODES = new Set(['PASSWORD_REJECTED', 'FIRST_FACTOR_UNRECOGNIZED', 'CAPTCHA_REQUIRED', 'OTP_SEND_FAILED', 'OTP_SEND_TIMEOUT', 'OTP_TIMEOUT', 'CODE_PERMIT_TIMEOUT', 'VERIFICATION_COOLDOWN', 'BROWSER_DEADLINE', 'BROWSER_BUSY', 'BROWSER_INSTANCE_REPLACED', 'CONTAINER_UNAVAILABLE', 'WAF_CHALLENGE', 'TICKET_MISSING', 'UNKNOWN_LOGIN_ERROR']);

function legacyCode(error: unknown): string {
  if (typeof error !== 'string') return 'UNKNOWN_LOGIN_ERROR';
  const raw = error.trim();
  if (CODES.has(raw)) return raw;
  if (raw.startsWith('first-factor failed: credential_rejected:')) return 'PASSWORD_REJECTED';
  if (raw.startsWith('first-factor failed:')) return 'FIRST_FACTOR_UNRECOGNIZED';
  if (raw.startsWith('发码失败 status=')) return 'OTP_SEND_FAILED';
  if (raw.startsWith('发码响应超时')) return 'OTP_SEND_TIMEOUT';
  if (['code wait timed out', '等验证码超时', '未取到验证码', 'reusable code never arrived'].some(prefix => raw.startsWith(prefix))) return 'OTP_TIMEOUT';
  if (raw.startsWith('code permit timed out') || raw.startsWith('code permit phase timed out')) return 'CODE_PERMIT_TIMEOUT';
  if (raw.startsWith('login timed out')) return 'BROWSER_DEADLINE';
  if (raw.startsWith('未捕获 ST ticket')) return 'TICKET_MISSING';
  return 'UNKNOWN_LOGIN_ERROR';
}

export function classifyContainerLoginFailure(result: { errorCode?: unknown; error?: unknown } | null): {
  code: string;
  reasonCode: ReasonCode;
  reauthReason: 'credentials_rejected' | 'interactive_required' | null;
} {
  const code = typeof result?.errorCode === 'string'
    ? CODES.has(result.errorCode) ? result.errorCode : 'UNKNOWN_LOGIN_ERROR'
    : legacyCode(result?.error);
  const reauthReason = code === 'PASSWORD_REJECTED' ? 'credentials_rejected' : code === 'CAPTCHA_REQUIRED' ? 'interactive_required' : null;
  const reasons: Record<string, ReasonCode> = {
    PASSWORD_REJECTED: 'CREDENTIALS_REJECTED', CAPTCHA_REQUIRED: 'INTERACTION_REQUIRED',
    OTP_SEND_FAILED: 'OTP_SEND_FAILED', OTP_SEND_TIMEOUT: 'OTP_TIMEOUT', OTP_TIMEOUT: 'OTP_TIMEOUT',
    CODE_PERMIT_TIMEOUT: 'VERIFICATION_COOLDOWN', VERIFICATION_COOLDOWN: 'VERIFICATION_COOLDOWN',
    BROWSER_DEADLINE: 'OPERATION_TIMEOUT', BROWSER_BUSY: 'CONTAINER_UNAVAILABLE',
    BROWSER_INSTANCE_REPLACED: 'CONTAINER_UNAVAILABLE', CONTAINER_UNAVAILABLE: 'CONTAINER_UNAVAILABLE',
    WAF_CHALLENGE: 'WAF_CHALLENGE',
  };
  return { code, reasonCode: reasons[code] ?? 'SCHOOL_UNREACHABLE', reauthReason };
}
