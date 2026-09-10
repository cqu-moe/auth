import { useCallback, useEffect, useState } from "react";
import SettingsCard from "../SettingsCard";
import DeviceList from "./DeviceList";
import {
  getQuicklogin,
  revokeDevice,
  setMasterEnabled,
  type DeviceListData,
} from "./api";

export default function QuickloginSettings({ currentDeviceHint }: {
  currentDeviceHint?: string;
}) {
  const [data, setData] = useState<DeviceListData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getQuicklogin());
      setError("");
    } catch {
      setError("无法读取快捷登录设备，请检查网络后重试。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggleMaster = async () => {
    if (!data || saving) return;
    setSaving(true);
    setError("");
    try {
      await setMasterEnabled(!data.masterEnabled);
      await load();
    } catch {
      setError("总开关保存失败，设备原有设置没有改变。");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (deviceId: string) => {
    setSaving(true);
    setError("");
    try {
      await revokeDevice(deviceId);
      await load();
    } catch {
      setError("设备退出失败，请稍后重试。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      title="浏览器快捷登录"
      description={data ? `已启用 ${data.used} / ${data.deviceLimit} 台` : "每个安装实例使用独立学校会话"}
      action={data && (
        <button
          type="button"
          role="switch"
          aria-checked={data.masterEnabled}
          aria-label="浏览器快捷登录总开关"
          disabled={saving}
          onClick={() => void toggleMaster()}
          className={`relative inline-flex h-6 w-11 items-center rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:bg-gray-200 ${
            data.masterEnabled ? "bg-blue-600" : "bg-gray-300"
          }`}
        >
          <span className={`h-4 w-4 rounded-full bg-white shadow ${
            data.masterEnabled ? "translate-x-6" : "translate-x-1"
          }`} />
        </button>
      )}
    >
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {loading && !data ? (
        <p className="py-4 text-sm text-gray-500">正在加载设备…</p>
      ) : data ? (
        <DeviceList data={data} currentDeviceHint={currentDeviceHint} onRevoke={remove} />
      ) : (
        <button type="button" onClick={() => void load()} className="min-h-11 rounded-lg border border-gray-200 px-4 text-sm font-medium hover:bg-gray-50">
          重新加载
        </button>
      )}
    </SettingsCard>
  );
}
