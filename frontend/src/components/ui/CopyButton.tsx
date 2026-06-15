import { useState } from "react";

// Copy-to-clipboard button that flashes "已复制".
export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (insecure context); silently ignore.
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="shrink-0 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
    >
      {copied ? "已复制" : "复制"}
    </button>
  );
}
