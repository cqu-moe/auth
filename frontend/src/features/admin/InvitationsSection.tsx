import { useState, useEffect, useCallback } from "react";
import { Plus } from "lucide-react";
import {
  Alert,
  AlertDescription,
  Button,
  Input,
  PageState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@cqu-moe/ui";
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

const statusBadge: Record<InvitationStatus, { label: string; variant: string }> = {
  active: { label: "可使用", variant: "badge-success" },
  in_use: { label: "注册中", variant: "badge-info" },
  expired: { label: "已过期", variant: "badge-muted" },
  used: { label: "已使用", variant: "badge-info" },
  revoked: { label: "已撤销", variant: "badge-destructive" },
};

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

  if (loading) {
    return (
      <PageState state="loading" title="正在加载注册邀请" description="正在读取邀请与注册政策…" />
    );
  }

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-border bg-muted p-4">
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
          <p className="mt-1 text-xs text-muted-foreground">保存中…</p>
        )}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 max-w-xs flex-1">
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
            className="w-full"
          />
        </div>
        <Button
          type="button"
          onClick={createInvitation}
          disabled={creating}
        >
          <Plus aria-hidden="true" size={16} />
          {creating ? "生成中…" : "生成邀请"}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {created && (
        <div className="rounded-lg border border-link/40 bg-link/10 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-foreground">注册链接已生成</p>
              <p className="mt-1 font-mono text-xl font-semibold tracking-widest text-foreground">
                {created.code}
              </p>
            </div>
            <CopyButton value={created.code} />
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Input
              readOnly
              value={created.registrationUrl}
              className="flex-1"
              aria-label="注册链接"
            />
            <CopyButton value={created.registrationUrl} />
          </div>
        </div>
      )}

      {invitations.length === 0 ? (
        <PageState state="empty" title="暂无注册邀请" description="生成邀请码后，会显示在这里。" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-left">邀请码</TableHead>
                <TableHead className="text-left">状态</TableHead>
                <TableHead className="text-left">权益</TableHead>
                <TableHead className="text-left">过期时间</TableHead>
                <TableHead className="text-left">使用情况</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map((invitation) => {
                const meta = statusBadge[invitation.status];
                const registrationUrl = `${window.location.origin}/register?code=${encodeURIComponent(invitation.code)}`;
                return (
                  <TableRow key={invitation.code}>
                    <TableCell>
                      <span className="font-mono font-semibold tracking-wider text-foreground">
                        {invitation.code}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className={`badge ${meta.variant}`}>{meta.label}</span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {invitation.preset ?? "默认"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(invitation.expiresAt).toLocaleString("zh-CN")}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {invitation.usedByUserId
                        ? `用户 ${invitation.usedByUserId}`
                        : invitation.claimedByEmail ?? "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-2">
                        <CopyButton value={registrationUrl} />
                        {(invitation.status === "active" || invitation.status === "expired") && (
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() => revokeInvitation(invitation.code)}
                            disabled={revoking === invitation.code}
                          >
                            {revoking === invitation.code ? "撤销中…" : "撤销"}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
