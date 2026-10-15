// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type FormEvent } from "react";
import { createElement } from "react";
import { act } from "react";
import { cleanupUi, renderUi, setInputValue } from "../lib/api/quicklogin.testbots";
import { VerificationCodeInput } from "./VerificationCodeInput";

afterEach(async () => {
  await cleanupUi();
});

function CodeHarness({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState("");
  return createElement(VerificationCodeInput, {
    id: "verification-code",
    name: "otp",
    value,
    onChange: setValue,
    disabled,
  });
}

function enterText(input: HTMLInputElement, value: string, inputType: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("missing input value setter");
  return act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
  });
}

describe("VerificationCodeInput", () => {
  it("accepts a complete pasted code, normalizes it, and keeps one focusable input", async () => {
    const container = await renderUi(createElement(CodeHarness));
    const input = container.querySelector("input")!;
    const display = container.querySelector(".verification-code-display")!;

    await enterText(input, "  123 456abc", "insertFromPaste");

    expect(input.value).toBe("123456");
    expect(display.textContent).toBe("123456");
    expect(container.querySelectorAll("input, button, select, textarea, [tabindex]:not([tabindex='-1'])")).toHaveLength(1);
    expect(container.textContent).not.toContain("000000");
  });

  it("exposes an autofillable OTP field and submits an autofilled code", async () => {
    const submitted = vi.fn();
    function AutofillHarness() {
      const [value, setValue] = useState("");
      return createElement("form", {
        onSubmit: (event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          submitted(value, new FormData(event.currentTarget).get("one-time-code"));
        },
      },
      createElement("label", { htmlFor: "autofill-code" }, "六位验证码"),
      createElement(VerificationCodeInput, { id: "autofill-code", value, onChange: setValue }),
      createElement("button", { type: "submit" }, "完成验证"));
    }

    const container = await renderUi(createElement(AutofillHarness));
    const input = container.querySelector("input")!;
    expect(input.autocomplete).toBe("one-time-code");
    expect(input.labels?.[0]?.textContent).toBe("六位验证码");
    expect(input.hasAttribute("data-1p-ignore")).toBe(false);
    expect(input.hasAttribute("data-op-ignore")).toBe(false);
    expect(input.hasAttribute("data-lpignore")).toBe(false);

    await enterText(input, "654321", "insertReplacementText");
    expect(container.querySelector(".verification-code-display")?.textContent).toBe("654321");
    await act(async () => container.querySelector("button")!.click());
    expect(submitted).toHaveBeenCalledExactlyOnceWith("654321", "654321");
  });

  it("maps native selection to the visible cells", async () => {
    const container = await renderUi(createElement(CodeHarness));
    const input = container.querySelector("input")!;
    await enterText(input, "123456", "insertFromPaste");

    await act(async () => {
      input.focus();
      input.setSelectionRange(1, 4);
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    });

    const selected = Array.from(container.querySelectorAll<HTMLElement>(".verification-code-digit"))
      .filter(cell => cell.dataset.selected === "true");
    expect(selected.map(cell => cell.textContent)).toEqual(["2", "3", "4"]);
  });

  it("supports continued typing and deletion at the native input boundary", async () => {
    const container = await renderUi(createElement(CodeHarness));
    const input = container.querySelector("input")!;

    await enterText(input, "123a4", "insertText");
    expect(input.value).toBe("1234");

    await enterText(input, "123", "deleteContentBackward");
    expect(input.value).toBe("123");
    expect(container.querySelector(".verification-code-display")?.textContent).toBe("123");
  });

  it("maps pointer selection to the logical end so the last digit can be selected", async () => {
    const container = await renderUi(createElement(CodeHarness));
    const input = container.querySelector("input")!;
    await enterText(input, "123456", "insertFromPaste");
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 300,
      right: 300,
      top: 0,
      bottom: 48,
      x: 0,
      y: 0,
      height: 48,
      toJSON: () => ({}),
    } as DOMRect);

    await act(async () => {
      input.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 50,
      }));
      input.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        clientX: 300,
      }));
      input.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        clientX: 300,
      }));
    });

    expect(input.selectionStart).toBe(1);
    expect(input.selectionEnd).toBe(6);
    const selected = Array.from(container.querySelectorAll<HTMLElement>(".verification-code-digit"))
      .filter(cell => cell.dataset.selected === "true");
    expect(selected.map(cell => cell.textContent)).toEqual(["2", "3", "4", "5", "6"]);

    await enterText(input, "12345", "deleteContentBackward");
    expect(input.value).toBe("12345");
  });

  it("keeps a disabled field inert", async () => {
    const onChange = vi.fn();
    const container = await renderUi(createElement(VerificationCodeInput, {
      id: "verification-code",
      value: "",
      onChange,
      disabled: true,
    }));
    const input = container.querySelector("input")!;

    expect(input.disabled).toBe(true);
    await setInputValue(input, "123456");
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("uses native required and pattern validation for incomplete codes", async () => {
    const submitted = vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault());
    function ValidationHarness() {
      const [value, setValue] = useState("12345");
      return createElement("form", { onSubmit: submitted },
        createElement(VerificationCodeInput, {
          id: "verification-code",
          value,
          onChange: setValue,
        })
      );
    }

    const container = await renderUi(createElement(ValidationHarness));
    const form = container.querySelector("form")!;
    expect(form.checkValidity()).toBe(false);
    form.requestSubmit();

    await setInputValue(container.querySelector("input")!, "123456");
    expect(form.checkValidity()).toBe(true);
    form.requestSubmit();
    expect(submitted).toHaveBeenCalledTimes(1);
  });
});
