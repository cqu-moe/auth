import { useCallback, useEffect, useRef, useState } from "react";
import {
  getQuickloginPreference,
  isDeviceQuickloginPreference,
  getQuickloginOverview,
  revokeQuickloginDevice,
  reconnectQuickloginDevice,
  setQuickloginMasterEnabled,
  type QuickloginPreference,
} from "../../lib/api/quicklogin";
import type { Overview } from "../../lib/api/quicklogin-protocol.generated";
import { ApiError } from "../../lib/api/http";
import SettingsCard from "../SettingsCard";
import DeviceList from "./DeviceList";

export default function QuickloginSettings({ currentDeviceHint, reconnectDeviceHint }: {
  currentDeviceHint?: string;
  reconnectDeviceHint?: string;
}) {
  const [preference, setPreference] = useState<QuickloginPreference | null>(null);
  const [data, setData] = useState<Overview | null>(null);
  const dataRef = useRef<Overview | null>(null);
  const requestAbortRef = useRef<AbortController | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const requestGenerationRef = useRef(0);
  const lifecycleGenerationRef = useRef(0);
  const actionLockRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<
    | { kind: "toggle" }
    | { kind: "revoke" | "reconnect"; deviceId: string }
    | null
  >(null);
  const [error, setError] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    signal?.addEventListener("abort", () => controller.abort(), { once: true });
    if (signal?.aborted) controller.abort();
    const generation = ++requestGenerationRef.current;
    const isCurrent = () =>
      requestGenerationRef.current === generation && !controller.signal.aborted;
    setLoading(true);
    try {
      const nextPreference = await getQuickloginPreference(controller.signal);
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
        const nextData = await getQuickloginOverview(controller.signal);
        if (!isCurrent()) return;
        dataRef.current = nextData;
        setData(nextData);
        setUnreachable(false);
        setError("");
      } catch (error) {
        if (!isCurrent()) return;
        setUnreachable(true);
        const invalidContract = error instanceof Error && "code" in error && error.code === "CONTRACT_INVALID";
        setError(invalidContract ? "状态格式暂时无法识别，请稍后重新检查。" : dataRef.current
          ? "无法刷新设备列表，仍显示上次结果。"
          : "无法读取快捷登录设备，请检查网络后重试。");
      }
    } catch {
      if (!isCurrent()) return;
      setUnreachable(true);
      setError("无法检查快捷登录状态，请检查网络后重试。");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  const invalidateLifecycle = useCallback(() => {
    requestAbortRef.current?.abort();
    ++requestGenerationRef.current;
    ++lifecycleGenerationRef.current;
  }, []);

  useEffect(() => {
    ++lifecycleGenerationRef.current;
    const controller = new AbortController();
    if (document.visibilityState === "visible") void load(controller.signal);
    return () => {
      controller.abort();
      invalidateLifecycle();
    };
  }, [invalidateLifecycle, load]);

  const pollingMs = data?.devices.some((device) =>
    ["queued", "logging_in", "refreshing"].includes(device.cloud.state)
  ) ? 5_000 : 30_000;

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const refresh = () => {
      if (document.visibilityState === "visible" && !actionLockRef.current) void load();
    };
    const schedule = () => {
      clearInterval(timer);
      if (document.visibilityState === "visible") timer = setInterval(refresh, pollingMs);
    };
    const visibilityChanged = () => {
      requestAbortRef.current?.abort();
      ++requestGenerationRef.current;
      schedule();
      refresh();
    };
    schedule();
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("focus", refresh);
    };
  }, [load, pollingMs]);

  const enabled = data?.masterEnabled ??
    (preference && "masterEnabled" in preference ? preference.masterEnabled
      : preference && "enabled" in preference ? preference.enabled : false);

  const toggleMaster = async () => {
    if (!preference?.eligible || actionLockRef.current) return;
    actionLockRef.current = true;
    requestAbortRef.current?.abort();
    ++requestGenerationRef.current;
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
    requestAbortRef.current?.abort();
    ++requestGenerationRef.current;
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

  const reconnect = async (deviceId: string) => {
    if (actionLockRef.current) return;
    actionLockRef.current = true;
    requestAbortRef.current?.abort();
    ++requestGenerationRef.current;
    const lifecycle = lifecycleGenerationRef.current;
    setAction({ kind: "reconnect", deviceId });
    setError("");
    try {
      await reconnectQuickloginDevice(deviceId);
      if (lifecycleGenerationRef.current === lifecycle) await load();
    } catch (error) {
      if (lifecycleGenerationRef.current === lifecycle) {
        const retryAt = error instanceof ApiError ? error.body?.retryAt : null;
        setError((error instanceof Error ? error.message : "重新连接失败，请重试。") +
          (typeof retryAt === "number" ? ` 可在 ${new Date(retryAt).toLocaleString("zh-CN")} 后重试。` : ""));
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
          unreachable={unreachable}
          onReconnect={reconnect}
          reconnectingDeviceId={action?.kind === "reconnect" ? action.deviceId : null}
          onRefresh={load}
          currentDeviceHint={currentDeviceHint}
          reconnectDeviceHint={reconnectDeviceHint}
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
