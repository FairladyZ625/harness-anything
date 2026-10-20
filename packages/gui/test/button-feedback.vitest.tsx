// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Button } from "../src/renderer/components/primitives/Button.tsx";
import { AppMotionConfig, MOTION_PREFERENCE_STORAGE_KEY } from "../src/renderer/motion-config.tsx";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem(MOTION_PREFERENCE_STORAGE_KEY);
});

function render(loading: boolean, icon = false, disabled = false, onClick = vi.fn()) {
  act(() =>
    root.render(
      <Button loading={loading} disabled={disabled} onClick={onClick}>
        {icon && <svg aria-hidden="true" data-testid="original-icon" />}
        <span data-testid="original-label">提交任务 · Submit task</span>
      </Button>,
    ),
  );
  return container.querySelector("button")!;
}
const spinner = () => container.querySelector<HTMLElement>('[data-testid="button-spinner"]');

it.each([false, true])("retains original content nodes with icon=%s through loading and completion", (icon) => {
  const button = render(false, icon);
  const label = container.querySelector('[data-testid="original-label"]');
  const originalIcon = container.querySelector('[data-testid="original-icon"]');
  render(true, icon);
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(spinner()).not.toBeNull();
  expect(container.querySelector('[data-testid="original-label"]')).toBe(label);
  expect(container.querySelector('[data-testid="original-icon"]')).toBe(originalIcon);
  expect(button.textContent).toBe("提交任务 · Submit task");
  expect(button.firstElementChild?.classList.contains("col-start-1")).toBe(true);
  expect(button.firstElementChild?.classList.contains("row-start-1")).toBe(true);
  expect(spinner()?.classList.contains("absolute")).toBe(true);
  render(false, icon);
  expect(button.disabled).toBe(false);
  expect(button.hasAttribute("aria-busy")).toBe(false);
  expect(spinner()).toBeNull();
  expect(container.querySelector('[data-testid="original-label"]')).toBe(label);
});

it("disables immediately and delegates the 100ms feedback delay to CSS", () => {
  const clicked = vi.fn();
  const button = render(true, false, false, clicked);
  expect(button.disabled).toBe(true);
  expect(spinner()?.classList.contains("button-feedback-spinner")).toBe(true);
  expect(container.querySelector("button")?.style.getPropertyValue("--button-feedback-delay")).toBe("100ms");
  expect(container.querySelector("button")?.style.getPropertyValue("--button-feedback-duration")).toBe("0.1s");
  expect(button.firstElementChild?.classList.contains("button-feedback-content")).toBe(true);
  act(() => button.click());
  expect(clicked).not.toHaveBeenCalled();
});

it("keeps the same CSS animation element on unrelated rerenders", () => {
  render(true);
  const originalSpinner = spinner();
  render(true);
  expect(originalSpinner).not.toBeNull();
  expect(spinner()).toBe(originalSpinner);
});

it("preserves the delay without fade or spin when motion is turned off", () => {
  localStorage.setItem(MOTION_PREFERENCE_STORAGE_KEY, "off");
  act(() =>
    root.render(
      <AppMotionConfig>
        <Button loading>保存</Button>
      </AppMotionConfig>,
    ),
  );
  expect(spinner()).not.toBeNull();
  expect(container.querySelector("button")?.style.getPropertyValue("--button-feedback-delay")).toBe("100ms");
  expect(container.querySelector("button")?.style.getPropertyValue("--button-feedback-duration")).toBe("0s");
  expect(spinner()?.querySelector(".animate-spin")).toBeNull();
});

it("removes feedback when idle and mounts a fresh delayed overlay for the next operation", () => {
  render(false);
  expect(spinner()).toBeNull();
  render(true);
  const originalSpinner = spinner();
  render(false);
  expect(spinner()).toBeNull();
  expect(container.querySelector(".button-feedback-content")).toBeNull();
  render(true);
  expect(spinner()).not.toBeNull();
  expect(spinner()).not.toBe(originalSpinner);
  expect(container.querySelector("button")?.style.getPropertyValue("--button-feedback-delay")).toBe("100ms");
});

it("preserves explicit disabled after completion", () => {
  const button = render(true, false, true);
  render(false, false, true);
  expect(button.disabled).toBe(true);
  expect(spinner()).toBeNull();
});
