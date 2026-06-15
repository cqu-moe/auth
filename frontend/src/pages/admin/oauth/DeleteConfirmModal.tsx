import { Modal } from "../../../components/ui";

// --- Delete confirmation ---
export function DeleteConfirmModal({
  clientName,
  loading,
  onConfirm,
  onCancel,
}: {
  clientName: string;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal onClose={onCancel} maxWidth="max-w-md">
      <div className="p-6">
        <h3 className="text-base font-semibold text-gray-900 mb-2">删除 OAuth 客户端</h3>
        <p className="text-sm text-gray-600 mb-5">
          确定要删除客户端 <span className="font-medium text-gray-900">{clientName}</span> 吗？此操作不可撤销，相关的 CQU 服务权限也会一并清除。
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:bg-red-400 flex items-center gap-1.5 transition-colors"
          >
            {loading && <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            删除
          </button>
        </div>
      </div>
    </Modal>
  );
}
