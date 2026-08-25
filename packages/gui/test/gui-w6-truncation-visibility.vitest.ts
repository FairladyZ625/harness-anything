// harness-test-tier: fast
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { CommandPalette, type PaletteEntry } from "../src/renderer/components/CommandPalette.tsx";
import { TaskPreviewDrawer } from "../src/renderer/components/TaskPreviewDrawer.tsx";
import {
  IdentityInspector,
  ProviderInspector,
  SessionInspector,
} from "../src/renderer/components/runtime/RuntimeInspector.tsx";
import { DecisionsView } from "../src/renderer/views/DecisionsView.tsx";
import type { DecisionJudgmentConsent, DecisionRow, EventEntry, TaskRow } from "../src/renderer/model/types.ts";
import type { RuntimeDockRow } from "../src/renderer/runtime-panorama.ts";
import type { AgentRuntimeSessionDto } from "../../daemon/src/agent-runtime-contract.ts";
import {
  AGENT_ID,
  DECISION_ID,
  FIXTURE_AGENT_ROW,
  FIXTURE_DECISIONS,
  FIXTURE_DOCK_ROW,
  FIXTURE_FACTS,
  FIXTURE_INSTANCE,
  FIXTURE_RELATIONS,
  FIXTURE_SESSION_DTO,
  FIXTURE_SQUAD_ROW,
  FIXTURE_TASKS,
  TASK_A_ID,
  fixtureTaskRow,
} from "./entityIdGateFixtures.ts";

/**
 * W6 Goal 第三个合取项(`task_be076d3ac25b87b79be09b02dd`)原判「只显示前 N 条必须显形」;
 * 2026-08-25 泽宇裁决升格为「不许要求用户点击显形」,站点改为**完整渲染**:
 * 命令面板、任务预览抽屉的事件流、provider/agent inspector 会话段、判定历史。
 * 每条断言改成两个方向:全量行在 DOM 里 + 「再显示」按钮不存在(负向断言防倒退)。
 * 会话页右栏 SessionInspector 不在本任务文件面内(归会话页重构任务),仍分批。
 */

const noop = () => undefined;

/** en-US 目录里 showMore 家族的尾巴,断言只认这一段,不绑定整句排版。 */
const remaining = (count: number) => `${count} remaining`;

function paletteEntries(total: number): PaletteEntry[] {
  return Array.from({ length: total }, (_, index) => ({
    ref: `task/task_${String(index).padStart(6, "0")}`,
    label: `Task ${index}`,
    entity: "task" as const,
  }));
}

function taskWithEvents(total: number): TaskRow {
  const events: EventEntry[] = Array.from({ length: total }, (_, index) => ({
    at: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    projectId: "repo-g10",
    taskId: TASK_A_ID,
    summary: `事件 ${index}`,
  }));
  return { ...fixtureTaskRow(TASK_A_ID, "W6 截断显形"), events };
}

function dockRows(total: number): RuntimeDockRow[] {
  return Array.from({ length: total }, (_, index) => ({
    ...FIXTURE_DOCK_ROW,
    runtimeSessionId: `session-${index}`,
    dispatchId: `dispatch-${index}`,
    agentId: AGENT_ID,
  }));
}

function sessionDtos(total: number): AgentRuntimeSessionDto[] {
  return Array.from({ length: total }, (_, index) => ({
    ...FIXTURE_SESSION_DTO,
    runtimeSessionId: `session-${index}`,
  }));
}

function decisionWithConsents(total: number): DecisionRow {
  const consents = Array.from({ length: total }, (_, index) => ({
    schema: "decision-judgment-consent/v1",
    consentId: `consent-${index}`,
    decisionId: DECISION_ID,
    action: "accept",
    targetState: "in_effect",
    machineDigest: `sha256:${String(index).repeat(4)}`,
    actor: { kind: "agent", id: AGENT_ID },
    source: { kind: "cli" },
    consentedAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
  })) as unknown as DecisionJudgmentConsent[];
  return { ...FIXTURE_DECISIONS[0], decisionId: DECISION_ID, judgmentConsents: consents };
}

function renderDecisions(decisions: DecisionRow[]): string {
  return renderToStaticMarkup(
    createElement(DecisionsView, {
      decisions,
      tasks: FIXTURE_TASKS,
      relations: FIXTURE_RELATIONS,
      facts: FIXTURE_FACTS,
      onJudge: () => Promise.resolve({ state: "success", kind: "accept", opId: "op-w6", hint: "fixture" } as never),
      mutationFeedback: noop,
      onCheckReceipt: noop,
      relationState: "ready",
      coverageRows: [],
    }),
  );
}

describe("W6 Goal 第三项:只显示前 N 条必须显形", () => {
  beforeAll(() => setActiveLocale("en-US"));

  it("命令面板完整渲染全部条目,不再有「再显示」按钮", () => {
    const markup = renderToStaticMarkup(
      createElement(CommandPalette, {
        open: true,
        entries: paletteEntries(1_538),
        onSelect: noop,
        onClose: noop,
      }),
    );
    expect(markup.match(/>Task \d+</gu)).toHaveLength(1_538);
    expect(markup).not.toContain('data-testid="command-palette-more"');
    expect(markup).not.toContain("remaining");
  });

  it("命令面板小结果集同样没有批量按钮", () => {
    const markup = renderToStaticMarkup(
      createElement(CommandPalette, {
        open: true,
        entries: paletteEntries(7),
        onSelect: noop,
        onClose: noop,
      }),
    );
    expect(markup).not.toContain('data-testid="command-palette-more"');
    expect(markup).not.toContain("remaining");
  });

  it("任务预览抽屉的事件流完整渲染全部事件", () => {
    const markup = renderToStaticMarkup(
      createElement(TaskPreviewDrawer, {
        task: taskWithEvents(10),
        tasks: FIXTURE_TASKS,
        relations: FIXTURE_RELATIONS,
        onClose: noop,
        onOpenDetail: noop,
        onPreviewTask: noop,
      }),
    );
    expect(markup.match(/事件 \d+/gu)).toHaveLength(10);
    expect(markup).not.toContain('data-testid="task-preview-events-more"');
    expect(markup).not.toContain("remaining");
  });

  it("provider inspector 的会话段完整渲染全部会话", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderInspector, {
        instance: FIXTURE_INSTANCE as never,
        sessions: sessionDtos(12),
        onOpenSession: noop,
      }),
    );
    expect(markup.match(/session-\d+/gu)).toHaveLength(12);
    expect(markup).not.toContain('data-testid="runtime-inspector-sessions-more"');
    expect(markup).not.toContain("remaining");
  });

  it("agent/squad inspector 的相关会话段完整渲染全部会话", () => {
    const markup = renderToStaticMarkup(
      createElement(IdentityInspector, {
        selection: { type: "agent", id: AGENT_ID },
        agents: [FIXTURE_AGENT_ROW],
        squads: [FIXTURE_SQUAD_ROW],
        rows: dockRows(12),
        onSelect: noop,
        onOpenSession: noop,
      }),
    );
    expect(markup.match(/session-\d+/gu)).toHaveLength(12);
    expect(markup).not.toContain('data-testid="runtime-inspector-related-more"');
    expect(markup).not.toContain("remaining");
  });

  // 会话页右栏归会话页重构任务(task_1994d52c),此处维持原分批契约,只防静默截断。
  it("session inspector 的同伴会话段(前 8)交代剩余条数", () => {
    const rows = dockRows(13);
    const markup = renderToStaticMarkup(
      createElement(SessionInspector, {
        row: rows[0],
        rows,
        onSelectSession: noop,
        onOpenTask: noop,
        onSelectEntity: noop,
      }),
    );
    expect(markup).toContain('data-testid="runtime-inspector-siblings-more"');
    expect(markup).toContain(remaining(4));
  });

  it("canonical 判定历史完整渲染全部 consents", () => {
    const markup = renderDecisions([decisionWithConsents(20)]);
    expect(markup.match(/consent-\d+/gu)).toHaveLength(20);
    expect(markup).not.toContain('data-testid="decisions-history-more"');
    expect(markup).not.toContain("remaining");
  });

  it("判定历史不满一批时也没有批量按钮", () => {
    const markup = renderDecisions([decisionWithConsents(3)]);
    expect(markup.match(/consent-\d+/gu)).toHaveLength(3);
    expect(markup).not.toContain('data-testid="decisions-history-more"');
    expect(markup).not.toContain("remaining");
  });
});
