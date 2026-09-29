import { useState, type FormEvent } from "react";
import { ApiError } from "../../lib/api/http";
import {
  applyQuickloginQuota,
  previewFromApiError,
  previewQuickloginQuota,
  type QuotaPreview,
} from "../../lib/api/quicklogin";
import { Button, Input, Label } from "@cqu-moe/ui";

export const PREVIEW_CHANGED_MESSAGE = "设备状态已变化，请确认最新名单";

function previewDeviceList(
  label: string,
  devices: QuotaPreview["keptDevices"]
) {
  return (
    <div>
      <p className="text-xs font-medium text-foreground">{label}</p>
      {devices.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">无</p>
      ) : (
        <ul className="mt-1 list-inside list-disc space-y-1 text-xs text-muted-foreground">
          {devices.map((device) => (
            <li key={device.deviceId} className="break-words marker:text-muted-foreground">
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
  onSaved: (deviceLimit: number) => void;
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
      const result = await applyQuickloginQuota(userId, preview);
      setNotice("设备额度已保存");
      setPreview(null);
      onSaved(result.deviceLimit);
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
      className="space-y-3 border-t border-border pt-4"
      aria-labelledby="quicklogin-quota-heading"
      aria-busy={busy !== null}
    >
      <div>
        <h4 id="quicklogin-quota-heading" className="text-sm font-medium text-foreground">
          快捷登录设备额度
        </h4>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          降低额度会停用最近联系较早的设备，不会把设备退出。
        </p>
      </div>
      <form onSubmit={requestPreview} className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="quicklogin-device-limit" className="text-xs">
            设备数
          </Label>
          <Input
            id="quicklogin-device-limit"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={error === "设备额度必须是非负整数。" || undefined}
            className="w-28"
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          disabled={busy !== null}
        >
          {busy === "preview" ? "正在检查…" : "预览调整"}
        </Button>
      </form>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm text-success">{notice}</p>}
      {preview && (
        <div className="rounded-lg border border-border bg-muted p-3 text-sm">
          <p className="font-medium text-foreground">
            {preview.disabled.length > 0
              ? `将停用 ${preview.disabled.length} 台设备`
              : "不会停用设备"}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            保留 {preview.kept.length} 台，额度从 {preview.oldLimit} 调整为 {preview.newLimit}。
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {previewDeviceList("保留设备", preview.keptDevices)}
            {previewDeviceList("停用设备", preview.disabledDevices)}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={busy !== null}
              onClick={() => void confirm()}
            >
              {busy === "apply" ? "正在保存…" : "确认保存额度"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null}
              onClick={() => {
                setPreview(null);
                setError("");
              }}
            >
              取消调整
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
