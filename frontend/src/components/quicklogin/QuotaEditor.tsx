import { useState, type FormEvent } from "react";
import { ApiError } from "../../lib/api/http";
import {
  applyQuickloginQuota,
  previewFromApiError,
  previewQuickloginQuota,
  type QuotaPreview,
} from "../../lib/api/quicklogin";

export const PREVIEW_CHANGED_MESSAGE = "设备状态已变化，请确认最新名单";

function previewDeviceList(
  label: string,
  devices: QuotaPreview["keptDevices"]
) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-700">{label}</p>
      {devices.length === 0 ? (
        <p className="mt-1 text-xs text-gray-400">无</p>
      ) : (
        <ul className="mt-1 space-y-1 text-xs text-gray-600">
          {devices.map((device) => (
            <li key={device.deviceId} className="break-words">
              {device.deviceName} · Chrome {device.browserVersion}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function QuotaEditor({ userId, onSaved }: {
  userId: string;
  onSaved: () => void;
}) {
  const [value, setValue] = useState("");
  const [preview, setPreview] = useState<QuotaPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const requestPreview = async (event: FormEvent) => {
    event.preventDefault();
    const limit = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(limit)) {
      setError("设备额度必须是非负整数。");
      return;
    }
    setBusy("preview");
    setError("");
    setNotice("");
    try {
      setPreview(await previewQuickloginQuota(userId, limit));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法生成额度预览。");
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    if (!preview || busy) return;
    setBusy("apply");
    setError("");
    setNotice("");
    try {
      await applyQuickloginQuota(userId, preview);
      setNotice("设备额度已保存");
      setPreview(null);
      onSaved();
    } catch (caught) {
      const latest = previewFromApiError(caught);
      if (caught instanceof ApiError && caught.code === "PREVIEW_CHANGED" && latest) {
        setPreview(latest);
        setError(PREVIEW_CHANGED_MESSAGE);
      } else {
        setError(caught instanceof Error && caught.message
          ? caught.message
          : "额度保存失败，请稍后重试。");
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className="space-y-3 border-t border-gray-100 pt-4"
      aria-labelledby="quicklogin-quota-heading"
      aria-busy={busy !== null}
    >
      <div>
        <h4 id="quicklogin-quota-heading" className="text-sm font-medium text-gray-900">
          快捷登录设备额度
        </h4>
        <p className="mt-1 text-xs leading-relaxed text-gray-500">
          降低额度会停用最近联系较早的设备，不会把设备退出。
        </p>
      </div>
      <form onSubmit={requestPreview} className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1">
          <label htmlFor="quicklogin-device-limit" className="text-xs font-medium text-gray-700">
            设备数
          </label>
          <input
            id="quicklogin-device-limit"
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={error === "设备额度必须是非负整数。"}
            className="min-h-11 w-28 rounded-lg border border-gray-200 px-3 text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button
          type="submit"
          disabled={busy !== null}
          className="min-h-11 rounded-lg border border-gray-200 bg-white px-4 text-sm font-medium hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:text-gray-400"
        >
          {busy === "preview" ? "正在检查…" : "预览调整"}
        </button>
      </form>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
      {preview && (
        <div className="rounded-lg border border-gray-950/[0.08] bg-gray-50 p-3 text-sm">
          <p className="font-medium text-gray-900">
            {preview.disabled.length > 0
              ? `将停用 ${preview.disabled.length} 台设备`
              : "不会停用设备"}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">
            保留 {preview.kept.length} 台，额度从 {preview.oldLimit} 调整为 {preview.newLimit}。
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {previewDeviceList("保留设备", preview.keptDevices)}
            {previewDeviceList("停用设备", preview.disabledDevices)}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void confirm()}
              className="min-h-11 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:bg-blue-300"
            >
              {busy === "apply" ? "正在保存…" : "确认保存额度"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setPreview(null);
                setError("");
              }}
              className="min-h-11 rounded-lg border border-gray-200 bg-white px-4 text-sm font-medium hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:text-gray-400"
            >
              取消调整
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
