// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ErrorBoundary } from "../src/renderer/components/ErrorBoundary.tsx";

let container: HTMLElement;
let root: Root;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  // React logs the caught error to console.error; keep the test output clean.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function mount(children: ReactNode) {
  act(() => root.render(createElement(ErrorBoundary, null, children)));
}

describe("ErrorBoundary", () => {
  it("renders a recoverable fallback instead of unmounting when a child throws", () => {
    const Boom = () => {
      throw new Error("boom-marker-42");
    };
    mount(createElement(Boom));
    // The fallback panel is shown (not a blank tree) and carries the error message.
    expect(container.textContent).toContain("此视图出现错误");
    expect(container.textContent).toContain("boom-marker-42");
    // The two recovery affordances are present.
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.some((l) => l.includes("重试"))).toBe(true);
    expect(labels.some((l) => l.includes("重新加载"))).toBe(true);
  });

  it("renders children normally when nothing throws", () => {
    mount(createElement("div", { "data-testid": "ok" }, "healthy-content"));
    expect(container.querySelector('[data-testid="ok"]')).not.toBeNull();
    expect(container.textContent).toContain("healthy-content");
    expect(container.textContent).not.toContain("此视图出现错误");
  });

  it("recovers to the children on retry once the child stops throwing", () => {
    let shouldThrow = true;
    const Maybe = () => {
      if (shouldThrow) throw new Error("transient");
      return createElement("div", null, "recovered-content");
    };
    mount(createElement(Maybe));
    expect(container.textContent).toContain("此视图出现错误");

    shouldThrow = false;
    const retry = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("重试"));
    expect(retry).toBeTruthy();
    act(() => retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(container.textContent).toContain("recovered-content");
    expect(container.textContent).not.toContain("此视图出现错误");
  });
});
