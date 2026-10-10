// harness-test-tier: integration
// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { AgentCard } from "../src/renderer/components/runtime/AgentCard.tsx";
import type { RuntimeDockRow } from "../src/renderer/components/runtime/useRuntimeWorkspace.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 最近会话卡内滚动(业主 2026-10-10:714 条会话平铺把详情页撑到数万像素,
 * Prompts/Runtime 约束/操作被挤出首屏)。happy-dom 不做真实布局,「高度有上界」
 * 落在两处可复核事实上:列表容器挂共享 bounded-content 契约类,且 styles.css 里
 * 该契约类确实声明了 --long-content-cap 封顶;实测像素由 Electron 修前/修后截图
 * 另行取证(任务包 artifacts)。
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
const SESSION_COUNT = 700;

function sessionRow(index: number): RuntimeDockRow {
  return {
    runtimeSessionId: `rs-${index}`,
    agentId: "fable",
    agentName: "fable",
    delegatedByAgentId: null,
    squadId: null,
    squadName: null,
    parentRuntimeSessionId: null,
    instanceId: "codex-review",
    taskId: null,
    taskTitle: `Session ${index}`,
    startedAt: "2026-10-10T02:00:00.000Z",
    status: "succeeded",
    liveness: "exited",
    dispatchId: null,
    delegation: null,
  };
}

const mounted: { root: Root; container: HTMLElement }[] = [];

async function renderAgentCardWithSessions(count: number): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(AgentCard, {
        detail: {
          id: "fable",
          name: "fable",
          runtimes: [{ type: "codex" }],
          role: "worker",
          instructions: "Do the work.",
          instance: "",
          permissionMode: null,
          fallback: undefined,
          skills: [],
          prompts: [],
          preset: null,
        } as never,
        row: null,
        squads: [],
        instances: [
          {
            instanceId: "codex-review",
            name: "Codex Review",
            kindId: "codex",
            models: ["gpt-5.6-sol"],
            defaultModel: "gpt-5.6-sol",
            enabled: true,
          },
        ] as never,
        availableSkills: [],
        presets: [],
        busy: false,
        onSave: noop,
        onDispatch: noop,
        onSelectRuntime: noop,
        onSelectAgent: noop,
        sessions: Array.from({ length: count }, (_, index) => sessionRow(index)),
        onOpenSession: noop,
      }),
    );
  });
  mounted.push({ root, container });
  return container;
}

async function unmountAll(): Promise<void> {
  await act(async () => {
    for (const { root } of mounted.splice(0)) root.unmount();
  });
}

describe("agent detail recent sessions stay inside the bounded scroll card", () => {
  it("caps the 700-row session list with the shared bounded-content contract", async () => {
    const container = await renderAgentCardWithSessions(SESSION_COUNT);
    const bound = container.querySelector<HTMLElement>('[data-testid="agent-recent-sessions"]');
    expect(bound).toBeInstanceOf(HTMLElement);
    // 高度上界的载体:共享契约类 + 卡内滚动,与技能/预设搜索结果同一实现。
    expect(bound!.classList.contains("bounded-content")).toBe(true);
    expect(bound!.classList.contains("overflow-y-auto")).toBe(true);
    // 契约类在 styles.css 里真的封顶(防契约类被改名后类断言空转)。
    const styles = readFileSync("src/renderer/styles.css", "utf8");
    expect(styles).toMatch(/--long-content-cap:\s*55cqb/u);
    expect(styles).toMatch(/\.bounded-content\s*\{[^}]*max-block-size:\s*var\(--long-content-cap\)/u);
    // 700 行全部挂在这个有界容器里,容器外没有散落的会话行。
    const rowsInside = bound!.querySelectorAll('[data-testid^="agent-session-"]');
    const rowsEverywhere = container.querySelectorAll('[data-testid^="agent-session-"]');
    expect(rowsInside.length).toBe(SESSION_COUNT);
    expect(rowsEverywhere.length).toBe(SESSION_COUNT);
    await unmountAll();
  });

  it("keeps the runtime constraint section rendered outside the session scroll area", async () => {
    const container = await renderAgentCardWithSessions(SESSION_COUNT);
    const bound = container.querySelector<HTMLElement>('[data-testid="agent-recent-sessions"]')!;
    // Runtime 约束段仍在(实例选择器属于该段),且不在会话滚动容器里——
    // 滚动作用域只圈会话卡,不吞掉其余区块。
    const instanceSelect = container.querySelector('[data-testid="agent-instance-select"]');
    expect(instanceSelect).toBeTruthy();
    const constraintSection = instanceSelect!.closest("section");
    expect(constraintSection).toBeTruthy();
    expect(bound.contains(constraintSection!)).toBe(false);
    // 段头文案即 i18n 的 runtimeConstraint,确认选中段没有拿错。
    expect(constraintSection!.textContent).toContain("Runtime constraint");
    await unmountAll();
  });
});
