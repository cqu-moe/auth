import { useCallback, useEffect, useRef, useState } from "react";
import {
  getQuickloginPreference,
  isDeviceQuickloginPreference,
  listQuickloginDevices,
  revokeQuickloginDevice,
  setQuickloginMasterEnabled,
  type DeviceListData,
  type QuickloginPreference,
} from "../../lib/api/quicklogin";
import SettingsCard from "../SettingsCard";
import DeviceList from "./DeviceList";

export default function QuickloginSettings({ currentDeviceHint }: {
  currentDeviceHint?: string;
}) {
  const [preference, setPreference] = useState<QuickloginPreference | null>(null);
  const [data, setData] = useState<DeviceListData | null>(null);
  const dataRef = useRef<DeviceListData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const nextPreference = await getQuickloginPreference();
      setPreference(nextPreference);
      if (!nextPreference.eligible) {
        dataRef.current = null;
        setData(null);
        setError("");
        return;
      }
      if (!isDeviceQuickloginPreference(nextPreference)) {
        dataRef.current = null;
        setData(null);
        setError("");
        return;
      }
      try {
        const nextData = await listQuickloginDevices();
        dataRef.current = nextData;
        setData(nextData);
        setError("");
      } catch {
        setError(dataRef.current
          ? "无法刷新设备列表，仍显示上次结果。"
          : "无法读取快捷登录设备，请检查网络后重试。");
      }
    } catch {
      setError("无法检查快捷登录状态，请检查网络后重试。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const enabled = data?.masterEnabled ??
    (preference && "enabled" in preference ? preference.enabled : false);

  const toggleMaster = async () => {
    if (!preference?.eligible || saving) return;
    setSaving(true);
    setError("");
    try {
      await setQuickloginMasterEnabled(!enabled);
      await load();
    } catch {
      setError("总开关保存失败，设备原有设置没有改变。");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (deviceId: string) => {
    if (revokingDeviceId) return;
    setRevokingDeviceId(deviceId);
    setError("");
    try {
      await revokeQuickloginDevice(deviceId);
      await load();
    } catch {
      setError("设备退出失败，请稍后重试。");
    } finally {
      setRevokingDeviceId(null);
    }
  };

  if (preference?.eligible === false) return null;

  const description = data
    ? `已启用 ${data.used} / ${data.deviceLimit} 台`
    : "每个安装实例使用独立学校会话";

  return (
    <SettingsCard
      title="浏览器快捷登录"
      description={description}
      action={preference?.eligible && (
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="浏览器快捷登录总开关"
          disabled={saving}
          onClick={() => void toggleMaster()}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed"
        >
          <span className={`relative inline-flex h-6 w-11 items-center rounded-full ${
            enabled ? "bg-blue-600" : "bg-gray-300"
          } ${saving ? "opacity-60" : ""}`}>
            <span className={`h-4 w-4 rounded-full bg-white shadow ${
              enabled ? "translate-x-6" : "translate-x-1"
            }`} />
          </span>
        </button>
      )}
    >
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {error}
        </p>
      )}
      {loading && !preference ? (
        <p role="status" className="py-4 text-sm text-gray-500">正在检查快捷登录资格…</p>
      ) : data ? (
        <DeviceList
          data={data}
          currentDeviceHint={currentDeviceHint}
          revokingDeviceId={revokingDeviceId}
          onRevoke={remove}
        />
      ) : preference?.eligible && "enabled" in preference ? (
        <p className="text-sm leading-relaxed text-gray-500">
          开启后，浏览器插件可代你向学校系统取一次性登录票。可随时关闭。
        </p>
      ) : (
        <button
          type="button"
          onClick={() => void load()}
          className="min-h-11 rounded-lg border border-gray-200 px-4 text-sm font-medium hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          重新加载
        </button>
      )}
    </SettingsCard>
  );
}
