import { describe, it, expect } from "vitest";
import {
  buildEntityIndex,
  parseQuery,
  searchEntities,
  selectSuggestedHits,
  groupHitsByKind,
} from "../src/renderer/model/entitySearch";
import type { TaskRow, DecisionRow, FactRef } from "../src/renderer/model/types";

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

describe("buildEntityIndex", () => {
  it("indexes all three primitives with navRef-shaped refs", () => {
    const hits = buildEntityIndex({
      tasks: [task("t1")],
      decisions: [decision("d1")],
      facts: [fact("t1", "F-abc")],
    });
    const refs = hits.map((h) => h.ref).sort();
    expect(refs).toEqual(["decision/d1", "fact/t1/F-abc", "task/t1"]);
  });

  it("decisions sort ahead of tasks, tasks ahead of facts", () => {
    const hits = buildEntityIndex({
      tasks: [task("t1")],
      decisions: [decision("d1")],
      facts: [fact("t1", "F-abc")],
    });
    expect(hits.map((h) => h.kind)).toEqual(["decision", "task", "fact"]);
  });
});

describe("parseQuery", () => {
  it("returns null kind + empty text for blank input", () => {
    expect(parseQuery("")).toEqual({ kind: null, text: "" });
    expect(parseQuery("   ")).toEqual({ kind: null, text: "" });
  });

  it("parses single-letter prefixes", () => {
    expect(parseQuery("d:foo")).toEqual({ kind: "decision", text: "foo" });
    expect(parseQuery("t:foo")).toEqual({ kind: "task", text: "foo" });
    expect(parseQuery("f:foo")).toEqual({ kind: "fact", text: "foo" });
  });

  it("parses navRef-style prefixes (decision/ etc.)", () => {
    expect(parseQuery("decision/dec_abc")).toEqual({ kind: "decision", text: "dec_abc" });
    expect(parseQuery("task/task_x")).toEqual({ kind: "task", text: "task_x" });
    expect(parseQuery("fact/task_x/F-1")).toEqual({ kind: "fact", text: "task_x/f-1" });
  });

  it("treats un-prefixed text as a plain substring", () => {
    expect(parseQuery("graphql")).toEqual({ kind: null, text: "graphql" });
  });
});

describe("searchEntities", () => {
  const hits = buildEntityIndex({
    tasks: [task("task_render"), task("task_index")],
    decisions: [decision("dec_graph", { title: "Expose graph" })],
    facts: [fact("task_render", "F-1", "render observed")],
  });

  it("returns everything when query is empty", () => {
    expect(searchEntities(hits, "").length).toBe(hits.length);
  });

  it("kind prefix narrows to one primitive only", () => {
    const out = searchEntities(hits, "t:");
    expect(out.every((h) => h.kind === "task")).toBe(true);
    expect(out.length).toBe(2);
  });

  it("substring matches across title/id/subtitle, AND over terms", () => {
    const out = searchEntities(hits, "render");
    expect(out.map((h) => h.id).sort()).toEqual(["F-1", "task_render"]);
  });

  it("prefix + substring combine", () => {
    const out = searchEntities(hits, "f:render");
    expect(out.map((h) => h.id)).toEqual(["F-1"]);
  });

  it("does not match fact text without f: prefix when only task/decision share the term", () => {
    const out = searchEntities(hits, "graph");
    expect(out.map((h) => h.kind)).toEqual(["decision"]);
  });
});

describe("groupHitsByKind", () => {
  it("partitions by kind, preserving weight order", () => {
    const hits = buildEntityIndex({
      tasks: [task("t1")],
      decisions: [decision("d1")],
      facts: [fact("t1", "F-1")],
    });
    const grouped = groupHitsByKind(hits);
    expect(grouped.decision.map((h) => h.id)).toEqual(["d1"]);
    expect(grouped.task.map((h) => h.id)).toEqual(["t1"]);
    expect(grouped.fact.map((h) => h.id)).toEqual(["F-1"]);
  });
});

describe("selectSuggestedHits", () => {
  it("returns weight-sorted top N (decisions first, then tasks, then facts)", () => {
    const hits = buildEntityIndex({
      tasks: [task("t1"), task("t2")],
      decisions: [decision("d1")],
      facts: [fact("t1", "F-1")],
    });
    // buildEntityIndex sorts decision > task > fact by weight.
    const top = selectSuggestedHits(hits, 2);
    expect(top.map((h) => h.kind)).toEqual(["decision", "task"]);
  });

  it("defaults to 8 and clamps when fewer available", () => {
    const hits = buildEntityIndex({
      tasks: [task("t1")],
      decisions: [],
      facts: [],
    });
    expect(selectSuggestedHits(hits).length).toBe(1);
    // n <= 0 returns empty without throwing.
    expect(selectSuggestedHits(hits, 0)).toEqual([]);
  });

  it("does not mutate or re-slice the source index", () => {
    const hits = buildEntityIndex({
      tasks: [task("t1"), task("t2"), task("t3")],
      decisions: [],
      facts: [],
    });
    const before = hits.map((h) => h.id);
    selectSuggestedHits(hits, 1);
    expect(hits.map((h) => h.id)).toEqual(before);
  });
});
