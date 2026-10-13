// @vitest-environment jsdom

import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  click,
  cleanupUi,
  renderUi,
  setInputValue,
  settleUi,
} from "../lib/api/quicklogin.testbots";
import AccountProfileSection from "./AccountProfileSection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const updateUser = vi.hoisted(() => vi.fn());

vi.mock("../lib/auth-client", () => ({
  authClient: { updateUser },
}));

type UpdateResult = { error: null } | { error: Record<string, never> };

function profileProps(onSessionRefresh: () => Promise<unknown> = async () => undefined) {
  return {
    name: "现有昵称",
    email: "old@example.com",
    onSessionRefresh,
  };
}

async function renderProfile(props = profileProps()) {
  return renderUi(
    <MemoryRouter initialEntries={["/settings"]}>
      <AccountProfileSection {...props} />
    </MemoryRouter>
  );
}

function button(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).find(
    element => element.textContent?.trim() === label
  )!;
}

function actionButton(container: HTMLElement, state: string) {
  return container.querySelector<HTMLButtonElement>(
    `button[data-action-state="${state}"]`
  )!;
}

function hasStatus(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll('[role="status"]')).some(element =>
    element.textContent?.includes(text)
  );
}

async function pressKey(element: Element, key: string) {
  await act(async () => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    );
  });
  await settleUi();
}

async function pressEnter(input: HTMLInputElement, isComposing = false) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "isComposing", { value: isComposing });

  await act(async () => {
    input.dispatchEvent(event);
    // jsdom does not synthesize a form submit from Enter; submit stands in for
    // the browser's native implicit submission after an uncanceled keydown.
    if (!isComposing) {
      input.form?.dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true })
      );
    }
  });
  await settleUi();
  return event;
}

afterEach(async () => {
  await cleanupUi();
  vi.clearAllMocks();
});

describe("account profile settings", () => {
  it("edits the nickname in its summary row and restores focus after Escape or cancel", async () => {
    const container = await renderProfile();
    const row = container.querySelector("div.flex-wrap")!;
    const editButton = container.querySelector<HTMLButtonElement>('[aria-label="修改昵称"]')!;
    expect(document.activeElement).not.toBe(container.querySelector("#displayName"));

    await click(editButton);
    const input = container.querySelector<HTMLInputElement>("#displayName")!;
    const form = input.closest("form")!;
    expect(row.contains(form)).toBe(true);
    expect(form.className).toContain("flex-wrap");
    expect(input.className).toContain("basis-40");
    expect(document.activeElement).toBe(input);
    expect(container.querySelector('label[for="displayName"]')?.textContent).toBe("昵称");
    expect(container.textContent).not.toContain("新昵称");

    await setInputValue(input, " Escape 草稿 ");
    await pressKey(input, "Escape");
    expect(container.querySelector("#displayName")).toBeNull();
    expect(container.textContent).toContain("现有昵称");
    expect(document.activeElement).toBe(
      container.querySelector<HTMLButtonElement>('[aria-label="修改昵称"]')
    );

    await click(document.activeElement!);
    await setInputValue(container.querySelector<HTMLInputElement>("#displayName")!, "取消草稿");
    await click(button(container, "取消"));
    expect(container.querySelector("#displayName")).toBeNull();
    expect(container.textContent).toContain("现有昵称");
    expect(document.activeElement).toBe(
      container.querySelector<HTMLButtonElement>('[aria-label="修改昵称"]')
    );
  });

  it("saves through native Enter submission once the server accepts the update", async () => {
    let resolveUpdate!: (result: UpdateResult) => void;
    const onSessionRefresh = vi.fn(async () => undefined);
    updateUser.mockImplementation(
      () => new Promise<UpdateResult>(resolve => {
        resolveUpdate = resolve;
      })
    );

    const container = await renderProfile(profileProps(onSessionRefresh));
    await click(container.querySelector<HTMLButtonElement>('[aria-label="修改昵称"]')!);
    const input = container.querySelector<HTMLInputElement>("#displayName")!;
    await setInputValue(input, "  新昵称  ");
    const composingEvent = await pressEnter(input, true);
    expect(updateUser).not.toHaveBeenCalled();
    expect(composingEvent.defaultPrevented).toBe(false);

    const form = input.closest("form")!;
    await act(async () => {
      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    });
    await settleUi();

    expect(updateUser).toHaveBeenCalledTimes(1);
    expect(updateUser).toHaveBeenCalledWith({ name: "新昵称" });
    expect(actionButton(container, "loading").disabled).toBe(true);
    expect(input.readOnly).toBe(true);
    expect(hasStatus(container, "昵称已更新")).toBe(false);

    await act(async () => {
      resolveUpdate({ error: null });
      await Promise.resolve();
    });
    await settleUi();

    expect(onSessionRefresh).toHaveBeenCalledTimes(1);
    expect(container.querySelector("#displayName")).toBeNull();
    expect(hasStatus(container, "昵称已更新")).toBe(true);
    expect(document.activeElement).toBe(
      container.querySelector<HTMLButtonElement>('[aria-label="修改昵称"]')
    );
  });

  it("keeps the server-confirmed nickname visible when the session refetch fails", async () => {
    updateUser.mockResolvedValueOnce({ error: null });
    const onSessionRefresh = vi.fn(async () => {
      throw new Error("session refresh failed");
    });
    const container = await renderProfile(profileProps(onSessionRefresh));

    await click(container.querySelector<HTMLButtonElement>('[aria-label="修改昵称"]')!);
    const input = container.querySelector<HTMLInputElement>("#displayName")!;
    await setInputValue(input, "已确认昵称");
    await pressEnter(input);

    expect(container.querySelector("#displayName")).toBeNull();
    expect(container.textContent).toContain("已确认昵称");
    expect(container.textContent).not.toContain("现有昵称");
    expect(hasStatus(container, "昵称已更新")).toBe(true);
  });

  it("keeps the typed nickname for retry when an error object has no message", async () => {
    updateUser.mockResolvedValueOnce({ error: {} });
    const container = await renderProfile();

    await click(container.querySelector<HTMLButtonElement>('[aria-label="修改昵称"]')!);
    const input = container.querySelector<HTMLInputElement>("#displayName")!;
    await setInputValue(input, "离线昵称");
    await pressEnter(input);

    expect(input.value).toBe("离线昵称");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("昵称修改失败");
    expect(hasStatus(container, "昵称已更新")).toBe(false);
    expect(actionButton(container, "error").disabled).toBe(false);
  });

  it("keeps the email action as a compact summary link", async () => {
    const container = await renderProfile();
    expect(container.textContent).toContain("个人信息");
    expect(container.textContent).toContain("old@example.com");
    expect(container.querySelector('[aria-label="修改邮箱"]')?.getAttribute("href")).toBe(
      "/settings/email"
    );
  });
});
