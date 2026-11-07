// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentCard, agentDeclarationFrom, agentDraftFrom } from "../src/renderer/components/runtime/AgentCard.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 宿主访问三档在 Agent 详情里的可见与可改:默认 operator 标注「默认」,isolated / operator /
 * bypass 都可选,保存仍走 AgentCard 既有的 onSave(agent-install 声明写路),不新开写路径。
 */
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});
afterEach(() => {
  vi.restoreAllMocks();
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
});

const mounted: { root: Root; container: HTMLElement }[] = [];
const noop = () => undefined;

function detail(hostAccess: "isolated" | "operator" | "bypass", hostAccessSource: "declared" | "default") {
  return {
    id: "terra",
    name: "Terra",
    runtimes: [{ type: "codex" }],
    role: "worker",
    instructions: "Do the work.",
    skills: [],
    prompts: [],
    preset: null,
    instance: null,
    permissionMode: null,
    hostAccess,
    hostAccessSource,
    revision: 3,
    retirement: null,
  } as const;
}

async function mountCard(
  agent: ReturnType<typeof detail>,
  onSave: (declaration: unknown, expectedVersion: number) => void = noop,
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(AgentCard, {
        detail: agent as never,
        row: null,
        squads: [],
        instances: [],
        availableSkills: [],
        presets: [],
        busy: false,
        onSave,
        onDispatch: noop,
        onSelectRuntime: noop,
        onSelectAgent: noop,
      }),
    );
  });
  mounted.push({ root, container });
  return container;
}

const option = (container: HTMLElement, hostAccess: string) =>
  container.querySelector<HTMLButtonElement>(`[data-testid="agent-host-access-${hostAccess}"]`)!;

describe("Agent host access is visible and selectable in the declaration editor", () => {
  it("shows the effective operator default with a default marker", async () => {
    const container = await mountCard(detail("operator", "default"));
    expect(container.querySelector('[data-testid="agent-host-access"]')).toBeTruthy();
    expect(option(container, "operator").getAttribute("aria-pressed")).toBe("true");
    expect(option(container, "isolated").getAttribute("aria-pressed")).toBe("false");
    expect(option(container, "bypass").getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).toContain("The declaration names no tier, so the default operator applies");
    expect(container.textContent).toContain("default");
  });

  it("saves an explicit isolated tier through the existing declaration save path", async () => {
    const onSave = vi.fn();
    const container = await mountCard(detail("operator", "default"), onSave);
    await act(async () => option(container, "isolated").click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="agent-save"]')!.click());
    expect(onSave).toHaveBeenCalledTimes(1);
    const [declaration, expectedVersion] = onSave.mock.calls[0]!;
    expect(expectedVersion).toBe(3);
    expect((declaration as { hostAccess?: string }).hostAccess).toBe("isolated");
  });

  it("round-trips an explicit bypass tier and offers all three tiers", async () => {
    const agent = detail("bypass", "declared");
    expect(agentDeclarationFrom(agent.id, agentDraftFrom(agent as never))).toMatchObject({ hostAccess: "bypass" });
    const container = await mountCard(agent);
    expect(option(container, "bypass").getAttribute("aria-pressed")).toBe("true");
    for (const hostAccess of ["isolated", "operator", "bypass"]) expect(option(container, hostAccess)).toBeTruthy();
    expect(container.textContent).not.toContain("The declaration names no tier");
  });

  it("leaves an untouched default declaration without an explicit hostAccess field", async () => {
    const agent = detail("operator", "default");
    expect(agentDeclarationFrom(agent.id, agentDraftFrom(agent as never))).not.toHaveProperty("hostAccess");
  });
});
