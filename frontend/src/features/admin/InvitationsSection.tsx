import { useState, useEffect, useCallback } from "react";
import MenuSelect from "../../components/MenuSelect";
import type { EntitlementItem } from "../../components/entitlement-form";
import { adminFetch } from "../../lib/api/admin";
import { CopyButton, FieldLabel, Toggle } from "./ui";


interface EntitlementPreset {
  name: string;
  items: EntitlementItem[];
  updatedAt?: string;
}

type InvitationStatus = "active" | "in_use" | "expired" | "used" | "revoked";

interface RegistrationInvitation {
  code: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  claimedByEmail: string | null;
  usedAt: string | null;
  usedByUserId: string | null;
  revokedAt: string | null;
  preset: string | null;
  status: InvitationStatus;
}

interface CreatedRegistrationInvitation extends RegistrationInvitation {
  registrationUrl: string;
}

// Full OAuth client config as returned by GET /admin/oauth-clients (snake_case).

// Read the message from a non-2xx response. The backend's errorResponse shape is
// { detail: { error: { code, message } } }, so read that path (not body.error).
async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as {
      detail?: { error?: { message?: string } };
    };
    return body?.detail?.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export function InvitationsSection() {
  const [invitations, setInvitations] = useState<RegistrationInvitation[]>([]);
  const [created, setCreated] = useState<CreatedRegistrationInvitation | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState("");
  // 注册政策:是否强制邀请码;savingPolicy 期间禁用开关防连点。
  const [invitationRequired, setInvitationRequired] = useState(true);
  const [savingPolicy, setSavingPolicy] = useState(false);
  // 生成邀请时可选的权益预设("" = 跟随全局默认权益)。
  const [presets, setPresets] = useState<EntitlementPreset[]>([]);
  const [createPreset, setCreatePreset] = useState("");

  const fetchInvitations = useCallback(async () => {
    setLoading(true);
    try {
      const [res, settingsRes, presetsRes] = await Promise.all([
        adminFetch("/admin/registration-invitations"),
        adminFetch("/admin/registration-settings"),
        adminFetch("/admin/entitlement-presets"),
      ]);
      if (!res.ok) {
        setError(await readErrorMessage(res, "加载注册邀请失败"));
        return;
      }
      const body = (await res.json()) as { data: RegistrationInvitation[] };
      setInvitations(body.data ?? []);
      if (settingsRes.ok) {
        const settings = (await settingsRes.json()) as { invitationRequired?: boolean };
        if (typeof settings.invitationRequired === "boolean") {
          setInvitationRequired(settings.invitationRequired);
        }
      }
      if (presetsRes.ok) {
        const data = (await presetsRes.json()) as { data: EntitlementPreset[] };
        setPresets(data.data ?? []);
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchInvitations();
  }, [fetchInvitations]);

  const togglePolicy = async (required: boolean) => {
    setSavingPolicy(true);
    setError("");
    try {
      const res = await adminFetch("/admin/registration-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitationRequired: required }),
      });
      if (res.ok) {
        setInvitationRequired(required);
      } else if (res.status === 403) {
        setError("需要 superAdmin 权限");
      } else {
        setError(await readErrorMessage(res, "保存注册政策失败"));
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setSavingPolicy(false);
    }
  };

  const createInvitation = async () => {
    setCreating(true);
    setError("");
    try {
      const res = await adminFetch("/admin/registration-invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset: createPreset || null }),
      });
      if (!res.ok) {
        setError(await readErrorMessage(res, "生成邀请码失败"));
        return;
      }
      const body = (await res.json()) as { data: CreatedRegistrationInvitation };
      setCreated(body.data);
      await fetchInvitations();
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setCreating(false);
    }
  };

  const revokeInvitation = async (code: string) => {
    setRevoking(code);
    setError("");
    try {
      const res = await adminFetch(
        `/admin/registration-invitations/${encodeURIComponent(code)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        setError(await readErrorMessage(res, "撤销邀请码失败"));
        return;
      }
      await fetchInvitations();
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setRevoking(null);
    }
  };

  const statusMeta: Record<
    InvitationStatus,
    { label: string; className: string }
  > = {
    active: { label: "可使用", className: "bg-green-100 text-green-700" },
    in_use: { label: "注册中", className: "bg-blue-100 text-blue-700" },
    expired: { label: "已过期", className: "bg-gray-100 text-gray-600" },
    used: { label: "已使用", className: "bg-purple-100 text-purple-700" },
    revoked: { label: "已撤销", className: "bg-red-100 text-red-700" },
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-gray-400 text-sm py-8">
        <div className="w-5 h-5 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
        加载中...
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* --- 注册政策开关 --- */}
      <div className="border border-gray-100 bg-gray-50 rounded-xl p-4">
        <Toggle
          checked={invitationRequired}
          onChange={(v) => void togglePolicy(v)}
          label="强制邀请码注册"
          hint={
            invitationRequired
              ? "未填写邀请码无法注册;邀请码可携带指定权益预设。"
              : "任何人都能注册,未填邀请码的新用户套用「权益预设」页的默认权益。"
          }
        />
        {savingPolicy && (
          <p className="mt-1 text-xs text-gray-400">保存中...</p>
        )}
      </div>

      {/* --- 生成邀请 --- */}
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0 flex-1 max-w-xs">
          <FieldLabel hint="使用该邀请码注册的用户获得对应权益">注册后权益</FieldLabel>
          <MenuSelect
            value={createPreset}
            onChange={setCreatePreset}
            options={[
              { value: "", label: "跟随默认权益" },
              ...presets.map((p) => ({
                value: p.name,
                label: p.name,
                hint: `${p.items.length} 项能力`,
              })),
            ]}
            aria-label="新邀请的权益预设"
            buttonClassName="w-full justify-between px-3 py-2"
          />
        </div>
        <button
          type="button"
          onClick={createInvitation}
          disabled={creating}
          className="shrink-0 px-3 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white transition-colors"
        >
          {creating ? "生成中..." : "+ 生成邀请"}
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
          <button onClick={() => setError("")} className="ml-2 underline">关闭</button>
        </div>
      )}

      {created && (
        <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-blue-900">注册链接已生成</p>
              <p className="mt-1 text-xl font-mono font-semibold tracking-widest text-blue-800">
                {created.code}
              </p>
            </div>
            <CopyButton value={created.code} />
          </div>
          <div className="mt-3 flex items-center gap-2">
            <input
              readOnly
              value={created.registrationUrl}
              className="min-w-0 flex-1 px-3 py-2 text-xs border border-blue-200 rounded-lg bg-white text-gray-600"
              aria-label="注册链接"
            />
            <CopyButton value={created.registrationUrl} />
          </div>
        </div>
      )}

      {invitations.length === 0 ? (
        <p className="text-sm text-gray-400 py-4">暂无注册邀请</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-3 px-3 text-xs font-semibold text-gray-500">邀请码</th>
                <th className="text-left py-3 px-3 text-xs font-semibold text-gray-500">状态</th>
                <th className="text-left py-3 px-3 text-xs font-semibold text-gray-500">权益</th>
                <th className="text-left py-3 px-3 text-xs font-semibold text-gray-500">过期时间</th>
                <th className="text-left py-3 px-3 text-xs font-semibold text-gray-500">使用情况</th>
                <th className="text-right py-3 px-3 text-xs font-semibold text-gray-500">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {invitations.map((invitation) => {
                const meta = statusMeta[invitation.status];
                const registrationUrl = `${window.location.origin}/register?code=${encodeURIComponent(invitation.code)}`;
                return (
                  <tr key={invitation.code} className="hover:bg-gray-50">
                    <td className="py-3 px-3">
                      <span className="font-mono font-semibold tracking-wider text-gray-900">
                        {invitation.code}
                      </span>
                    </td>
                    <td className="py-3 px-3">
                      <span className={`inline-flex text-xs font-medium px-2 py-0.5 rounded-full ${meta.className}`}>
                        {meta.label}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-xs text-gray-500">
                      {invitation.preset ?? <span className="text-gray-400">默认</span>}
                    </td>
                    <td className="py-3 px-3 text-xs text-gray-500 whitespace-nowrap">
                      {new Date(invitation.expiresAt).toLocaleString("zh-CN")}
                    </td>
                    <td className="py-3 px-3 text-xs text-gray-500">
                      {invitation.usedByUserId
                        ? `用户 ${invitation.usedByUserId}`
                        : invitation.claimedByEmail ?? "—"}
                    </td>
                    <td className="py-3 px-3">
                      <div className="flex items-center justify-end gap-2">
                        <CopyButton value={registrationUrl} />
                        {(invitation.status === "active" || invitation.status === "expired") && (
                          <button
                            type="button"
                            onClick={() => revokeInvitation(invitation.code)}
                            disabled={revoking === invitation.code}
                            className="px-2.5 py-1.5 text-xs font-medium rounded-lg text-red-600 hover:bg-red-50 disabled:opacity-50 transition-colors"
                          >
                            {revoking === invitation.code ? "撤销中..." : "撤销"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
