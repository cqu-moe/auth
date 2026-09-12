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
  const requestGenerationRef = useRef(0);
  const lifecycleGenerationRef = useRef(0);
  const actionLockRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<
    | { kind: "toggle" }
    | { kind: "revoke"; deviceId: string }
    | null
  >(null);
  const [error, setError] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    const generation = ++requestGenerationRef.current;
    const isCurrent = () =>
      requestGenerationRef.current === generation && !signal?.aborted;
    setLoading(true);
    try {
      const nextPreference = await getQuickloginPreference(signal);
      if (!isCurrent()) return;
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
        const nextData = await listQuickloginDevices(signal);
        if (!isCurrent()) return;
        dataRef.current = nextData;
        setData(nextData);
        setError("");
      } catch {
        if (!isCurrent()) return;
        setError(dataRef.current
          ? "无法刷新设备列表，仍显示上次结果。"
          : "无法读取快捷登录设备，请检查网络后重试。");
      }
    } catch {
      if (!isCurrent()) return;
      setError("无法检查快捷登录状态，请检查网络后重试。");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  const invalidateLifecycle = useCallback(() => {
    ++requestGenerationRef.current;
    ++lifecycleGenerationRef.current;
  }, []);

  useEffect(() => {
    ++lifecycleGenerationRef.current;
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
      invalidateLifecycle();
    };
  }, [invalidateLifecycle, load]);

  const enabled = data?.masterEnabled ??
    (preference && "enabled" in preference ? preference.enabled : false);

  const toggleMaster = async () => {
    if (!preference?.eligible || actionLockRef.current) return;
    actionLockRef.current = true;
    const lifecycle = lifecycleGenerationRef.current;
    setAction({ kind: "toggle" });
    setError("");
    try {
      await setQuickloginMasterEnabled(!enabled);
      if (lifecycleGenerationRef.current !== lifecycle) return;
      await load();
    } catch {
      if (lifecycleGenerationRef.current === lifecycle) {
        setError("总开关保存失败，设备原有设置没有改变。");
      }
    } finally {
      actionLockRef.current = false;
      if (lifecycleGenerationRef.current === lifecycle) setAction(null);
    }
  };

  const remove = async (deviceId: string) => {
    if (actionLockRef.current) return;
    actionLockRef.current = true;
    const lifecycle = lifecycleGenerationRef.current;
    setAction({ kind: "revoke", deviceId });
    setError("");
    try {
      await revokeQuickloginDevice(deviceId);
      if (lifecycleGenerationRef.current !== lifecycle) return;
      await load();
    } catch {
      if (lifecycleGenerationRef.current === lifecycle) {
        setError("设备退出失败，请稍后重试。");
      }
    } finally {
      actionLockRef.current = false;
      if (lifecycleGenerationRef.current === lifecycle) setAction(null);
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
          disabled={action !== null}
          onClick={() => void toggleMaster()}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed"
        >
          <span className={`relative inline-flex h-6 w-11 items-center rounded-full ${
            enabled ? "bg-blue-600" : "bg-gray-300"
          } ${action?.kind === "toggle" ? "opacity-60" : ""}`}>
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
          busy={action !== null}
          revokingDeviceId={action?.kind === "revoke" ? action.deviceId : null}
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
