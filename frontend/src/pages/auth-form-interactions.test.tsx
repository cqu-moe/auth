// @vitest-environment jsdom
import { installPassingTurnstile } from "../lib/turnstile.testbots";

import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@cqu-moe/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupUi, click, renderUi, setInputValue, submit } from "../lib/api/quicklogin.testbots";
import Register from "./Register";
import { getRegistrationSettings } from "../lib/api/registration";
import ResetPassword from "./ResetPassword";
import ResetPasswordConfirm from "./ResetPasswordConfirm";
import SecuritySection from "../components/SecuritySection";

const authMocks = vi.hoisted(() => ({
  signUp: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
  changePassword: vi.fn(),
  listSessions: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("../lib/auth-client", () => ({
  authClient: {
    signUp: { email: authMocks.signUp },
    requestPasswordReset: authMocks.requestPasswordReset,
    resetPassword: authMocks.resetPassword,
    changePassword: authMocks.changePassword,
    listSessions: authMocks.listSessions,
    getSession: authMocks.getSession,
  },
}));

vi.mock("../lib/api/registration", () => ({
  getRegistrationSettings: vi.fn(async () => ({ invitationRequired: true })),
}));

vi.mock("../lib/recent-authentication", () => ({
  requestAuthentication: vi.fn(async () => true),
}));

vi.mock("../lib/passkey-operations", () => ({
  passkeyAccountOperation: vi.fn(),
}));

vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

async function renderPage(element: React.ReactElement, entry = "/") {
  return renderUi(
    <ThemeProvider>
      <MemoryRouter initialEntries={[entry]}>{element}</MemoryRouter>
    </ThemeProvider>,
  );
}

async function blur(element: Element) {
  await act(async () => {
    element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

async function submitTwice(form: HTMLFormElement) {
  await act(async () => {
    const event = () => new SubmitEvent("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(event());
    form.dispatchEvent(event());
    await Promise.resolve();
  });
}

function loadingButton(form: HTMLFormElement) {
  return form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
}

function deferredRejection() {
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<never>((_, nextReject) => {
    reject = nextReject;
  });
  return { promise, reject };
}

beforeEach(() => {
  installPassingTurnstile();
  authMocks.signUp.mockResolvedValue({ error: null });
  authMocks.requestPasswordReset.mockResolvedValue({ error: null });
  authMocks.resetPassword.mockResolvedValue({ error: null });
  authMocks.changePassword.mockResolvedValue({ error: null });
});

afterEach(async () => {
  await cleanupUi();
  vi.clearAllMocks();
});

describe("authentication form interactions", () => {
  it("defers blur validation when focusing submit so the button stays under the pointer", async () => {
    const container = await renderPage(<Register />, "/register?code=ABCDEFGH");
    const name = container.querySelector<HTMLInputElement>("#name")!;
    const button = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => name.focus());
    await act(async () => button.focus());
    expect(container.querySelector("#name-error")).toBeNull();
    await submit(container.querySelector<HTMLFormElement>("form")!);
    expect(container.querySelector("#name-error")?.textContent).toBe("请输入昵称");
    expect(document.activeElement).toBe(name);
    expect(authMocks.signUp).not.toHaveBeenCalled();
  });

  it("shows confirmation mismatch after blur, clears it after correction, and focuses the first invalid field", async () => {
    const container = await renderPage(<Register />, "/register?code=ABCDEFGH");

    await setInputValue(container.querySelector<HTMLInputElement>("#password")!, "password-123");
    const confirmPassword = container.querySelector<HTMLInputElement>("#confirmPassword")!;
    await setInputValue(confirmPassword, "p");
    expect(container.querySelector("#confirm-password-error")).toBeNull();
    expect(confirmPassword.getAttribute("aria-invalid")).toBeNull();

    await blur(confirmPassword);
    expect(container.querySelector("#confirm-password-error")?.textContent).toBe("两次输入的密码不一致");
    expect(confirmPassword.getAttribute("aria-invalid")).toBe("true");
    expect(confirmPassword.getAttribute("aria-describedby")).toBe("confirm-password-error");

    await setInputValue(confirmPassword, "password-123");
    expect(container.querySelector("#confirm-password-error")).toBeNull();
    expect(confirmPassword.getAttribute("aria-invalid")).toBeNull();

    await setInputValue(container.querySelector<HTMLInputElement>("#name")!, "");
    await submit(container.querySelector<HTMLFormElement>("form")!);
    expect(container.querySelector("#name-error")?.textContent).toBe("请输入昵称");
    expect(document.activeElement?.id).toBe("name");
  });

  it("validates an optional invitation when supplied, while allowing it to be empty", async () => {
    vi.mocked(getRegistrationSettings).mockResolvedValueOnce({ invitationRequired: false });
    const container = await renderPage(<Register />, "/register");
    await setInputValue(container.querySelector<HTMLInputElement>("#name")!, "New User");
    await setInputValue(container.querySelector<HTMLInputElement>("#email")!, "new@example.com");
    await setInputValue(container.querySelector<HTMLInputElement>("#password")!, "password-123");
    await setInputValue(container.querySelector<HTMLInputElement>("#confirmPassword")!, "password-123");
    const invitation = container.querySelector<HTMLInputElement>("#invitationCode")!;
    await setInputValue(invitation, "invalid");
    await submit(container.querySelector<HTMLFormElement>("form")!);
    expect(authMocks.signUp).not.toHaveBeenCalled();
    expect(invitation.getAttribute("aria-invalid")).toBe("true");
    await setInputValue(invitation, "");
    await submit(container.querySelector<HTMLFormElement>("form")!);
    expect(authMocks.signUp).toHaveBeenCalledOnce();
  });

  it("blocks duplicate registration submissions and recovers from a thrown request", async () => {
    const container = await renderPage(<Register />, "/register?code=ABCDEFGH");
    await setInputValue(container.querySelector<HTMLInputElement>("#name")!, "New User");
    await setInputValue(container.querySelector<HTMLInputElement>("#email")!, "new@example.com");
    await setInputValue(container.querySelector<HTMLInputElement>("#password")!, "password-123");
    await setInputValue(container.querySelector<HTMLInputElement>("#confirmPassword")!, "password-123");
    const form = container.querySelector<HTMLFormElement>("form")!;

    const rejection = deferredRejection();
    authMocks.signUp.mockReset();
    authMocks.signUp.mockImplementationOnce(() => rejection.promise);
    authMocks.signUp.mockResolvedValueOnce({ error: { message: "注册暂不可用" } });
    await submitTwice(form);

    expect(authMocks.signUp).toHaveBeenCalledTimes(1);
    expect(loadingButton(form).getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      rejection.reject(new Error("network failed"));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("网络错误，请稍后重试");
    expect(loadingButton(form).getAttribute("aria-busy")).toBe("false");
    expect(container.querySelector<HTMLInputElement>("#email")!.value).toBe("new@example.com");

    await submit(form);
    expect(authMocks.signUp).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLInputElement>("#password")!.value).toBe("password-123");
  });

  it("validates the reset email after blur or submit and recovers from a thrown request", async () => {
    const container = await renderPage(<ResetPassword />);
    const email = container.querySelector<HTMLInputElement>("#email")!;
    const form = container.querySelector<HTMLFormElement>("form")!;

    await setInputValue(email, "not-an-email");
    expect(container.querySelector("#email-error")).toBeNull();
    await blur(email);
    expect(container.querySelector("#email-error")?.textContent).toBe("请输入有效的邮箱地址");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(email.getAttribute("aria-describedby")).toBe("email-error");

    await setInputValue(email, "user@example.com");
    expect(container.querySelector("#email-error")).toBeNull();

    const rejection = deferredRejection();
    authMocks.requestPasswordReset.mockReset();
    authMocks.requestPasswordReset.mockImplementationOnce(() => rejection.promise);
    await submitTwice(form);
    expect(authMocks.requestPasswordReset).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejection.reject(new Error("network failed"));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("网络错误，请稍后重试");
    expect(loadingButton(form).getAttribute("aria-busy")).toBe("false");
    expect(email.value).toBe("user@example.com");
  });

  it("delays reset confirmation mismatch until blur and recovers from a thrown request", async () => {
    const container = await renderPage(
      <ResetPasswordConfirm />,
      "/reset-password/confirm?token=test-token",
    );
    await setInputValue(container.querySelector<HTMLInputElement>("#password")!, "password-123");
    const confirmPassword = container.querySelector<HTMLInputElement>("#confirmPassword")!;
    await setInputValue(confirmPassword, "p");
    expect(container.querySelector("#confirm-password-error")).toBeNull();

    await blur(confirmPassword);
    expect(container.querySelector("#confirm-password-error")?.textContent).toBe("两次输入的密码不一致");
    await setInputValue(confirmPassword, "password-123");
    expect(container.querySelector("#confirm-password-error")).toBeNull();

    const rejection = deferredRejection();
    authMocks.resetPassword.mockReset();
    authMocks.resetPassword.mockImplementationOnce(() => rejection.promise);
    await submitTwice(container.querySelector<HTMLFormElement>("form")!);
    expect(authMocks.resetPassword).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejection.reject(new Error("network failed"));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("网络错误，请稍后重试");
    expect(loadingButton(container.querySelector<HTMLFormElement>("form")!).getAttribute("aria-busy")).toBe("false");
    expect(confirmPassword.value).toBe("password-123");
  });

  it("focuses invalid security fields, delays confirmation feedback, and recovers from a thrown password change", async () => {
    const container = await renderPage(<SecuritySection twoFactorEnabled={false} />);
    await click(container.querySelector('[aria-label="修改密码"]')!);
    const form = container.querySelector<HTMLFormElement>("#change-password-form")!;

    await submit(form);
    const currentPassword = container.querySelector<HTMLInputElement>("#currentPassword")!;
    expect(currentPassword.getAttribute("aria-invalid")).toBe("true");
    expect(currentPassword.getAttribute("aria-describedby")).toBe("current-password-error");
    expect(document.activeElement?.id).toBe("currentPassword");

    await setInputValue(currentPassword, "old-password");
    await setInputValue(container.querySelector<HTMLInputElement>("#newPassword")!, "new-password-123");
    const confirmPassword = container.querySelector<HTMLInputElement>("#confirmNewPassword")!;
    await setInputValue(confirmPassword, "n");
    expect(container.querySelector("#confirm-password-error")).toBeNull();
    await blur(confirmPassword);
    expect(container.querySelector("#confirm-password-error")?.textContent).toBe("两次输入的新密码不一致");
    await setInputValue(confirmPassword, "new-password-123");
    expect(container.querySelector("#confirm-password-error")).toBeNull();

    const rejection = deferredRejection();
    authMocks.changePassword.mockReset();
    authMocks.changePassword.mockImplementationOnce(() => rejection.promise);
    await submitTwice(form);
    expect(authMocks.changePassword).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejection.reject(new Error("network failed"));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("network failed");
    expect(loadingButton(form).getAttribute("aria-busy")).toBe("false");
    expect(currentPassword.value).toBe("old-password");
  });
});
