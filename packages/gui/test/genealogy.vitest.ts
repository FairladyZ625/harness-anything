// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { DecisionRow, RelationEdge } from "../src/renderer/model/types.ts";
import {
  buildGenealogyEdges,
  collectLineage,
  computeLayout,
  dayKeyOf,
  decisionIdOf,
  findGenealogyCycles,
  timeMsOf,
} from "../src/renderer/graph/genealogy.ts";

function dec(overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    decisionId: "dec_a",
    title: "A",
    state: "active",
    question: "Q?",
    chosen: [],
    rejected: [],
    claims: [],
    proposedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  } as DecisionRow;
}

function edge(from: string, to: string, kind: RelationEdge["kind"]): RelationEdge {
  return { from, to, kind, provenance: "local-document" };
}

describe("genealogy edge building", () => {
  it("keeps only decision↔decision refines/narrows/supersedes/supports edges", () => {
    const byId = new Map([
      ["dec_a", dec()],
      ["dec_b", dec({ decisionId: "dec_b" })],
      ["dec_c", dec({ decisionId: "dec_c" })],
    ]);
    const relations = [
      edge("decision/dec_a", "decision/dec_b", "refines"),
      edge("decision/dec_a", "decision/dec_c", "supports"),
      edge("decision/dec_a", "task/task_x", "derives"),
      edge("decision/dec_a/CH1", "fact/task_x/F-1", "evidenced-by"),
    ];
    const geo = buildGenealogyEdges(relations, byId);
    expect(geo).toHaveLength(2);
    expect(geo.map((e) => e.kind).sort()).toEqual(["refines", "supports"]);
  });

  it("drops edges whose endpoints are not in the decision map", () => {
    const byId = new Map([["dec_a", dec()]]);
    const relations = [edge("decision/dec_a", "decision/dec_ghost", "refines")];
    expect(buildGenealogyEdges(relations, byId)).toHaveLength(0);
  });

  it("deduplicates same from/to/kind triples", () => {
    const byId = new Map([
      ["dec_a", dec()],
      ["dec_b", dec({ decisionId: "dec_b" })],
    ]);
    const relations = [
      edge("decision/dec_a", "decision/dec_b", "refines"),
      edge("decision/dec_a", "decision/dec_b", "refines"),
    ];
    expect(buildGenealogyEdges(relations, byId)).toHaveLength(1);
  });
});

describe("genealogy lineage traversal", () => {
  it("assigns depth 0 to focus, +1 to descendants, -1 to ancestors (canonical direction)", () => {
    // Canonical: source <verb> target. source=refiner=descendant, target=refined=ancestor.
    // dec_focus refines dec_root → dec_root is ancestor (depth -1).
    // dec_child supersedes dec_focus → dec_child is descendant (depth +1).
    const byId = new Map([
      ["dec_root", dec({ decisionId: "dec_root" })],
      ["dec_focus", dec({ decisionId: "dec_focus" })],
      ["dec_child", dec({ decisionId: "dec_child" })],
    ]);
    const relations = [
      edge("decision/dec_focus", "decision/dec_root", "refines"),
      edge("decision/dec_child", "decision/dec_focus", "supersedes"),
    ];
    const geo = buildGenealogyEdges(relations, byId);
    const depth = collectLineage("dec_focus", geo);
    expect(depth.get("dec_focus")).toBe(0);
    expect(depth.get("dec_root")).toBe(-1);
    expect(depth.get("dec_child")).toBe(1);
  });
});

describe("genealogy cycle detection", () => {
  it("detects a cycle among genealogy edges", () => {
    const byId = new Map([
      ["dec_a", dec()],
      ["dec_b", dec({ decisionId: "dec_b" })],
      ["dec_c", dec({ decisionId: "dec_c" })],
    ]);
    const relations = [
      edge("decision/dec_a", "decision/dec_b", "refines"),
      edge("decision/dec_b", "decision/dec_c", "refines"),
      edge("decision/dec_c", "decision/dec_a", "refines"),
    ];
    const geo = buildGenealogyEdges(relations, byId);
    const cycles = findGenealogyCycles(geo);
    expect(cycles.length).toBeGreaterThanOrEqual(1);
  });

  it("returns no cycles for a clean DAG", () => {
    const byId = new Map([
      ["dec_a", dec()],
      ["dec_b", dec({ decisionId: "dec_b" })],
    ]);
    const relations = [edge("decision/dec_a", "decision/dec_b", "refines")];
    const geo = buildGenealogyEdges(relations, byId);
    expect(findGenealogyCycles(geo)).toHaveLength(0);
  });
});

describe("genealogy layout", () => {
  it("returns EMPTY_LAYOUT for null focus", () => {
    const layout = computeLayout(null, [], new Map(), 900);
    expect(layout.nodes).toHaveLength(0);
  });

  it("places focus at center for an isolated decision", () => {
    const focus = dec();
    const byId = new Map([["dec_a", focus]]);
    const layout = computeLayout(focus, [], byId, 900);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]!.id).toBe("dec_a");
  });

  it("arranges a 3-generation lineage into 3 rank columns", () => {
    // Canonical: focus refines root (root=ancestor); child supersedes focus (child=descendant).
    const byId = new Map([
      ["dec_root", dec({ decisionId: "dec_root", title: "Root" })],
      ["dec_focus", dec({ decisionId: "dec_focus", title: "Focus" })],
      ["dec_child", dec({ decisionId: "dec_child", title: "Child" })],
    ]);
    const relations = [
      edge("decision/dec_focus", "decision/dec_root", "refines"),
      edge("decision/dec_child", "decision/dec_focus", "supersedes"),
    ];
    const geo = buildGenealogyEdges(relations, byId);
    const layout = computeLayout(byId.get("dec_focus")!, geo, byId, 900);
    expect(layout.nodes).toHaveLength(3);
    expect(layout.ticks).toHaveLength(3);
  });

  it("folds same-day nodes in a column into a cluster", () => {
    const day = "2026-08-01T00:00:00.000Z";
    const byId = new Map([
      ["dec_focus", dec({ decisionId: "dec_focus" })],
      ["dec_c1", dec({ decisionId: "dec_c1", proposedAt: day })],
      ["dec_c2", dec({ decisionId: "dec_c2", proposedAt: day })],
    ]);
    // c1/c2 both refine focus → both are ancestors of focus (same rank).
    const relations = [
      edge("decision/dec_focus", "decision/dec_c1", "refines"),
      edge("decision/dec_focus", "decision/dec_c2", "refines"),
    ];
    const geo = buildGenealogyEdges(relations, byId);
    const layout = computeLayout(byId.get("dec_focus")!, geo, byId, 900);
    const clusters = layout.nodes.filter((n) => n.isCluster);
    expect(clusters.length).toBe(1);
    expect(clusters[0]!.clusterSize).toBe(2);
    // Expand the cluster.
    const expanded = computeLayout(byId.get("dec_focus")!, geo, byId, 900, {
      expandedDays: new Set([clusters[0]!.dayKey!]),
    });
    expect(expanded.nodes.filter((n) => n.isCluster)).toHaveLength(0);
  });
});

describe("genealogy time helpers", () => {
  it("decisionIdOf extracts id from decision/<id>/claim ref", () => {
    expect(decisionIdOf("decision/dec_x")).toBe("dec_x");
    expect(decisionIdOf("decision/dec_x/CH1")).toBe("dec_x");
    expect(decisionIdOf("task/task_x")).toBeNull();
  });

  it("timeMsOf returns null when no timestamps", () => {
    expect(timeMsOf(dec({ proposedAt: undefined, decidedAt: undefined } as any))).toBeNull();
    expect(timeMsOf(dec({ proposedAt: "2026-08-01T00:00:00.000Z" }))).toBeGreaterThan(0);
  });

  it("dayKeyOf slices the date portion", () => {
    expect(dayKeyOf(dec({ proposedAt: "2026-08-13T10:00:00Z" }))).toBe("2026-08-13");
    expect(dayKeyOf(dec({ proposedAt: undefined } as any))).toBe("NO_TIME");
  });
});
