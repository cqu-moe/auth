import { Button } from "@cqu-moe/ui";
import { CircleAlert, Loader2 } from "lucide-react";
import type { BindingConnectionState } from "../lib/api/binding-events";

type State = BindingConnectionState | "idle";

const labels: Record<State, string> = {
  idle: "准备连接…",
  connecting: "正在连接…",
  open: "已连接",
  closed: "正在重新连接…",
  error: "正在重新连接…",
  failed: "连接失败",
};

export default function BindingConnectionStatus({ state, onRetry }: { state: State; onRetry?: () => void }) {
  return (
    <div role="status" className="binding-connection-status flex h-11 items-center gap-2 rounded-lg px-3 text-xs font-medium" data-state={state}>
      <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
        {state === "open" ? <span className="size-2 rounded-full bg-current" /> : state === "failed" ? <CircleAlert size={16} /> : <Loader2 size={16} className="animate-spin" />}
      </span>
      <span>{labels[state]}</span>
      {state === "failed" && onRetry && <Button type="button" variant="ghost" size="sm" className="ml-auto shrink-0" onClick={onRetry}>重试</Button>}
    </div>
  );
}
