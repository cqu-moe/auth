import { useRef, useState, type ComponentPropsWithoutRef, type PointerEvent } from "react";
import { Input } from "@cqu-moe/ui";
import { normalizeOtp } from "../lib/two-factor";
import "./VerificationCodeInput.css";

type VerificationCodeInputProps = {
  value: string;
  onChange: (value: string) => void;
} & Pick<
  ComponentPropsWithoutRef<"input">,
  "id" | "name" | "disabled" | "aria-describedby" | "aria-invalid"
>;

export function VerificationCodeInput({
  value,
  onChange,
  id,
  name = "one-time-code",
  disabled,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: VerificationCodeInputProps) {
  const safeValue = normalizeOtp(value);
  const [focused, setFocused] = useState(false);
  const [selection, setSelection] = useState({ start: safeValue.length, end: safeValue.length });
  const pointerAnchorRef = useRef<number | null>(null);
  const isInvalid = ariaInvalid === true || ariaInvalid === "true";

  const syncSelection = (input: HTMLInputElement) => {
    const nextSelection = {
      start: Math.max(0, Math.min(input.selectionStart ?? safeValue.length, 6)),
      end: Math.max(0, Math.min(input.selectionEnd ?? safeValue.length, 6)),
    };
    setSelection({
      start: Math.min(nextSelection.start, nextSelection.end),
      end: Math.max(nextSelection.start, nextSelection.end),
    });
  };

  const hasSelection = focused && selection.start !== selection.end;
  const caretIndex = focused ? Math.min(selection.end, 5) : -1;

  const pointerBoundary = (event: PointerEvent<HTMLInputElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const cellWidth = bounds.width / 6;
    const cell = Math.max(0, Math.min(5, Math.floor((event.clientX - bounds.left) / cellWidth)));
    const positionInCell = (event.clientX - bounds.left - cell * cellWidth) / cellWidth;
    return Math.max(0, Math.min(6, cell + (positionInCell > 0.5 ? 1 : 0)));
  };

  const selectPointerRange = (anchor: number, head: number, input: HTMLInputElement) => {
    input.setSelectionRange(
      Math.min(anchor, head),
      Math.max(anchor, head),
      head < anchor ? "backward" : "forward"
    );
    syncSelection(input);
  };

  return (
    <span
      className="verification-code-input"
      data-input="otp"
      data-disabled={disabled || undefined}
      data-invalid={isInvalid || undefined}
    >
      <span className="verification-code-display" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => {
          const digit = safeValue[index];
          return (
            <span
              key={index}
              className="verification-code-digit"
              data-active={!hasSelection && index === caretIndex}
              data-filled={digit !== undefined}
              data-selected={hasSelection && index >= selection.start && index < selection.end}
            >
              {digit ?? ""}
            </span>
          );
        })}
      </span>
      <Input
        id={id}
        name={name}
        type="text"
        value={safeValue}
        onChange={(event) => {
          if (disabled) return;
          onChange(normalizeOtp(event.currentTarget.value));
          syncSelection(event.currentTarget);
        }}
        onFocus={(event) => {
          setFocused(true);
          syncSelection(event.currentTarget);
        }}
        onBlur={() => {
          setFocused(false);
          setSelection({ start: safeValue.length, end: safeValue.length });
        }}
        onSelect={(event) => syncSelection(event.currentTarget)}
        onKeyUp={(event) => syncSelection(event.currentTarget)}
        onMouseUp={(event) => syncSelection(event.currentTarget)}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return;
          event.preventDefault();
          const index = pointerBoundary(event);
          pointerAnchorRef.current = index;
          event.currentTarget.focus();
          selectPointerRange(index, index, event.currentTarget);
          if (event.currentTarget.hasPointerCapture?.(event.pointerId) === false) {
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }
        }}
        onPointerMove={(event) => {
          const anchor = pointerAnchorRef.current;
          if (anchor === null) return;
          event.preventDefault();
          selectPointerRange(anchor, pointerBoundary(event), event.currentTarget);
        }}
        onPointerUp={(event) => {
          const anchor = pointerAnchorRef.current;
          if (anchor === null) return;
          event.preventDefault();
          selectPointerRange(anchor, pointerBoundary(event), event.currentTarget);
          pointerAnchorRef.current = null;
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture?.(event.pointerId);
          }
        }}
        onPointerCancel={() => {
          pointerAnchorRef.current = null;
        }}
        onLostPointerCapture={() => {
          pointerAnchorRef.current = null;
        }}
        onClick={(event) => event.preventDefault()}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        required
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        enterKeyHint="done"
        aria-describedby={ariaDescribedBy}
        aria-invalid={isInvalid || undefined}
        className="verification-code-field"
      />
    </span>
  );
}
