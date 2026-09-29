import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@cqu-moe/ui";

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
        <h2 className="text-xl font-semibold text-foreground">{title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      </div>
      {returnTo ? (
        <Button asChild className="w-full">
          <a href={returnTo} onClick={() => setPaused(true)}>
            {schedule ? "返回课表" : "返回服务"}
          </a>
        </Button>
      ) : (
        <Button asChild variant="link">
          <a href="https://schedule.cqu.moe/">前往课表</a>
        </Button>
      )}
      {running && (
        <p className="text-xs text-muted-foreground">
          {seconds} 秒后自动返回 ·{" "}
          <Button type="button" variant="link" size="sm" onClick={() => setPaused(true)}>
            留在此页
          </Button>
        </p>
      )}
      {!returnTo && (
        <Button asChild variant="link">
          <Link to="/settings">返回账户设置</Link>
        </Button>
      )}
    </div>
  );
}
