import { useRef, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Switch,
} from "@cqu-moe/ui";
import SharedCopyButton from "../../components/CopyButton";

export function FieldLabel({
  children,
  hint,
  htmlFor,
}: {
  children: ReactNode;
  hint?: string;
  htmlFor?: string;
}) {
  return (
    <div className="mb-1.5">
      <Label htmlFor={htmlFor} className="text-xs">{children}</Label>
      {hint && <span className="ml-2 text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

// Editable list of single-line strings (add / remove rows). Always renders at
// least one row so the user has something to type into.
export function StringListInput({
  values,
  onChange,
  placeholder,
  addLabel,
  idPrefix,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  addLabel: string;
  idPrefix?: string;
}) {
  const rows = values.length === 0 ? [""] : values;

  const setAt = (i: number, v: string) => {
    const next = [...rows];
    next[i] = v;
    onChange(next);
  };
  const removeAt = (i: number) => {
    onChange(rows.filter((_, idx) => idx !== i));
  };
  const add = () => onChange([...rows, ""]);

  return (
    <div className="space-y-2">
      {rows.map((val, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            type="text"
            value={val}
            onChange={(e) => setAt(i, e.target.value)}
            placeholder={placeholder}
            aria-label={`${addLabel} 第 ${i + 1} 项`}
            id={idPrefix ? `${idPrefix}-${i}` : undefined}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => removeAt(i)}
            disabled={rows.length === 1}
            className="text-muted-foreground hover:text-destructive"
            aria-label="删除此项"
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="link"
        size="sm"
        onClick={add}
        className="px-0"
      >
        <Plus aria-hidden="true" size={16} />
        {addLabel}
      </Button>
    </div>
  );
}

// Accessible on/off toggle built on the shared Switch.
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
    <div className="flex items-center justify-between gap-3 py-1">
      <span>
        <span className="text-sm text-foreground">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

// Compact wrapper preserves the admin surface while sharing clipboard lifecycle.
export function CopyButton({ value }: { value: string }) {
  return <SharedCopyButton value={value} compact />;
}

// Centered modal shell built on the shared Dialog primitives.
export function Modal({
  onClose,
  title,
  description,
  children,
  footer,
  maxWidth = "max-w-xl",
}: {
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  maxWidth?: string;
}) {
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className={maxWidth} onCloseAutoFocus={(event) => {
        if (returnFocus.current?.isConnected) {
          event.preventDefault();
          returnFocus.current.focus();
        }
      }}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

export { DialogFooter };
