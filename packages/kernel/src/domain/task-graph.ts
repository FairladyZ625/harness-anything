export const taskNodeIds = ["implementation", "review"] as const;
export type TaskNodeId = (typeof taskNodeIds)[number];
export const graphEdgeTriggers = ["submitted", "changes_requested"] as const;
export type GraphEdgeTrigger = (typeof graphEdgeTriggers)[number];
export const graphActorRoles = ["executor", "reviewer"] as const;
export type GraphActorRole = (typeof graphActorRoles)[number];
export interface GraphEdgeDefinition { readonly id: string; readonly from: TaskNodeId; readonly to: TaskNodeId; readonly on: GraphEdgeTrigger; readonly actorRole: GraphActorRole; readonly kind: "forward" | "return" }
export interface TaskGraphV1 { readonly template: "replay/v1"; readonly nodes: readonly [{ readonly id: "implementation"; readonly kind: "work" }, { readonly id: "review"; readonly kind: "review" }]; readonly edges: readonly GraphEdgeDefinition[]; readonly maxIterations: 1 }
export interface TaskEdgeTaken { readonly edgeId: string; readonly from: TaskNodeId; readonly to: TaskNodeId; readonly on: GraphEdgeTrigger; readonly actorRole: GraphActorRole; readonly reason: string; readonly commitSha: string; readonly iteration: number }
export interface GraphValidationIssue { readonly code: "invalid_node_set" | "invalid_graph_shape" | "invalid_return_edge" | "invalid_forward_path" | "forward_fan_out" | "forward_cycle"; readonly message: string }
export const REPLAY_TASK_GRAPH: TaskGraphV1 = Object.freeze({ template: "replay/v1", nodes: Object.freeze([Object.freeze({ id: "implementation", kind: "work" }), Object.freeze({ id: "review", kind: "review" })] as const), edges: Object.freeze([
  Object.freeze({ id: "implementation-submitted", from: "implementation", to: "review", on: "submitted", actorRole: "executor", kind: "forward" }),
  Object.freeze({ id: "review-changes-requested", from: "review", to: "implementation", on: "changes_requested", actorRole: "reviewer", kind: "return" })
]), maxIterations: 1 });
export const TASK_GRAPH_V1_SCHEMA = Object.freeze({ id: "TaskGraph/v1", template: "replay/v1", nodes: taskNodeIds, maxIterations: 1 });
export const TASK_EDGE_TAKEN_SCHEMA = Object.freeze({ id: "TaskEdgeTaken/v1", required: Object.freeze(["edgeId", "from", "to", "on", "actorRole", "reason", "commitSha", "iteration"]) });
export function validateTaskGraph(value: unknown): readonly GraphValidationIssue[] {
  if (!isTaskGraphRecord(value) || value.template !== "replay/v1" || value.maxIterations !== 1 || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return [graphIssue("invalid_graph_shape", "graph must declare canonical replay/v1 nodes and edges")];
  if (JSON.stringify(value.nodes) !== JSON.stringify(REPLAY_TASK_GRAPH.nodes)) return [graphIssue("invalid_node_set", "replay/v1 requires implementation and review in order")];
  if (value.edges.some((edge) => !isTaskGraphRecord(edge) || !["forward", "return"].includes(String(edge.kind)))) return [graphIssue("invalid_graph_shape", "replay/v1 edges require a declared kind")];
  const returns = value.edges.filter((edge) => isTaskGraphRecord(edge) && edge.kind === "return"), forwards = value.edges.filter((edge) => isTaskGraphRecord(edge) && edge.kind === "forward");
  if (returns.length !== 1 || !sameEdge(returns[0], REPLAY_TASK_GRAPH.edges[1])) return [graphIssue("invalid_return_edge", "review changes_requested is the only return edge")];
  const outgoing = new Map<unknown, number>(); for (const edge of forwards) if (isTaskGraphRecord(edge)) outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
  if ([...outgoing.values()].some((count) => count > 1)) return [graphIssue("forward_fan_out", "replay/v1 forward nodes cannot fan out")];
  if (forwards.some((edge) => isTaskGraphRecord(edge) && edge.from === edge.to)) return [graphIssue("forward_cycle", "replay/v1 forward edges must form a DAG")];
  if (forwards.length !== 1 || !sameEdge(forwards[0], REPLAY_TASK_GRAPH.edges[0])) return [graphIssue("invalid_forward_path", "submit must be the sole implementation to review edge")];
  return [];
}
function isTaskGraphRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function sameEdge(value: unknown, expected: GraphEdgeDefinition): boolean { return isTaskGraphRecord(value) && ["id", "from", "to", "on", "actorRole", "kind"].every((key) => value[key] === expected[key as keyof GraphEdgeDefinition]); }
function graphIssue(code: GraphValidationIssue["code"], message: string): GraphValidationIssue { return { code, message }; }
