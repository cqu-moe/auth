import { CAPABILITIES, isFlag, type CapDef, type Subsystem } from "../../../src/capabilities";
import { authClient } from "./auth-client";

export type Caps = Record<string, Record<string, boolean | number | null>>;
export interface CapView {
  key: string;
  label: string;
  type: CapDef["type"];
  value: boolean | number | null;
  display: string;
}

export function capsToView(caps: Caps | undefined, subsystem: Subsystem): CapView[] {
  const defs = CAPABILITIES[subsystem] as Record<string, CapDef>;
  const sub = caps?.[subsystem] ?? {};
  return Object.entries(defs).map(([key, def]) => {
    const value = sub[key] ?? (isFlag(def) ? false : null);
    const display = isFlag(def)
      ? value ? "已开通" : "未开通"
      : value == null ? "无限" : `${value}${def.unit ? " " + def.unit : ""}`;
    return { key, label: def.label, type: def.type, value, display };
  });
}

export function useCaps(): Caps | undefined {
  const { data } = authClient.useSession();
  return (data as { caps?: Caps } | null | undefined)?.caps;
}
