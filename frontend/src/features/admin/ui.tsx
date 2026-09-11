import type { ReactNode } from "react";
import SharedCopyButton from "../../components/CopyButton";

export function FieldLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-1.5">
      <label className="text-xs font-medium text-gray-700">{children}</label>
      {hint && <span className="ml-2 text-xs text-gray-400">{hint}</span>}
    </div>
  );
}

export const inputClass =
  "w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder:text-gray-300";

// Editable list of single-line strings (add / remove rows). Always renders at
// least one row so the user has something to type into.
export function StringListInput({
  values,
  onChange,
  placeholder,
  addLabel,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  addLabel: string;
}) {
  const rows = values.length === 0 ? [""] : values;

  const setAt = (i: number, v: string) => {
    const next = [...rows];
    next[i] = v;
    onChange(next);
  };
  const removeAt = (i: number) => {
    const next = rows.filter((_, idx) => idx !== i);
    onChange(next);
  };
  const add = () => onChange([...rows, ""]);

  return (
    <div className="space-y-2">
      {rows.map((val, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="text"
            value={val}
            onChange={(e) => setAt(i, e.target.value)}
            placeholder={placeholder}
            className={inputClass}
          />
          <button
            type="button"
            onClick={() => removeAt(i)}
            disabled={rows.length === 1}
            className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg border border-gray-200 text-gray-400 hover:text-red-600 hover:border-red-200 disabled:opacity-30 disabled:hover:text-gray-400 disabled:hover:border-gray-200 transition-colors"
            aria-label="删除此项"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="text-xs font-medium text-blue-600 hover:text-blue-700"
      >
        + {addLabel}
      </button>
    </div>
  );
}

// Small accessible on/off toggle.
export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer py-1">
      <span>
        <span className="text-sm text-gray-700">{label}</span>
        {hint && <span className="block text-xs text-gray-400">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${
          checked ? "bg-blue-600" : "bg-gray-200"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </button>
    </label>
  );
}

// Compact wrapper preserves the admin surface while sharing clipboard lifecycle.
export function CopyButton({ value }: { value: string }) {
  return <SharedCopyButton value={value} compact />;
}

// Centered modal shell with backdrop.
export function Modal({
  onClose,
  children,
  maxWidth = "max-w-2xl",
}: {
  onClose: () => void;
  children: ReactNode;
  maxWidth?: string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className={`relative w-full ${maxWidth} max-h-[90vh] overflow-y-auto bg-white rounded-2xl border border-gray-200 shadow-xl`}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </div>
    </div>
  );
}

// --- Entitlement panel (per-user 分级权益 / 能力授权) ---
// 表单态/矩阵实现见 components/EntitlementFields。保存为整组替换(full replace):
// 仅把勾选的 flag 与非空 quota 发给 PUT,未勾/空缺省即「false / 无限」。
// 预设从 GET /admin/entitlement-presets 读(管理台「权益预设」页可编辑)。
