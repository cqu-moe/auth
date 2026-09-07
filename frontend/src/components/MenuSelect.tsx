import { useEffect, useRef, useState, type ReactNode } from "react";

export interface MenuSelectOption<T extends string> {
  value: T;
  label: string;
  // 选项下方的小字说明(可选)。
  hint?: string;
  // 选项左侧的色点(可选,tailwind 背景类)。
  dotClass?: string;
}

// 通用自定义下拉:按钮 + 浮层菜单,替代原生 <select>。
// 原生 select 的浮层样式不可控、在表格里尤其粗糙;这里统一成应用自身的
// 圆角/边框/阴影语言。支持 outside-click / Escape 关闭、键盘上下选择。
export default function MenuSelect<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  "aria-label": ariaLabel,
  align = "left",
  buttonClassName = "",
}: {
  value: T;
  options: MenuSelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  "aria-label"?: string;
  align?: "left" | "right";
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  const renderContent = (opt: MenuSelectOption<T> | undefined): ReactNode => (
    <>
      {opt?.dotClass && (
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${opt.dotClass}`} />
      )}
      <span className="truncate">{opt?.label ?? "请选择"}</span>
    </>
  );

  return (
    <div ref={ref} className="relative inline-block text-left">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-lg border border-gray-950/[0.08] bg-white text-sm text-gray-700 shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 disabled:hover:bg-white transition-colors ${buttonClassName}`}
      >
        {renderContent(current)}
        <svg
          className={`w-3.5 h-3.5 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          className={`absolute z-30 mt-1 min-w-full w-max max-w-64 rounded-xl border border-gray-950/[0.08] bg-white p-1 shadow-lg ${align === "right" ? "right-0" : "left-0"}`}
        >
          {options.map((opt) => {
            const selected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                  selected
                    ? "bg-blue-50 text-blue-700"
                    : "text-gray-700 hover:bg-gray-50"
                }`}
              >
                {opt.dotClass ? (
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${opt.dotClass}`} />
                ) : (
                  <span className="w-1.5 h-1.5 shrink-0" />
                )}
                <span className="min-w-0">
                  <span className="block truncate">{opt.label}</span>
                  {opt.hint && (
                    <span className="block text-xs text-gray-400 truncate">{opt.hint}</span>
                  )}
                </span>
                {selected && (
                  <svg className="w-4 h-4 ml-auto shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
