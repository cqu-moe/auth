import type { ReactNode } from "react";

// A field label row with optional hint text.
export function FieldLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-1.5">
      <label className="text-xs font-medium text-gray-700">{children}</label>
      {hint && <span className="ml-2 text-xs text-gray-400">{hint}</span>}
    </div>
  );
}
