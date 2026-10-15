import { useEffect, useState } from "react";
import RouteSkeleton from "./RouteSkeleton";

/** Short session checks should not flash a full-page status card. */
export default function SessionPending({ message = "正在确认登录状态…" }: { message?: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 200);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div aria-busy="true" aria-label={message}>
      {visible && (
        <p className="sr-only" role="status" data-session-feedback>
          {message}
        </p>
      )}
      <RouteSkeleton />
    </div>
  );
}
