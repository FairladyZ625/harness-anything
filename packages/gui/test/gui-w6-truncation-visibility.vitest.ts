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
  IdentityInspector, ProviderInspector, SessionInspector
} from "../src/renderer/components/runtime/RuntimeInspector.tsx";
import { DecisionsView } from "../src/renderer/views/DecisionsView.tsx";
import type { DecisionJudgmentConsent, DecisionRow, EventEntry, TaskRow } from "../src/renderer/model/types.ts";
import type { RuntimeDockRow } from "../src/renderer/runtime-panorama.ts";
import type { AgentRuntimeSessionDto } from "../../daemon/src/agent-runtime-contract.ts";
import {
  AGENT_ID, DECISION_ID, FIXTURE_AGENT_ROW, FIXTURE_DECISIONS, FIXTURE_DOCK_ROW, FIXTURE_FACTS,
  FIXTURE_INSTANCE, FIXTURE_RELATIONS, FIXTURE_SESSION_DTO, FIXTURE_SQUAD_ROW, FIXTURE_TASKS,
  TASK_A_ID, fixtureTaskRow
} from "./entityIdGateFixtures.ts";

/**
 * W6 Goal 第三个合取项(`task_be076d3ac25b87b79be09b02dd`):
 * **任何「只显示前 N 条」都必须在界面上显形**(原句:"事件流不再有静默的条数截断")。
 *
 * W6 验收只量了 DOM 条数,这一句从未被验证。复核确认的六个静默截断站点各占一条断言:
 * 命令面板 50、任务预览抽屉的事件流 4、三个 runtime inspector 各 8、判定历史 12。
 * 显形做法照抄 BoardView/DecisionPoolView/SwimlaneBoard 的批量按钮:
 * "再显示 {count} 条 · 还有 {remaining} 条"。删掉任何一处提示,对应断言立刻红。
 */

const noop = () => undefined;

/** en-US 目录里 showMore 家族的尾巴,断言只认这一段,不绑定整句排版。 */
const remaining = (count: number) => `${count} remaining`;

function paletteEntries(total: number): PaletteEntry[] {
  return Array.from({ length: total }, (_, index) => ({
    ref: `task/task_${String(index).padStart(6, "0")}`, label: `Task ${index}`, entity: "task" as const
  }));
}

function taskWithEvents(total: number): TaskRow {
  const events: EventEntry[] = Array.from({ length: total }, (_, index) => ({
    at: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    projectId: "repo-g10", taskId: TASK_A_ID, summary: `事件 ${index}`
  }));
  return { ...fixtureTaskRow(TASK_A_ID, "W6 截断显形"), events };
}

function dockRows(total: number): RuntimeDockRow[] {
  return Array.from({ length: total }, (_, index) => ({
    ...FIXTURE_DOCK_ROW, runtimeSessionId: `session-${index}`, dispatchId: `dispatch-${index}`, agentId: AGENT_ID
  }));
}

function sessionDtos(total: number): AgentRuntimeSessionDto[] {
  return Array.from({ length: total }, (_, index) => ({
    ...FIXTURE_SESSION_DTO, runtimeSessionId: `session-${index}`
  }));
}

function decisionWithConsents(total: number): DecisionRow {
  const consents = Array.from({ length: total }, (_, index) => ({
    schema: "decision-judgment-consent/v1", consentId: `consent-${index}`, decisionId: DECISION_ID,
    action: "accept", targetState: "in_effect", machineDigest: `sha256:${String(index).repeat(4)}`,
    actor: { kind: "agent", id: AGENT_ID }, source: { kind: "cli" },
    consentedAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`
  })) as unknown as DecisionJudgmentConsent[];
  return { ...FIXTURE_DECISIONS[0], decisionId: DECISION_ID, judgmentConsents: consents };
}

function renderDecisions(decisions: DecisionRow[]): string {
  return renderToStaticMarkup(createElement(DecisionsView, {
    decisions, tasks: FIXTURE_TASKS, relations: FIXTURE_RELATIONS, facts: FIXTURE_FACTS,
    onJudge: () => Promise.resolve({ state: "success", kind: "accept", opId: "op-w6", hint: "fixture" } as never),
    mutationFeedback: noop, onCheckReceipt: noop, relationState: "ready", coverageRows: []
  }));
}

describe("W6 Goal 第三项:只显示前 N 条必须显形", () => {
  beforeAll(() => setActiveLocale("en-US"));

  it("命令面板(前 50)交代剩余条数", () => {
    const markup = renderToStaticMarkup(createElement(CommandPalette, {
      open: true, entries: paletteEntries(1_538), onSelect: noop, onClose: noop
    }));
    expect(markup).toContain('data-testid="command-palette-more"');
    expect(markup).toContain(remaining(1_488));
  });

  it("命令面板没有被截断时不显示批量按钮", () => {
    const markup = renderToStaticMarkup(createElement(CommandPalette, {
      open: true, entries: paletteEntries(7), onSelect: noop, onClose: noop
    }));
    expect(markup).not.toContain('data-testid="command-palette-more"');
    expect(markup).not.toContain("remaining");
  });

  it("任务预览抽屉的事件流(前 4)交代剩余条数", () => {
    const markup = renderToStaticMarkup(createElement(TaskPreviewDrawer, {
      task: taskWithEvents(10), tasks: FIXTURE_TASKS, relations: FIXTURE_RELATIONS,
      onClose: noop, onOpenDetail: noop, onPreviewTask: noop
    }));
    expect(markup).toContain('data-testid="task-preview-events-more"');
    expect(markup).toContain(remaining(6));
  });

  it("provider inspector 的会话段(前 8)交代剩余条数", () => {
    const markup = renderToStaticMarkup(createElement(ProviderInspector, {
      instance: FIXTURE_INSTANCE as never, probeError: null, sessions: sessionDtos(12), onOpenSession: noop
    }));
    expect(markup).toContain('data-testid="runtime-inspector-sessions-more"');
    expect(markup).toContain(remaining(4));
  });

  it("agent/squad inspector 的相关会话段(前 8)交代剩余条数", () => {
    const markup = renderToStaticMarkup(createElement(IdentityInspector, {
      selection: { type: "agent", id: AGENT_ID }, agents: [FIXTURE_AGENT_ROW], squads: [FIXTURE_SQUAD_ROW],
      rows: dockRows(12), onSelect: noop, onOpenSession: noop
    }));
    expect(markup).toContain('data-testid="runtime-inspector-related-more"');
    expect(markup).toContain(remaining(4));
  });

  it("session inspector 的同伴会话段(前 8)交代剩余条数", () => {
    const rows = dockRows(13);
    const markup = renderToStaticMarkup(createElement(SessionInspector, {
      row: rows[0], rows, onSelectSession: noop, onOpenTask: noop, onSelectEntity: noop
    }));
    expect(markup).toContain('data-testid="runtime-inspector-siblings-more"');
    expect(markup).toContain(remaining(4));
  });

  it("canonical 判定历史(前 12)交代剩余条数", () => {
    const markup = renderDecisions([decisionWithConsents(20)]);
    expect(markup).toContain('data-testid="decisions-history-more"');
    expect(markup).toContain(remaining(8));
  });

  it("判定历史不到 12 条时不显示批量按钮", () => {
    const markup = renderDecisions([decisionWithConsents(3)]);
    expect(markup).not.toContain('data-testid="decisions-history-more"');
    expect(markup).not.toContain("remaining");
  });
});
