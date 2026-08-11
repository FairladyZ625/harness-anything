// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  REPLAY_TASK_GRAPH,
  validateTaskGraph
} from "../../../packages/kernel/src/domain/task-graph.ts";

test("G09 accepts only the complete replay/v1 node set", () => {
  assert.deepEqual(validateTaskGraph(REPLAY_TASK_GRAPH), []);
  assert.match(
    validateTaskGraph({
      ...REPLAY_TASK_GRAPH,
      nodes: REPLAY_TASK_GRAPH.nodes.slice(0, 2)
    }).map((issue) => issue.code).join(","),
    /invalid_node_set/u
  );
  assert.match(
    validateTaskGraph({
      ...REPLAY_TASK_GRAPH,
      nodes: [...REPLAY_TASK_GRAPH.nodes, { id: "extra", kind: "work" }]
    }).map((issue) => issue.code).join(","),
    /invalid_node_set/u
  );
});

test("G10 rejects a missing forward predecessor", () => {
  const issues = validateTaskGraph({
    ...REPLAY_TASK_GRAPH,
    edges: REPLAY_TASK_GRAPH.edges.filter((edge) => edge.id !== "anti-entropy-approved")
  });
  assert.match(issues.map((issue) => issue.code).join(","), /invalid_forward_path/u);
});

test("G10 rejects a second replay return edge", () => {
  const issues = validateTaskGraph({
    ...REPLAY_TASK_GRAPH,
    edges: [
      ...REPLAY_TASK_GRAPH.edges,
      { id: "second-return", from: "review", to: "implementation", on: "changes_requested", actorRole: "anti_entropy", kind: "return" }
    ]
  });
  assert.match(issues.map((issue) => issue.code).join(","), /invalid_return_edge/u);
});

test("G09 rejects edges outside the fixed replay/v1 declaration", () => {
  const issues = validateTaskGraph({
    ...REPLAY_TASK_GRAPH,
    edges: [...REPLAY_TASK_GRAPH.edges, { id: "hidden", kind: "metadata" }]
  });
  assert.match(issues.map((issue) => issue.code).join(","), /invalid_graph_shape/u);
});

test("G10 rejects forward fan-out", () => {
  const issues = validateTaskGraph({
    ...REPLAY_TASK_GRAPH,
    edges: [
      ...REPLAY_TASK_GRAPH.edges,
      { id: "fan-out", from: "implementation", to: "review", on: "submitted", actorRole: "executor", kind: "forward" }
    ]
  });
  assert.match(issues.map((issue) => issue.code).join(","), /forward_fan_out/u);
});

test("G10 rejects a cycle in the forward subgraph", () => {
  const issues = validateTaskGraph({
    ...REPLAY_TASK_GRAPH,
    edges: [
      ...REPLAY_TASK_GRAPH.edges,
      { id: "forward-cycle", from: "review", to: "implementation", on: "approved", actorRole: "anti_entropy", kind: "forward" }
    ]
  });
  assert.match(issues.map((issue) => issue.code).join(","), /forward_cycle/u);
});
