export interface BlockingTask { readonly taskId: string; readonly status: string }
export interface BlockingRelation { readonly relationId: string; readonly sourceRef: string; readonly targetRef: string; readonly relationType: string; readonly direction: string; readonly state: string; readonly rationale?: string }
export interface BlockingContributor { readonly relationId: string; readonly kind: "depends-on"; readonly sourceTaskId: string; readonly targetTaskId: string; readonly rationale?: string }
export type BlockingAssessmentState = "blocked" | "clear" | "unknown";
export type BlockingAvailabilityState = "ready" | "loading" | "error";
export interface BlockingAssessment { readonly taskId: string; readonly state: BlockingAssessmentState; readonly blockers: readonly BlockingContributor[]; readonly warnings: readonly string[] }
export interface BlockingProjectionState { readonly state?: BlockingAvailabilityState; readonly hardFailWarnings?: readonly string[] }

/** Canonical direction: `A depends-on B` blocks A until B is done. */
export function blockingOf(tasks: readonly BlockingTask[], relations: readonly BlockingRelation[], projection: BlockingProjectionState = {}): readonly BlockingAssessment[] {
  const taskById = new Map(tasks.map((task) => [task.taskId, task])), blockers = new Map<string, BlockingContributor[]>(), warnings = new Map<string, string[]>(), graph = new Map<string, string[]>();
  const global = projection.state !== undefined && projection.state !== "ready" || Boolean(projection.hardFailWarnings?.length);
  if (global) for (const task of tasks) add(warnings, task.taskId, projection.state === "error" ? "relation query failed" : projection.state === "loading" ? "relation query loading" : projection.hardFailWarnings?.[0] ?? "relation projection hard-fail warning");
  for (const edge of relations.filter(({ relationType }) => relationType === "depends-on")) {
    if (edge.state === "edge_retired" || edge.state === "deleted") continue;
    const sourceId = taskId(edge.sourceRef), targetId = taskId(edge.targetRef), known = [sourceId, targetId].filter((id): id is string => Boolean(id && taskById.has(id)));
    if (edge.state !== "active" || edge.direction !== "directed" || !sourceId || !targetId || !taskById.has(sourceId) || !taskById.has(targetId)) {
      const message = !sourceId || !targetId ? `invalid blocking endpoint: ${edge.sourceRef} → ${edge.targetRef}` : !taskById.has(sourceId) || !taskById.has(targetId) ? `blocking endpoint missing from task snapshot: ${!taskById.has(sourceId) ? sourceId : targetId}` : `blocking relation ${edge.relationId} is not active directed`;
      for (const id of known.length ? known : tasks.map(({ taskId: id }) => id)) add(warnings, id, message);
      continue;
    }
    add(graph, sourceId, targetId);
    if (taskById.get(targetId)?.status !== "done") add(blockers, sourceId, { relationId: edge.relationId, kind: "depends-on", sourceTaskId: sourceId, targetTaskId: targetId, ...(edge.rationale ? { rationale: edge.rationale } : {}) });
  }
  const cycles = findCycleNodes(graph);
  for (const id of cycles) add(warnings, id, "active blocking relation cycle detected; cycle nodes remain blocked");
  return tasks.map(({ taskId: id }) => { const taskBlockers = blockers.get(id) ?? [], taskWarnings = [...new Set(warnings.get(id) ?? [])]; return { taskId: id, state: taskBlockers.length || cycles.has(id) ? "blocked" : taskWarnings.length ? "unknown" : "clear", blockers: taskBlockers, warnings: taskWarnings }; });
}

function taskId(ref: string): string | null { return /^task\/([^/]+)$/u.exec(ref)?.[1] ?? null; }
function add<K, V>(map: Map<K, V[]>, key: K, value: V): void { map.set(key, [...map.get(key) ?? [], value]); }
function findCycleNodes(graph: ReadonlyMap<string, readonly string[]>): ReadonlySet<string> { const cycles = new Set<string>(), visited = new Set<string>(), active = new Set<string>(), stack: string[] = []; const visit = (id: string): void => { if (active.has(id)) { stack.slice(stack.indexOf(id)).forEach((node) => cycles.add(node)); return; } if (visited.has(id)) return; visited.add(id); active.add(id); stack.push(id); for (const next of graph.get(id) ?? []) visit(next); stack.pop(); active.delete(id); }; for (const id of graph.keys()) visit(id); return cycles; }
