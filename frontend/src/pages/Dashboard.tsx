import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Layout from "../components/UserCenterLayout";
import { Card, CardHeader, Badge } from "../components/ui";
import { useCaps, capsToView } from "../lib/caps";
import { authClient } from "../lib/auth-client";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface CquSessionStatus {
  status?: string;
  studentId?: string;
  error?: boolean;
}

interface CquBindStatus {
  address?: string;
  bindStatus: "pending" | "active" | "revoked" | "unbound";
  sessionStatus: CquSessionStatus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SUBSYSTEM_LABELS: Record<string, string> = {
  calendar: "日历",
  eval: "评教",
};

// ─────────────────────────────────────────────────────────────────────────────
// AccountCard — 账户摘要
// ─────────────────────────────────────────────────────────────────────────────

function AccountCard() {
  const { data: session } = authClient.useSession();
  const user = session?.user as
    | { name?: string; email?: string; role?: string }
    | undefined;

  const roleBadge = (() => {
    if (user?.role === "superAdmin")
      return <Badge variant="blue" dot={false}>超级管理员</Badge>;
    if (user?.role === "admin")
      return <Badge variant="blue" dot={false}>管理员</Badge>;
    return <Badge variant="gray" dot={false}>普通用户</Badge>;
  })();

  return (
    <Card>
      <CardHeader title="账户摘要" />
      <div className="px-6 pb-6 pt-2 space-y-3">
        {/* Avatar row */}
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 text-lg font-bold shrink-0 select-none">
            {user?.name?.[0]?.toUpperCase() ?? user?.email?.[0]?.toUpperCase() ?? "?"}
          </div>
          <div className="min-w-0">
            {user?.name && (
              <p className="text-sm font-semibold text-gray-900 truncate">{user.name}</p>
            )}
            <p className="text-sm text-gray-500 truncate">{user?.email ?? "—"}</p>
          </div>
        </div>
        {/* Role */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-500">角色</span>
          {roleBadge}
        </div>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CquSnapshotCard — CQU 绑定快照
// ─────────────────────────────────────────────────────────────────────────────

function CquSnapshotCard() {
  const [data, setData] = useState<CquBindStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/cqu/binding", { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json() as Promise<CquBindStatus>;
      })
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const sessionBadge = (() => {
    if (!data || data.bindStatus === "unbound") return null;
    const ss = data.sessionStatus;
    if (ss.error === true) return <Badge variant="gray">状态未知</Badge>;
    if (ss.status === "active") return <Badge variant="green">正常</Badge>;
    return <Badge variant="yellow">需要重新登录</Badge>;
  })();

  return (
    <Card>
      <CardHeader title="CQU 账户" />
      <div className="px-6 pb-6 pt-2">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <span className="inline-block w-4 h-4 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
            加载中…
          </div>
        )}
        {!loading && error && (
          <p className="text-sm text-red-500">获取绑定信息失败，请稍后重试。</p>
        )}
        {!loading && !error && data?.bindStatus === "unbound" && (
          <div className="space-y-3">
            <p className="text-sm text-gray-500">尚未绑定 CQU 账户。</p>
            <Link
              to="/cqu"
              className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-700"
            >
              去绑定 →
            </Link>
          </div>
        )}
        {!loading && !error && data && data.bindStatus !== "unbound" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">学号</span>
              <span className="text-sm font-medium text-gray-900">
                {data.sessionStatus.studentId ?? "—"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">会话状态</span>
              {sessionBadge}
            </div>
            <div className="pt-1">
              <Link
                to="/cqu"
                className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                管理 →
              </Link>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EntitlementsCard — 我的权益
// ─────────────────────────────────────────────────────────────────────────────

function EntitlementsCard() {
  const caps = useCaps();
  const subsystems = ["calendar", "eval"] as const;

  return (
    <Card>
      <CardHeader
        title="我的权益"
        desc="如需开通更多能力，请联系管理员。"
      />
      <div className="px-6 pb-6 pt-2 space-y-6">
        {subsystems.map((sub) => {
          const rows = capsToView(caps, sub);
          return (
            <div key={sub}>
              {/* Subsystem subheading */}
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
                {SUBSYSTEM_LABELS[sub]}
              </h4>
              {/* Rows */}
              <div className="divide-y divide-gray-100 rounded-xl border border-gray-100 overflow-hidden">
                {rows.map((row) => (
                  <div
                    key={row.key}
                    className="flex items-center justify-between px-4 py-2.5 bg-gray-50/50"
                  >
                    <span className="text-sm text-gray-600">{row.label}</span>
                    {row.type === "flag" ? (
                      <Badge variant={row.value ? "green" : "gray"}>
                        {row.display}
                      </Badge>
                    ) : (
                      <span className="text-sm font-medium text-gray-900">
                        {row.display}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard — page root
// ─────────────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  return (
    <Layout>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">概览</h1>

      {/* Top row: account summary + CQU snapshot side by side on md+ */}
      <div className="grid md:grid-cols-2 gap-6 mb-6">
        <AccountCard />
        <CquSnapshotCard />
      </div>

      {/* Full-width entitlements */}
      <EntitlementsCard />
    </Layout>
  );
}
