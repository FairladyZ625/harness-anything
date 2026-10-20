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
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
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
const spinner = () => container.querySelector('[data-testid="button-spinner"]');
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

it.each([false, true])("retains original content nodes with icon=%s through loading and completion", (icon) => {
  const button = render(false, icon);
  const label = container.querySelector('[data-testid="original-label"]');
  const originalIcon = container.querySelector('[data-testid="original-icon"]');
  render(true, icon);
  advance(100);
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(spinner()).not.toBeNull();
  expect(container.querySelector('[data-testid="original-label"]')).toBe(label);
  expect(container.querySelector('[data-testid="original-icon"]')).toBe(originalIcon);
  expect(button.textContent).toBe("提交任务 · Submit task");
  render(false, icon);
  expect(button.disabled).toBe(false);
  expect(spinner()).toBeNull();
  expect(container.querySelector('[data-testid="original-label"]')).toBe(label);
});

it("disables immediately but never renders a spinner below 100ms", () => {
  const clicked = vi.fn();
  const button = render(true, false, false, clicked);
  expect(button.disabled).toBe(true);
  expect(spinner()).toBeNull();
  expect(button.firstElementChild?.classList.contains("opacity-0")).toBe(false);
  advance(99);
  expect(spinner()).toBeNull();
  act(() => button.click());
  expect(clicked).not.toHaveBeenCalled();
  advance(1);
  expect(spinner()).not.toBeNull();
  expect(button.firstElementChild?.classList.contains("opacity-0")).toBe(true);
});

it("does not restart the delay on unrelated rerenders", () => {
  render(true);
  advance(60);
  render(true);
  advance(40);
  expect(spinner()).not.toBeNull();
});

it("keeps feedback static when motion is turned off", () => {
  localStorage.setItem(MOTION_PREFERENCE_STORAGE_KEY, "off");
  act(() =>
    root.render(
      <AppMotionConfig>
        <Button loading>保存</Button>
      </AppMotionConfig>,
    ),
  );
  advance(100);
  expect(spinner()).not.toBeNull();
  expect(spinner()?.querySelector(".animate-spin")).toBeNull();
});

it("cancels fast operations and starts a fresh delay on subsequent operations", () => {
  render(true);
  advance(99);
  render(false);
  advance(1);
  expect(spinner()).toBeNull();
  render(true);
  advance(99);
  expect(spinner()).toBeNull();
  advance(1);
  expect(spinner()).not.toBeNull();
  render(false);
  render(true);
  expect(spinner()).toBeNull();
  advance(99);
  expect(spinner()).toBeNull();
  advance(1);
  expect(spinner()).not.toBeNull();
});

it("clears pending feedback on unmount and preserves explicit disabled after completion", () => {
  const button = render(true, false, true);
  advance(100);
  render(false, false, true);
  expect(button.disabled).toBe(true);
  render(true);
  act(() => root.render(null));
  expect(vi.getTimerCount()).toBe(0);
});
