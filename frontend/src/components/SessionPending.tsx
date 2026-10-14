import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

/** Short session checks should not flash a full-page status card. */
export default function SessionPending({ message = "正在确认登录状态…" }: { message?: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 200);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main className="session-pending" aria-busy="true" aria-label={message}>
      {visible && (
        <p className="session-pending-feedback" role="status" data-session-feedback>
          <Loader2 size={18} className="animate-spin" aria-hidden="true" />
          {message}
        </p>
      )}
    </main>
  );
}
