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
      // Clipboard API unavailable (insecure context / old browser) — fall back
      // to the legacy execCommand approach.
      try {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        // execCommand also unavailable — give up silently.
      }
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
