import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { CommandPalette } from "../src/renderer/components/CommandPalette";
import type { TaskRow, DecisionRow, FactRef } from "../src/renderer/model/types";

// Server-render smoke: 不需要 DOM。验证 Cmd+K 面板的分组、testid、
// 「fact 真的进索引了」这三件最重要的事在 React 首屏就立得住。
// 模型层的查找/前缀逻辑由 entitySearch.vitest.ts 单独覆盖。

const task = (id: string, extra: Partial<TaskRow> = {}): TaskRow =>
  ({ taskId: id, title: `T ${id}`, coordinationStatus: "active", module: "m", ...extra }) as unknown as TaskRow;
const decision = (id: string, extra: Partial<DecisionRow> = {}): DecisionRow =>
  ({
    decisionId: id,
    title: `D ${id}`,
    state: "active",
    question: "q",
    chosen: [],
    rejected: [],
    claims: [],
    ...extra,
  }) as unknown as DecisionRow;
const fact = (taskId: string, tail: string, text = `obs ${tail}`): FactRef =>
  ({ anchor: `${taskId}/${tail}`, taskId, category: "finding", text, at: "2026", confidence: "high" }) as unknown as FactRef;

const fixture = {
  tasks: [task("task_render"), task("task_index")],
  decisions: [
    decision("dec_graph", { title: "Expose graph" }),
    decision("dec_ancestor", { title: "Earlier projection" }),
  ],
  facts: [fact("task_render", "F-1", "renderer observed a real triadic row")],
};

function render(open: boolean) {
  return renderToString(
    createElement(CommandPalette, {
      open,
      tasks: fixture.tasks,
      decisions: fixture.decisions,
      facts: fixture.facts,
      onClose: () => undefined,
      onSelectedRef: () => undefined,
    }),
  );
}

describe("CommandPalette server-render smoke", () => {
  it("renders nothing when closed", () => {
    const html = render(false);
    expect(html).toBe("");
  });

  it("exposes the testid + input + list when open", () => {
    const html = render(true);
    expect(html).toContain('data-testid="command-palette"');
    expect(html).toContain('data-testid="command-palette-input"');
    expect(html).toContain('data-testid="command-palette-list"');
  });

  it("indexes all three primitives and groups them by kind on first paint", () => {
    const html = render(true);
    // Decision group header
    expect(html).toContain("Decision");
    // Task group header
    expect(html).toContain("Task");
    // Fact group header + the actual fact text
    expect(html).toContain("Fact");
    expect(html).toContain("renderer observed a real triadic row");
    // All expected entities are present
    expect(html).toContain("Expose graph");
    expect(html).toContain("Earlier projection");
    expect(html).toContain("T task_render");
    expect(html).toContain("T task_index");
  });

  it("tags each item with its entity kind for downstream tests", () => {
    const html = render(true);
    expect(html).toContain('data-hit-kind="decision"');
    expect(html).toContain('data-hit-kind="task"');
    expect(html).toContain('data-hit-kind="fact"');
  });

  it("caps items per kind (decision first, task/fact capped at 12)", () => {
    const manyTasks = Array.from({ length: 20 }, (_, i) => task(`t_${i}`));
    const html = renderToString(
      createElement(CommandPalette, {
        open: true,
        tasks: manyTasks,
        decisions: fixture.decisions,
        facts: fixture.facts,
        onClose: () => undefined,
        onSelectedRef: () => undefined,
      }),
    );
    // 12 task items max — count data-testid="command-palette-item" occurrences.
    const matches = html.match(/data-testid="command-palette-item"/g) ?? [];
    // 2 decisions + 12 tasks + 1 fact = 15
    expect(matches.length).toBe(15);
  });
});
