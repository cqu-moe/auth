import type { ReactNode } from "react";

type Variant = "green" | "yellow" | "gray" | "red" | "blue";
const MAP: Record<Variant, { pill: string; dot: string }> = {
  green:  { pill: "bg-green-100 text-green-700",  dot: "bg-green-500"  },
  yellow: { pill: "bg-yellow-100 text-yellow-700", dot: "bg-yellow-500" },
  gray:   { pill: "bg-gray-100 text-gray-500",    dot: "bg-gray-400"   },
  red:    { pill: "bg-red-100 text-red-700",      dot: "bg-red-500"    },
  blue:   { pill: "bg-blue-100 text-blue-700",    dot: "bg-blue-500"   },
};
export function Badge({ variant, children, dot = true }: { variant: Variant; children: ReactNode; dot?: boolean }) {
  const c = MAP[variant];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-0.5 rounded-full ${c.pill}`}>
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />}
      {children}
    </span>
  );
}
