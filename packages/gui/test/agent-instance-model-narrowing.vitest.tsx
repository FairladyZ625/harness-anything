// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { AgentCard } from "../src/renderer/components/runtime/AgentCard.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 实例 pin 与模型选项的联动(反熵 finding「GUI 实例与模型选择脱节」):固定 instance 后,
 * 该 kind 行的模型选项必须收窄到 pinned 实例的 models——否则可以从同 kind 的其他实例借
 * 一个 pinned 实例没有的模型,daemon 端 agentRuntimeSelectionIssue 以
 * agent_instance_incompatible 拒绝(runtimes 行的 model 必须在 pinned 实例的 models 里)。
 * 未 pin 时保持该 kind 启用实例的并集;runtime 行被移除时清掉不再匹配的 pin。
 */
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const noop = () => undefined;
const codexReview = {
    instanceId: "codex-review",
    name: "Codex Review",
    kindId: "codex",
    models: ["gpt-5.6-sol"],
    defaultModel: "gpt-5.6-sol",
    enabled: true,
  } as const,
  codexBulk = {
    instanceId: "codex-bulk",
    name: "Codex Bulk",
    kindId: "codex",
    models: ["gpt-5.6-bulk"],
    defaultModel: "gpt-5.6-bulk",
    enabled: true,
  } as const,
  claudeOne = {
    instanceId: "claude-one",
    name: "Claude One",
    kindId: "claude",
    models: ["claude-opus-4"],
    defaultModel: "claude-opus-4",
    enabled: true,
  } as const;

const mounted: { root: Root; container: HTMLElement }[] = [];

async function renderAgentCard(instance: string, runtimes: readonly { readonly type: string }[]): Promise<HTMLElement> {
  return renderAgentCardProps(instance, runtimes, {});
}

async function renderAgentCardProps(
  instance: string,
  runtimes: readonly { readonly type: string }[],
  extra: Record<string, unknown>,
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(AgentCard, {
        detail: {
          id: "fable",
          name: "fable",
          runtimes,
          role: "worker",
          instructions: "Do the work.",
          instance,
          permissionMode: null,
          fallback: undefined,
          skills: [],
          prompts: [],
          preset: null,
        } as never,
        row: null,
        squads: [],
        instances: [codexReview, codexBulk, claudeOne] as never,
        availableSkills: [],
        presets: [],
        busy: false,
        onSave: noop,
        onDispatch: noop,
        onSelectSquad: noop,
        onSelectRuntime: noop,
        onSelectAgent: noop,
        ...extra,
      }),
    );
  });
  mounted.push({ root, container });
  return container;
}

function renderAgentCardWithActionError(
  instance: string,
  runtimes: readonly { readonly type: string }[],
  actionError: string,
): Promise<HTMLElement> {
  return renderAgentCardProps(instance, runtimes, { actionError });
}

async function unmountAll(): Promise<void> {
  await act(async () => {
    for (const { root } of mounted.splice(0)) root.unmount();
  });
}

function codexModelOptions(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll<HTMLSelectElement>('[data-testid="agent-runtime-model-codex"] option')]
    .map((option) => option.value)
    .filter((value) => value !== "");
}

describe("agent card instance pin narrows per-kind model options", () => {
  it("offers only the pinned instance's models on its kind row", async () => {
    const container = await renderAgentCard("codex-bulk", [{ type: "codex" }]);
    expect(codexModelOptions(container)).toEqual(["gpt-5.6-bulk"]);
    await unmountAll();
  });

  it("keeps the kind's enabled-instance union when no instance is pinned", async () => {
    const container = await renderAgentCard("", [{ type: "codex" }]);
    expect(codexModelOptions(container)).toEqual(["gpt-5.6-bulk", "gpt-5.6-sol"]);
    await unmountAll();
  });

  it("clears the instance pin when its runtime row is removed", async () => {
    const container = await renderAgentCard("codex-bulk", [{ type: "codex" }, { type: "claude" }]);
    const instanceSelect = () => container.querySelector<HTMLSelectElement>('[data-testid="agent-instance-select"]')!;
    expect(instanceSelect().value).toBe("codex-bulk");
    const removeCodex = container.querySelector<HTMLButtonElement>('[aria-label="Remove codex"]');
    expect(removeCodex).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      removeCodex!.click();
    });
    expect(instanceSelect().value).toBe("");
    await unmountAll();
  });

  // 标准第 2.5 节(业主 2026-09-30:daemon 超时导致保存失败只显示通用错误):保存失败
  // 的原因必须就在保存按钮所在的动作区显示,不只是页首通用错误条。
  it("renders the save-failure reason in place next to the save action", async () => {
    const container = await renderAgentCard("", [{ type: "codex" }]);
    expect(container.querySelector('[data-testid="action-error"]')).toBeNull();
    await unmountAll();
    const withError = await renderAgentCardWithActionError(
      "",
      [{ type: "codex" }],
      "「保存 Agent 声明」失败: daemon request timed out after 30000ms",
    );
    const inline = withError.querySelector('[data-testid="action-error"]');
    expect(inline).toBeTruthy();
    expect(inline!.getAttribute("role")).toBe("alert");
    expect(inline!.textContent).toContain("daemon request timed out");
    const save = withError.querySelector('[data-testid="agent-save"]');
    expect(save).toBeTruthy();
    // 就地:错误块与保存按钮同在动作区里(同一 Sect)。
    expect(inline!.closest("section")).toBe(save!.closest("section"));
    await unmountAll();
  });
});
