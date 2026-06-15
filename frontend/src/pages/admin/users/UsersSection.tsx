import { useState, useEffect, useCallback, useRef } from "react";
import type { User, UsersResponse } from "../types";
import { ROLE_OPTIONS } from "../constants";
import { EntitlementPanel } from "./EntitlementPanel";

type StatusFilter = "all" | "normal" | "banned";

// --- Users Section ---
export function UsersSection() {
  const [users, setUsers] = useState<User[]>([]);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState("");
  // 当前打开「分级权益」面板的用户(null = 关闭)。
  const [entitlementUser, setEntitlementUser] = useState<User | null>(null);

  // 搜索框
  const [search, setSearch] = useState("");
  // 状态筛选（当前页客户端过滤）
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  // 用于存储当前实际生效的搜索词（防止竞态：分页按钮触发 fetchUsers 时读最新词）
  const searchRef = useRef("");

  const fetchUsers = useCallback(async (page = 1, term = searchRef.current) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (term.trim()) {
        params.set("search", term.trim());
      }
      const res = await fetch(`/api/admin/users?${params.toString()}`);
      if (res.ok) {
        const data = await res.json() as UsersResponse;
        setUsers(data.data);
        setPagination({ page, total: data.pagination.total, totalPages: data.pagination.totalPages });
      } else {
        setError("加载用户列表失败");
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, []);

  // 初次加载
  useEffect(() => {
    void fetchUsers(1, "");
  }, [fetchUsers]);

  // 搜索防抖：300ms 后从第 1 页重新拉取
  useEffect(() => {
    // 跳过初次挂载（search 初始值 "" 已由上方 useEffect 处理）
    searchRef.current = search;
    const timer = setTimeout(() => {
      void fetchUsers(1, search);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const updateUser = async (id: string, payload: Record<string, unknown>) => {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        await fetchUsers(pagination.page);
      } else {
        setError("操作失败，请稍后重试");
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setActionLoading(null);
    }
  };

  // 状态筛选（当前页客户端过滤）
  const visibleUsers = users.filter((u) => {
    if (statusFilter === "normal") return !u.banned;
    if (statusFilter === "banned") return u.banned;
    return true;
  });

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-gray-400 text-sm py-8">
        <div className="w-5 h-5 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
        加载中...
      </div>
    );
  }

  return (
    <div>
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
          <button onClick={() => setError("")} className="ml-2 underline">关闭</button>
        </div>
      )}

      {/* 搜索框 + 状态筛选 */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {/* 搜索框 */}
        <div className="relative flex-1 min-w-48">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索用户名或邮箱…"
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 pr-7 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
            aria-label="搜索用户"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs leading-none"
              aria-label="清除搜索"
            >
              ✕
            </button>
          )}
        </div>

        {/* 状态分段筛选 */}
        <div className="flex items-center gap-1 border border-gray-200 rounded-lg p-0.5 bg-gray-50 text-xs">
          {(
            [
              { value: "all", label: "全部" },
              { value: "normal", label: "正常" },
              { value: "banned", label: "已封禁" },
            ] as { value: StatusFilter; label: string }[]
          ).map((opt) => (
            <button
              key={opt.value}
              onClick={() => setStatusFilter(opt.value)}
              className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                statusFilter === opt.value
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {statusFilter !== "all" && (
          <span className="text-xs text-gray-400">仅筛选当前页</span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">用户</th>
              <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">角色</th>
              <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">状态</th>
              <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">注册时间</th>
              <th className="text-right py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {visibleUsers.map((user) => (
              <tr key={user.id} className="hover:bg-gray-50 transition-colors">
                <td className="py-3 px-4">
                  <div className="font-medium text-gray-900">{user.name}</div>
                  <div className="text-xs text-gray-400">{user.email}</div>
                </td>
                <td className="py-3 px-4">
                  <select
                    value={user.role}
                    onChange={(e) => updateUser(user.id, { role: e.target.value })}
                    disabled={actionLoading === user.id}
                    className="text-xs border border-gray-200 rounded px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                    aria-label={`${user.name} 的角色`}
                  >
                    {ROLE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </td>
                <td className="py-3 px-4">
                  <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                    user.banned
                      ? "bg-red-100 text-red-700"
                      : "bg-green-100 text-green-700"
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${user.banned ? "bg-red-500" : "bg-green-500"}`} />
                    {user.banned ? "已封禁" : "正常"}
                  </span>
                </td>
                <td className="py-3 px-4 text-gray-500 text-xs">
                  {new Date(user.createdAt).toLocaleDateString("zh-CN")}
                </td>
                <td className="py-3 px-4 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => setEntitlementUser(user)}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
                    >
                      权益
                    </button>
                    <button
                      onClick={() => updateUser(user.id, { action: user.banned ? "unban" : "ban" })}
                      disabled={actionLoading === user.id}
                      className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 ${
                        user.banned
                          ? "bg-green-100 text-green-700 hover:bg-green-200"
                          : "bg-red-100 text-red-700 hover:bg-red-200"
                      }`}
                    >
                      {actionLoading === user.id ? (
                        <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      ) : (
                        user.banned ? "解封" : "封禁"
                      )}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-200">
          <span className="text-xs text-gray-500">
            共 {pagination.total} 个用户
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => fetchUsers(pagination.page - 1)}
              disabled={pagination.page <= 1}
              className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50"
            >
              上一页
            </button>
            <span className="text-xs text-gray-500">
              {pagination.page} / {pagination.totalPages}
            </span>
            <button
              onClick={() => fetchUsers(pagination.page + 1)}
              disabled={pagination.page >= pagination.totalPages}
              className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50"
            >
              下一页
            </button>
          </div>
        </div>
      )}

      {entitlementUser && (
        <EntitlementPanel
          user={entitlementUser}
          onClose={() => setEntitlementUser(null)}
        />
      )}
    </div>
  );
}
