import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@cqu-moe/ui";

export default function CopyButton({
  text,
  value,
  compact = false,
  iconOnly = false,
}: {
  text?: string;
  value?: string;
  compact?: boolean;
  iconOnly?: boolean;
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

  const label = copied ? "已复制" : "复制";
  return (
    <Button
      type="button"
      variant={iconOnly ? "ghost" : "outline"}
      size={iconOnly ? "icon" : compact ? "xs" : "sm"}
      className={iconOnly ? "size-11 shrink-0" : undefined}
      aria-label={copied ? "已复制" : "复制到剪贴板"}
      title={iconOnly ? label : undefined}
      onClick={() => void copy()}
    >
      {copied ? (
        <Check aria-hidden="true" className={copied ? "text-success" : undefined} />
      ) : (
        <Copy aria-hidden="true" />
      )}
      <span className={iconOnly ? "sr-only" : undefined} aria-live="polite">{label}</span>
    </Button>
  );
}
