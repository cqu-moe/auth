import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-white rounded-2xl border border-gray-200 ${className}`}>{children}</div>
  );
}

export function CardHeader({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="px-6 pt-6 pb-2">
      <h3 className="text-base font-semibold text-gray-900">{title}</h3>
      {desc && <p className="mt-1 text-sm text-gray-500">{desc}</p>}
    </div>
  );
}
