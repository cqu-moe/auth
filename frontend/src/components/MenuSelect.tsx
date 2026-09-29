import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@cqu-moe/ui";

export interface MenuSelectOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

// 表单单选控件，基于共享 Select。空字符串不是合法的 SelectItem value，
// 内部映射为哨兵值，对外仍透传 ""。
const NONE_VALUE = "__none__";

export default function MenuSelect<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  "aria-label": ariaLabel,
  size = "default",
  className,
}: {
  value: T;
  options: MenuSelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  "aria-label"?: string;
  size?: "sm" | "default";
  className?: string;
}) {
  return (
    <Select
      value={value === "" ? NONE_VALUE : value}
      onValueChange={(next) => onChange((next === NONE_VALUE ? "" : next) as T)}
      disabled={disabled}
    >
      <SelectTrigger aria-label={ariaLabel} size={size} className={className}>
        {/* 触发器只显示当前项名称；hint 只在下拉菜单里展示，
            避免表格行内的选择框被说明文字撑宽。 */}
        <SelectValue className="truncate">
          {options.find((opt) => opt.value === value)?.label ?? "请选择"}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value === "" ? NONE_VALUE : opt.value}>
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{opt.label}</span>
              {opt.hint && (
                <span className="text-xs text-muted-foreground">{opt.hint}</span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
