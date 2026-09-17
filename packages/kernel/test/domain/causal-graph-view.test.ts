// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { buildCausalGraphView, type CausalGraphEdgeInput } from "../../src/domain/causal-graph-view.ts";

const edge = (
  partial: Partial<CausalGraphEdgeInput> &
    Pick<CausalGraphEdgeInput, "relationId" | "sourceRef" | "targetRef" | "relationType">,
): CausalGraphEdgeInput => ({
  direction: "directed",
  state: "active",
  freshness: "current",
  ...partial,
});

const nodes = {
  "task/task_root": { label: "Root", state: "active", detail: null },
  "decision/dec_1": { label: "Pick postgres", state: "in_effect", detail: null },
  "fact/F-1": { label: "pg supports jsonb", state: "current", detail: null },
  "task/task_child": { label: "Child", state: "planned", detail: null },
};

test("causal graph view walks relation edges in both directions and keeps real direction", () => {
  const view = buildCausalGraphView({
    rootRef: "task/task_root",
    depth: 3,
    edges: [
      edge({ relationId: "rel_1", sourceRef: "decision/dec_1", targetRef: "task/task_root", relationType: "derives" }),
      edge({ relationId: "rel_2", sourceRef: "decision/dec_1", targetRef: "fact/F-1", relationType: "evidenced-by" }),
    ],
    structuralChildren: {},
    structuralParents: {},
    nodes,
    frontierTruncated: false,
  });
  assert.equal(view.root.ref, "task/task_root");
  const decision = view.root.children[0]!;
  assert.equal(decision.ref, "decision/dec_1");
  assert.equal(decision.viaEdge?.traversal, "upstream");
  assert.equal(decision.viaEdge?.sourceRef, "decision/dec_1");
  assert.equal(decision.viaEdge?.targetRef, "task/task_root");
  const fact = decision.children.find((child) => child.ref === "fact/F-1")!;
  assert.equal(fact.ref, "fact/F-1");
  assert.equal(fact.viaEdge?.traversal, "downstream");
  assert.equal(fact.label, "pg supports jsonb");
  // The task reoccurs under the decision as a cycle marker, not a silent omission.
  const cycle = decision.children.find((child) => child.ref === "task/task_root");
  assert.equal(cycle?.cycle, true);
});

test("task parent/child links render as structural edges", () => {
  const view = buildCausalGraphView({
    rootRef: "task/task_root",
    depth: 3,
    edges: [],
    structuralChildren: { "task/task_root": [{ ref: "task/task_child", type: "child" }] },
    structuralParents: { "task/task_child": { ref: "task/task_root", type: "child" } },
    nodes,
    frontierTruncated: false,
  });
  const child = view.root.children[0]!;
  assert.equal(child.viaEdge?.relationType, "child");
  assert.equal(child.viaEdge?.traversal, "structural");
  const parent = child.children[0]!;
  assert.equal(parent.viaEdge?.relationType, "child");
  assert.equal(parent.viaEdge?.traversal, "upstream");
  assert.equal(parent.cycle, true);
});

test("depth bound truncates frontier nodes instead of hiding them", () => {
  const view = buildCausalGraphView({
    rootRef: "task/task_root",
    depth: 1,
    edges: [
      edge({ relationId: "rel_1", sourceRef: "task/task_root", targetRef: "decision/dec_1", relationType: "relates" }),
      edge({ relationId: "rel_2", sourceRef: "decision/dec_1", targetRef: "fact/F-1", relationType: "evidenced-by" }),
    ],
    structuralChildren: {},
    structuralParents: {},
    nodes,
    frontierTruncated: true,
  });
  const decision = view.root.children[0]!;
  assert.equal(decision.depth, 1);
  assert.equal(decision.children.length, 0);
  assert.equal(decision.truncated, true);
  assert.equal(view.stats.truncated >= 1, true);
});

test("duplicate reachability marks repeats rather than re-expanding", () => {
  const view = buildCausalGraphView({
    rootRef: "task/task_root",
    depth: 4,
    edges: [
      edge({ relationId: "rel_1", sourceRef: "task/task_root", targetRef: "decision/dec_1", relationType: "relates" }),
      edge({ relationId: "rel_2", sourceRef: "task/task_root", targetRef: "task/task_child", relationType: "relates" }),
      edge({ relationId: "rel_3", sourceRef: "decision/dec_1", targetRef: "task/task_child", relationType: "derives" }),
    ],
    structuralChildren: {},
    structuralParents: {},
    nodes,
    frontierTruncated: false,
  });
  const first = view.root.children[0]!, // decision/dec_1 expands first (alphabetical ref order)
    directChild = view.root.children[1]!;
  assert.equal(directChild.ref, "task/task_child");
  const viaDecision = first.children.find((child) => child.ref === "task/task_child");
  // First occurrence expands; the second occurrence is a marked repeat, not a re-expansion.
  assert.equal(viaDecision !== undefined && viaDecision.repeated === false, true);
  assert.equal(directChild.repeated, true);
});
