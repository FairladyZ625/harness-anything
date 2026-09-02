// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FirstRunGuide } from "../src/renderer/components/FirstRunGuide.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 首个仓库添加成功后的两步引导(独立首次运行对话框已并入
 * Settings → 仓库与连接,PLT-EdgeGUI-W3;此处只锁引导自身的顺序与出口)。
 */

const mounted: { root: Root; container: HTMLElement }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
});

describe("first-run guide", () => {
  it("guides provider/model configuration before Agent configuration", async () => {
    const next = vi.fn();
    const finish = vi.fn();
    const provider = await mount(createElement(FirstRunGuide, { stage: "provider", onNext: next, onFinish: finish }));
    expect(provider.textContent).toContain("provider and model");
    await click(provider, '[data-testid="first-run-next-agent"]');
    expect(next).toHaveBeenCalledOnce();

    const agent = await mount(createElement(FirstRunGuide, { stage: "agent", onNext: next, onFinish: finish }));
    expect(agent.textContent).toContain("Create your first Agent");
    await click(agent, '[data-testid="first-run-finish"]');
    expect(finish).toHaveBeenCalledOnce();
  });
});

async function mount(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(element));
  return container;
}

async function click(container: HTMLElement, selector: string): Promise<void> {
  const target = container.querySelector(selector) as HTMLElement;
  expect(target).toBeTruthy();
  await act(async () => target.click());
}
