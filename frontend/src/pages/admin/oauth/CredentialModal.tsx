import { Modal, FieldLabel, CopyButton } from "../../../components/ui";

// --- One-time credential reveal (used by create + rotate) ---
export function CredentialModal({
  title,
  clientId,
  clientSecret,
  onClose,
}: {
  title: string;
  clientId?: string;
  clientSecret: string;
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose} maxWidth="max-w-lg">
      <div className="p-6">
        <h3 className="text-base font-semibold text-gray-900 mb-1">{title}</h3>
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
          密钥仅显示一次，请立即妥善保存。关闭后将无法再次查看。
        </div>

        {clientId && (
          <div className="mb-3">
            <FieldLabel>Client ID</FieldLabel>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 break-all">
                {clientId}
              </code>
              <CopyButton value={clientId} />
            </div>
          </div>
        )}

        <div className="mb-5">
          <FieldLabel>Client Secret</FieldLabel>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 break-all">
              {clientSecret}
            </code>
            <CopyButton value={clientSecret} />
          </div>
        </div>

        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
          >
            我已保存
          </button>
        </div>
      </div>
    </Modal>
  );
}
