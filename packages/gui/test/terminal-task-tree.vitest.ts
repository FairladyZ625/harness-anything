// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import {
  buildTaskTreeIndex,
  taskAncestors,
  taskTreeRowLimit,
  taskTreeRows,
  type TaskTreeNode,
} from "../src/renderer/components/terminal/task-tree.ts";

const NOW = Date.parse("2026-09-02T00:00:00Z");
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const nodes: TaskTreeNode[] = [
  { taskId: "root-a", title: "Ontology milestone", status: "active", createdAt: day(40) },
  { taskId: "a1", title: "Ontology phase 1", parentTaskId: "root-a", status: "done", createdAt: day(30) },
  { taskId: "a1x", title: "Write ontology schema", parentTaskId: "a1", status: "done", createdAt: day(20) },
  { taskId: "a1y", title: "Unrelated chore", parentTaskId: "a1", status: "planned", createdAt: day(2) },
  { taskId: "a2", title: "Terminal workspace", parentTaskId: "root-a", status: "active", createdAt: day(5) },
  { taskId: "root-b", title: "Billing", status: "planned", createdAt: day(1) },
  { taskId: "orphan", title: "Ontology orphan", parentTaskId: "missing-parent", status: "blocked", createdAt: day(3) },
];
const none = { query: "", statuses: null, createdWithinDays: null } as const;
const ids = (rows: readonly { node: TaskTreeNode }[]) => rows.map((row) => row.node.taskId);

describe("task tree picker logic", () => {
  it("builds a closed forest: unknown parents become roots and ancestors walk up to the root", () => {
    const index = buildTaskTreeIndex(nodes);
    expect(index.roots).toEqual(["root-a", "root-b", "orphan"]);
    expect(taskAncestors(index, "a1x").map((node) => node.taskId)).toEqual(["a1", "root-a"]);
  });

  it("browses collapsed roots by default and shows all children of an explicitly expanded node", () => {
    const index = buildTaskTreeIndex(nodes);
    expect(ids(taskTreeRows(index, none, null, new Map(), NOW).rows)).toEqual(["root-a", "root-b", "orphan"]);
    const rows = taskTreeRows(index, none, null, new Map([["root-a", true]]), NOW).rows;
    expect(ids(rows)).toEqual(["root-a", "a1", "a2", "root-b", "orphan"]);
    expect(rows[0]).toMatchObject({ expanded: true, childCount: 2, hit: false, depth: 0 });
    expect(rows[1].depth).toBe(1);
  });

  it("keeps search hits in their tree with the ancestor chain as context and hides unrelated siblings", () => {
    const index = buildTaskTreeIndex(nodes);
    const result = taskTreeRows(index, { ...none, query: "ontology" }, null, new Map(), NOW);
    expect(ids(result.rows)).toEqual(["root-a", "a1", "a1x", "orphan"]);
    expect(result.rows.map((row) => row.hit)).toEqual([true, true, true, true]);
    expect(result.hits).toBe(4);
    // "schema" hits only the leaf: root-a and a1 stay as dimmed context, a1y/a2 are hidden.
    const leaf = taskTreeRows(index, { ...none, query: "schema" }, null, new Map(), NOW);
    expect(leaf.rows.map((row) => [row.node.taskId, row.hit])).toEqual([
      ["root-a", false],
      ["a1", false],
      ["a1x", true],
    ]);
    // Expanding a context node shows all of its children, hit or not.
    const opened = taskTreeRows(index, { ...none, query: "schema" }, null, new Map([["a1", true]]), NOW);
    expect(ids(opened.rows)).toEqual(["root-a", "a1", "a1x", "a1y"]);
    // Collapsing a context node hides the hit underneath it.
    const closed = taskTreeRows(index, { ...none, query: "schema" }, null, new Map([["a1", false]]), NOW);
    expect(ids(closed.rows)).toEqual(["root-a", "a1"]);
  });

  it("scopes search to the focused subtree", () => {
    const index = buildTaskTreeIndex(nodes);
    const result = taskTreeRows(index, { ...none, query: "ontology" }, "a1", new Map(), NOW);
    expect(ids(result.rows)).toEqual(["a1", "a1x"]);
    expect(result.rows[0].depth).toBe(0);
    expect(ids(taskTreeRows(index, none, "a1", new Map(), NOW).rows)).toEqual(["a1"]);
  });

  it("filters by status and creation window", () => {
    const index = buildTaskTreeIndex(nodes);
    const planned = taskTreeRows(index, { ...none, statuses: new Set(["planned"]) }, null, new Map(), NOW);
    expect(planned.rows.filter((row) => row.hit).map((row) => row.node.taskId)).toEqual(["a1y", "root-b"]);
    const recent = taskTreeRows(index, { ...none, createdWithinDays: 7 }, null, new Map(), NOW);
    expect(recent.rows.filter((row) => row.hit).map((row) => row.node.taskId)).toEqual([
      "a1y",
      "a2",
      "root-b",
      "orphan",
    ]);
  });

  it("truncates at the row limit so thousands of tasks never enter the DOM", () => {
    const many = Array.from({ length: taskTreeRowLimit + 50 }, (_, i) => ({ taskId: `t${i}`, title: `Task ${i}` }));
    const result = taskTreeRows(buildTaskTreeIndex(many), none, null, new Map(), NOW);
    expect(result.rows).toHaveLength(taskTreeRowLimit);
    expect(result.truncated).toBe(true);
  });
});
