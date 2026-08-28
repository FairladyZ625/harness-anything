// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FirstRunGuide, FirstRunWizard } from "../src/renderer/components/FirstRunWizard.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

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
  Reflect.deleteProperty(window, "harness");
});

describe("first-run wizard", () => {
  it("submits the selected repository and owner identity to the preload bridge", async () => {
    const bootstrap = vi.fn(async () => ({ ok: true, command: "init" }));
    Object.defineProperty(window, "harness", {
      configurable: true,
      value: {
        firstRun: {
          chooseRepository: async () => "/Users/owner/Projects/example-repo",
          bootstrap,
        },
      },
    });
    const ready = vi.fn(async () => undefined);
    const container = await mount(createElement(FirstRunWizard, { onBootstrapped: ready }));

    await click(container, "button", "Choose…");
    await change(container, "first-run-person-id", "person_owner");
    await change(container, "first-run-display-name", "Owner");
    await click(container, '[data-testid="first-run-bootstrap"]');

    expect(bootstrap).toHaveBeenCalledWith({
      rootDir: "/Users/owner/Projects/example-repo",
      repoId: "example-repo",
      personId: "person_owner",
      displayName: "Owner",
      name: "example-repo",
    });
    expect(ready).toHaveBeenCalledWith("example-repo");
  });

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

async function change(container: HTMLElement, testId: string, value: string): Promise<void> {
  const input = container.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(container: HTMLElement, selector: string, text?: string): Promise<void> {
  const candidates = [...container.querySelectorAll(selector)] as HTMLElement[];
  const target =
    text === undefined ? candidates[0] : candidates.find((candidate) => candidate.textContent?.trim() === text);
  expect(target).toBeTruthy();
  await act(async () => target!.click());
}
