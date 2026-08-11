export const taskNodeIds = ["implementation", "anti_entropy", "review"] as const;
export type TaskNodeId = (typeof taskNodeIds)[number];

export const graphEdgeTriggers = ["submitted", "approved", "changes_requested"] as const;
export type GraphEdgeTrigger = (typeof graphEdgeTriggers)[number];

export const graphActorRoles = ["executor", "anti_entropy"] as const;
export type GraphActorRole = (typeof graphActorRoles)[number];

export interface GraphEdgeDefinition { readonly id: string; readonly from: TaskNodeId; readonly to: TaskNodeId; readonly on: GraphEdgeTrigger; readonly actorRole: GraphActorRole; readonly kind: "forward" | "return" }
export interface TaskGraphV1 {
  readonly template: "replay/v1";
  readonly nodes: readonly [{ readonly id: "implementation"; readonly kind: "work" }, { readonly id: "anti_entropy"; readonly kind: "adversarial" }, { readonly id: "review"; readonly kind: "review" }];
  readonly edges: readonly GraphEdgeDefinition[];
  readonly maxIterations: 1;
}
export interface TaskEdgeTaken { readonly edgeId: string; readonly from: TaskNodeId; readonly to: TaskNodeId; readonly on: GraphEdgeTrigger; readonly actorRole: GraphActorRole; readonly reason: string; readonly commitSha: string; readonly iteration: number }
export interface GraphValidationIssue { readonly code: "invalid_node_set" | "invalid_graph_shape" | "invalid_return_edge" | "invalid_forward_path" | "forward_fan_out" | "forward_cycle"; readonly message: string }
export const REPLAY_TASK_GRAPH: TaskGraphV1 = Object.freeze({
  template: "replay/v1",
  nodes: Object.freeze([
    Object.freeze({ id: "implementation", kind: "work" }), Object.freeze({ id: "anti_entropy", kind: "adversarial" }), Object.freeze({ id: "review", kind: "review" })
  ] as const),
  edges: Object.freeze([
    Object.freeze({ id: "implementation-submitted", from: "implementation", to: "anti_entropy", on: "submitted", actorRole: "executor", kind: "forward" }),
    Object.freeze({ id: "anti-entropy-approved", from: "anti_entropy", to: "review", on: "approved", actorRole: "anti_entropy", kind: "forward" }),
    Object.freeze({ id: "anti-entropy-changes-requested", from: "anti_entropy", to: "implementation", on: "changes_requested", actorRole: "anti_entropy", kind: "return" })
  ]),
  maxIterations: 1
});
export const TASK_GRAPH_V1_SCHEMA = Object.freeze({ id: "TaskGraph/v1", template: "replay/v1", nodes: taskNodeIds, maxIterations: 1 });
export const TASK_EDGE_TAKEN_SCHEMA = Object.freeze({ id: "TaskEdgeTaken/v1", required: Object.freeze(["edgeId", "from", "to", "on", "actorRole", "reason", "commitSha", "iteration"]) });
export function validateTaskGraph(value: unknown): readonly GraphValidationIssue[] {
  if (typeof value !== "object" || value === null || !("nodes" in value) || !Array.isArray(value.nodes)) {
    return [{ code: "invalid_graph_shape", message: "graph must declare replay/v1 nodes" }];
  }
  const nodes = value.nodes;
  const expected = REPLAY_TASK_GRAPH.nodes;
  if (!("template" in value) || value.template !== "replay/v1" || !("maxIterations" in value) || value.maxIterations !== 1) {
    return [{ code: "invalid_graph_shape", message: "graph must use replay/v1 with one return iteration" }];
  }
  if (nodes.length !== expected.length || expected.some((node, index) => {
    const candidate = nodes[index];
    return typeof candidate !== "object" || candidate === null || !("id" in candidate) || !("kind" in candidate)
      || candidate.id !== node.id || candidate.kind !== node.kind;
  })) {
    return [{ code: "invalid_node_set", message: "replay/v1 requires implementation, anti_entropy, and review in order" }];
  }
  if (!("edges" in value) || !Array.isArray(value.edges)) {
    return [{ code: "invalid_graph_shape", message: "graph edges must be an array" }];
  }
  if (value.edges.some((edge) => typeof edge !== "object" || edge === null
    || !("kind" in edge) || !["forward", "return"].includes(String(edge.kind)))) {
    return [{ code: "invalid_graph_shape", message: "replay/v1 requires exactly its three declared edges" }];
  }
  const returnEdges = value.edges.filter((edge) => typeof edge === "object" && edge !== null && "kind" in edge && edge.kind === "return");
  const expectedReturn = REPLAY_TASK_GRAPH.edges[2];
  if (returnEdges.length !== 1) {
    return [{ code: "invalid_return_edge", message: "replay/v1 requires exactly one return edge" }];
  }
  const returnEdge = returnEdges[0];
  if (!("id" in returnEdge) || !("from" in returnEdge) || !("to" in returnEdge) || !("on" in returnEdge) || !("actorRole" in returnEdge) || returnEdge.id !== expectedReturn.id
    || returnEdge.from !== expectedReturn.from || returnEdge.to !== expectedReturn.to
    || returnEdge.on !== expectedReturn.on || returnEdge.actorRole !== expectedReturn.actorRole) {
    return [{ code: "invalid_return_edge", message: "the return edge must be anti_entropy changes_requested to implementation" }];
  }
  const forwardEdges = value.edges.filter((edge) => typeof edge === "object" && edge !== null && "kind" in edge && edge.kind === "forward");
  const outgoing = new Map<unknown, number>();
  for (const edge of forwardEdges) {
    const from = "from" in edge ? edge.from : undefined;
    outgoing.set(from, (outgoing.get(from) ?? 0) + 1);
  }
  if ([...outgoing.values()].some((count) => count > 1)) {
    return [{ code: "forward_fan_out", message: "replay/v1 forward nodes cannot fan out" }];
  }
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>(taskNodeIds.map((id) => [id, 0]));
  for (const edge of forwardEdges) {
    const from = "from" in edge && typeof edge.from === "string" ? edge.from : "";
    const to = "to" in edge && typeof edge.to === "string" ? edge.to : "";
    adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
    if (indegree.has(to)) indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }
  const pending = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) break;
    visited += 1;
    for (const next of adjacency.get(current) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) pending.push(next);
    }
  }
  if (visited !== taskNodeIds.length) {
    return [{ code: "forward_cycle", message: "replay/v1 forward edges must form a DAG" }];
  }
  const expectedForward = REPLAY_TASK_GRAPH.edges.filter((edge) => edge.kind === "forward");
  if (forwardEdges.length !== expectedForward.length || expectedForward.some((expectedEdge) => !forwardEdges.some((edge) =>
    "id" in edge && "from" in edge && "to" in edge && "on" in edge && "actorRole" in edge
    && edge.id === expectedEdge.id && edge.from === expectedEdge.from && edge.to === expectedEdge.to && edge.on === expectedEdge.on && edge.actorRole === expectedEdge.actorRole))) {
    return [{ code: "invalid_forward_path", message: "replay/v1 requires the linear implementation to anti_entropy to review path" }];
  }
  return [];
}
