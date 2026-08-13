// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  REPLAY_TASK_GRAPH,
  graphActorRoles,
  graphEdgeTriggers,
  taskNodeIds,
  validateTaskGraph
} from "../../../packages/kernel/src/domain/task-graph.ts";

test("G09 fixes the complete replay/v1 node set and order", () => {
  assert.deepEqual(validateTaskGraph(REPLAY_TASK_GRAPH), []);
  const invalidNodeSets = [
    [],
    REPLAY_TASK_GRAPH.nodes.slice(0, 1),
    REPLAY_TASK_GRAPH.nodes.slice(1),
    [...REPLAY_TASK_GRAPH.nodes].reverse(),
    [{ id: "implementation", kind: "review" }, REPLAY_TASK_GRAPH.nodes[1]],
    [REPLAY_TASK_GRAPH.nodes[0], { id: "review", kind: "work" }],
    [...REPLAY_TASK_GRAPH.nodes, { id: "extra", kind: "work" }]
  ];
  for (const nodes of invalidNodeSets) {
    assert.match(validateTaskGraph({ ...REPLAY_TASK_GRAPH, nodes }).map((issue) => issue.code).join(","), /invalid_node_set/u);
  }
});

test("G10 requires both canonical predecessors and rejects every other edge tuple", () => {
  for (const required of REPLAY_TASK_GRAPH.edges) {
    assert.notDeepEqual(validateTaskGraph({ ...REPLAY_TASK_GRAPH, edges: REPLAY_TASK_GRAPH.edges.filter((edge) => edge.id !== required.id) }), [], required.id);
  }

  const kinds = ["forward", "return"];
  let rejected = 0;
  for (const kind of kinds) for (const from of taskNodeIds) for (const to of taskNodeIds) for (const on of graphEdgeTriggers) for (const actorRole of graphActorRoles) {
    const expected = REPLAY_TASK_GRAPH.edges.find((edge) => edge.kind === kind);
    const candidate = { id: `candidate-${kind}-${from}-${to}-${on}-${actorRole}`, kind, from, to, on, actorRole };
    if (expected && [kind, from, to, on, actorRole].every((value, index) => value === [expected.kind, expected.from, expected.to, expected.on, expected.actorRole][index])) continue;
    const companion = REPLAY_TASK_GRAPH.edges.find((edge) => edge.kind !== kind);
    assert.notDeepEqual(validateTaskGraph({ ...REPLAY_TASK_GRAPH, edges: companion ? [candidate, companion] : [candidate] }), [], candidate.id);
    rejected += 1;
  }
  assert.equal(rejected, 30);

  for (const edge of REPLAY_TASK_GRAPH.edges) {
    assert.notDeepEqual(validateTaskGraph({ ...REPLAY_TASK_GRAPH, edges: REPLAY_TASK_GRAPH.edges.map((value) => value === edge ? { ...value, id: `renamed-${value.id}` } : value) }), [], edge.id);
  }
});

test("G09 rejects undeclared edge shapes, duplicates, fan-out, and forward cycles", () => {
  const fixtures = [
    [...REPLAY_TASK_GRAPH.edges, { id: "hidden", kind: "metadata" }],
    [...REPLAY_TASK_GRAPH.edges, REPLAY_TASK_GRAPH.edges[0]],
    [...REPLAY_TASK_GRAPH.edges, { id: "fan-out", from: "implementation", to: "review", on: "submitted", actorRole: "executor", kind: "forward" }],
    [...REPLAY_TASK_GRAPH.edges, { id: "forward-cycle", from: "review", to: "implementation", on: "changes_requested", actorRole: "reviewer", kind: "forward" }],
    [...REPLAY_TASK_GRAPH.edges, { id: "second-return", from: "review", to: "implementation", on: "changes_requested", actorRole: "reviewer", kind: "return" }]
  ];
  for (const edges of fixtures) assert.notDeepEqual(validateTaskGraph({ ...REPLAY_TASK_GRAPH, edges }), []);
});
