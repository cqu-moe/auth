import { inputClass } from "./form";

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
