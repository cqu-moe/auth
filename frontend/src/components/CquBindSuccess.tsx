import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

export interface CquBindSuccessProps {
  returnTo: string | null;
  autoReturn: boolean;
  onReturn?: (url: string) => void;
  title?: string;
  description?: string;
}

const navigateToService = (url: string) => window.location.replace(url);

export default function CquBindSuccess({
  returnTo,
  autoReturn,
  onReturn = navigateToService,
  title = "绑定成功",
  description = "可以返回使用服务了。",
}: CquBindSuccessProps) {
  const [paused, setPaused] = useState(false);
  const [seconds, setSeconds] = useState(3);
  const returnedRef = useRef(false);
  const running = Boolean(returnTo && autoReturn && !paused && !returnedRef.current);

  useEffect(() => {
    if (!running || !returnTo) return;
    const timer = window.setTimeout(() => {
      if (seconds <= 1) {
        if (returnedRef.current) return;
        returnedRef.current = true;
        setPaused(true);
        onReturn(returnTo);
      } else {
        setSeconds((value) => value - 1);
      }
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [running, returnTo, seconds, onReturn]);

  const schedule = returnTo && new URL(returnTo).hostname === "schedule.cqu.moe";

  return (
    <div className="space-y-6 text-center">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
        <p className="mt-2 text-sm text-gray-500">{description}</p>
      </div>
      {returnTo ? (
        <a
          href={returnTo}
          onClick={() => setPaused(true)}
          className="block w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          {schedule ? "返回课表" : "返回服务"}
        </a>
      ) : (
        <a href="https://schedule.cqu.moe/" className="block text-sm text-blue-600">
          前往课表
        </a>
      )}
      {running && (
        <p className="text-xs text-gray-500">
          {seconds} 秒后自动返回 ·{" "}
          <button type="button" onClick={() => setPaused(true)} className="underline">
            留在此页
          </button>
        </p>
      )}
      {!returnTo && (
        <Link to="/settings" className="block text-sm text-gray-500">
          返回账户设置
        </Link>
      )}
    </div>
  );
}
