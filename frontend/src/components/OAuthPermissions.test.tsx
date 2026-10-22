// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import OAuthPermissions from "./OAuthPermissions";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("explains the QuickLogin device scope without showing the raw scope name", () => {
  act(() => root.render(createElement(OAuthPermissions, {
    scopes: ["openid", "cqu:quicklogin:device"],
  })));

  expect(container.textContent).toContain("QuickLogin 浏览器设备");
  expect(container.textContent).toContain("授权当前浏览器作为您的 QuickLogin 设备");
  expect(container.textContent).not.toContain("cqu:quicklogin:device");
});
