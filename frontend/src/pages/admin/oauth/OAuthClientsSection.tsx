import { useState, useEffect, useCallback } from "react";
import type { ClientConfig } from "../types";
import { readErrorMessage } from "../constants";
import { OAuthClientEditor } from "./OAuthClientEditor";
import { CredentialModal } from "./CredentialModal";
import { DeleteConfirmModal } from "./DeleteConfirmModal";

// --- OAuth Clients Section ---
export function OAuthClientsSection() {
  const [clients, setClients] = useState<ClientConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // editor: undefined = closed, null = create, ClientConfig = edit
  const [editor, setEditor] = useState<ClientConfig | null | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<ClientConfig | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<{ clientId: string; clientSecret: string } | null>(null);

  const fetchClients = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/oauth-clients");
      if (res.ok) {
        const data = (await res.json()) as { data: ClientConfig[] };
        setClients(data.data ?? []);
      } else {
        setError(await readErrorMessage(res, "加载 OAuth 客户端失败"));
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchClients();
  }, [fetchClients]);

  const handleSaved = () => {
    setEditor(undefined);
    void fetchClients();
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/oauth-clients/${deleteTarget.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setDeleteTarget(null);
        await fetchClients();
      } else {
        setError(await readErrorMessage(res, "删除失败，请稍后重试"));
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setDeleting(false);
    }
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">共 {clients.length} 个客户端</p>
        <button
          onClick={() => setEditor(null)}
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
        >
          + 新建客户端
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
          <button onClick={() => setError("")} className="ml-2 underline">关闭</button>
        </div>
      )}

      {clients.length === 0 && (
        <p className="text-sm text-gray-400 py-4">暂无 OAuth 客户端</p>
      )}

      {clients.map((client) => (
        <div key={client.id} className="border border-gray-200 rounded-xl p-5 flex items-start justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-semibold text-gray-900 truncate">
                {client.client_name || client.client_id}
              </h4>
              {client.disabled && (
                <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">
                  已停用
                </span>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-0.5 font-mono break-all">{client.client_id}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-4">
            <button
              onClick={() => setEditor(client)}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
            >
              编辑
            </button>
            <button
              onClick={() => setDeleteTarget(client)}
              className="px-3 py-1.5 text-xs font-medium rounded-lg text-red-600 hover:bg-red-50 transition-colors"
            >
              删除
            </button>
          </div>
        </div>
      ))}

      {editor !== undefined && (
        <OAuthClientEditor
          client={editor}
          onClose={() => setEditor(undefined)}
          onSaved={handleSaved}
          onCreated={(s) => setCreatedSecret(s)}
        />
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          clientName={deleteTarget.client_name || deleteTarget.client_id}
          loading={deleting}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {createdSecret && (
        <CredentialModal
          title="客户端创建成功"
          clientId={createdSecret.clientId}
          clientSecret={createdSecret.clientSecret}
          onClose={() => setCreatedSecret(null)}
        />
      )}
    </div>
  );
}
