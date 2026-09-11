import { useEffect, useRef, useState } from "react";

export default function CopyButton({
  text,
  value,
  compact = false,
}: {
  text?: string;
  value?: string;
  compact?: boolean;
}) {
  const content = text ?? value ?? "";
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const markCopied = () => {
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), compact ? 1500 : 2000);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      markCopied();
    } catch {
      if (compact) return;
      const textarea = document.createElement("textarea");
      textarea.value = content;
      document.body.appendChild(textarea);
      textarea.select();
      const succeeded = document.execCommand("copy");
      textarea.remove();
      if (succeeded) markCopied();
    }
  };

  if (compact) {
    return (
      <button type="button" onClick={() => void copy()} className="shrink-0 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors">
        {copied ? "已复制" : "复制"}
      </button>
    );
  }
  return (
    <button type="button" onClick={() => void copy()} aria-label="复制到剪贴板" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors flex-shrink-0">
      <svg className={`w-3.5 h-3.5 ${copied ? "text-green-600" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={copied ? "M5 13l4 4L19 7" : "M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"} />
      </svg>
      {copied ? "已复制" : "复制"}
    </button>
  );
}
