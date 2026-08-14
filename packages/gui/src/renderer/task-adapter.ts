import type { TaskSnapshotProjectionRow } from "../api/renderer-dto.ts";
import type { BlockingContributor, DecisionRow, GateResult, RelationEdge, TaskRow } from "./model/types.ts";

/**
 * Maps the rebuild L2 task snapshot onto the renderer view model. UI-only
 * readiness and freshness fields are derived here; the daemon returns the
 * canonical snapshot without recreating the retired GUI projection schema.
 */

export interface TaskAdaptContext {
  readonly relationState?: "ready" | "loading" | "error";
  readonly relations?: ReadonlyArray<RelationEdge>;
  readonly decisions?: ReadonlyArray<DecisionRow>;
  readonly relationWarnings?: ReadonlyArray<{ readonly severity?: string; readonly code?: string; readonly message?: string }>;
}

function adaptProjectionRow(row: TaskSnapshotProjectionRow, projectId: string, projectionStatus: "ready" | "pending", context: TaskAdaptContext): TaskRow {
  const task = row.snapshot.task!;
  const placement = placementFor(row, context);
  const gates = gateResults(row);
  return {
    taskId: row.taskId,
    title: task.title,
    projectId,
    coordinationStatus: task.status,
    canonicalStatus: task.status,
    blocking: "clear",
    blockingLabel: "当前投影无 active blocking relation",
    blockers: [],
    blockingWarnings: [],
    rawStatus: `${task.status}/${task.currentNode}`,
    freshness: projectionStatus === "ready" ? "fresh" : "stale-but-usable",
    packageDisposition: row.placement.packageDisposition,
    closeoutReadiness: closeoutReadiness(row, gates),
    engine: row.placement.engine,
    origin: row.placement.origin,
    source: row.placement.origin === "external" ? "external-engine" : row.placement.origin === "archival" ? "snapshot-cache" : "local-document",
    module: placement.moduleKeys.length === 0 ? "unassigned" : placement.moduleKeys.length === 1 ? placement.moduleKeys[0]! : `multiple (${placement.moduleKeys.join(", ")})`,
    moduleKeys: placement.moduleKeys,
    productLines: placement.productLines,
    ...(placement.warning ? { placementWarning: placement.warning } : {}),
    placementProvenance: row.placement.provenance,
    packagePath: row.packagePath,
    parentTaskId: row.placement.parentTaskId ?? undefined,
    ...(placement.spawningDecision ? { spawningDecision: placement.spawningDecision } : {}),
    currentNode: task.currentNode,
    iteration: task.iteration,
    ...(row.snapshot.lease ? { activeExecutionId: row.snapshot.lease.executionId, leaseExpiresAt: row.snapshot.lease.expiresAt } : {}),
    lastKnownAt: row.updatedAt,
    gates,
    docs: [],
    events: lifecycleEvents(row, projectId)
  };
}

function placementFor(row: TaskSnapshotProjectionRow, context: TaskAdaptContext): { moduleKeys: string[]; productLines: string[]; spawningDecision?: string; warning?: string } {
  if ((context.relationState !== undefined && context.relationState !== "ready") || (context.relationWarnings ?? []).some((warning) => warning.severity === "hard-fail")) {
    return { moduleKeys: [], productLines: [], warning: "relation projection 未就绪，无法判定 derived placement" };
  }
  const relations = context.relations ?? [], decisionById = new Map((context.decisions ?? []).map((decision) => [decision.decisionId, decision]));
  const derives = relations.filter((edge) => edge.kind === "derives" && edge.state === "active" && edge.direction === "directed" && edge.to === `task/${row.taskId}` && edge.from.startsWith("decision/"));
  if (derives.length === 0) return { moduleKeys: [...row.placement.moduleKeys], productLines: [...row.placement.productLines] };
  const ids = [...new Set(derives.map((edge) => edge.from.split("/")[1]).filter((id): id is string => Boolean(id)))], scopes = ids.map((id) => decisionById.get(id)?.appliesTo);
  if (scopes.some((scope) => scope === undefined)) return { moduleKeys: [], productLines: [], warning: "派生决策 scope 未完整投影" };
  return {
    moduleKeys: [...new Set(scopes.flatMap((scope) => scope!.modules))].sort(),
    productLines: [...new Set(scopes.flatMap((scope) => scope!.productLines))].sort(),
    ...(ids.length === 1 ? { spawningDecision: ids[0] } : { warning: "存在多个 spawning decision，placement 已合并但来源不唯一" })
  };
}

function gateResults(row: TaskSnapshotProjectionRow): GateResult[] {
  const { snapshot, snapshotAvailability } = row, task = snapshot.task!, execution = snapshot.executions.find((item) => item.iteration === task.iteration && item.submission !== null), commitSha = execution?.submission?.commitSha;
  return task.completionGateIds.map((name) => {
    const codeDoc = name === "code-doc-reconciliation", availability = codeDoc ? snapshotAvailability.codeDocWitnesses : snapshotAvailability.gateWitnesses;
    if (availability === "unknown") return { name, ok: null, detail: "witness projection unknown" };
    const found = codeDoc
      ? snapshot.codeDocWitnesses.some((item) => item.executionId === execution?.executionId && item.commitSha === commitSha && item.iteration === task.iteration)
      : snapshot.gateWitnesses.some((item) => item.gateId === name && item.executionId === execution?.executionId && item.commitSha === commitSha && item.iteration === task.iteration && item.result === "pass");
    return { name, ok: found, ...(!found ? { detail: execution ? "当前 execution cut 未见 witness" : "尚无 submitted execution" } : {}) };
  });
}

function closeoutReadiness(row: TaskSnapshotProjectionRow, gates: ReadonlyArray<GateResult>): TaskRow["closeoutReadiness"] {
  const { snapshot, snapshotAvailability } = row, task = snapshot.task!;
  if (task.status === "done") return "passed";
  if (task.status !== "in_review") return "not_required";
  const execution = snapshot.executions.find((item) => item.iteration === task.iteration && item.state === "submitted" && item.submission !== null);
  if (!execution) return "missing";
  if (Object.values(snapshotAvailability).includes("unknown") || gates.some((gate) => gate.ok === null)) return "incomplete";
  const review = snapshot.reviews.find((item) => item.executionId === execution.executionId && item.verdict === "approved"), consent = review && snapshot.consents.find((item) => item.executionId === execution.executionId && item.reviewId === review.reviewId && item.contentDigest === review.contentDigest);
  return review && consent && gates.every((gate) => gate.ok === true) ? "ready" : "incomplete";
}

function lifecycleEvents(row: TaskSnapshotProjectionRow, projectId: string): TaskRow["events"] {
  const taskId = row.taskId, events = [
    ...row.snapshot.executions.flatMap((execution) => [
      { at: execution.claimedAt, projectId, taskId, summary: `Execution ${execution.executionId} started` },
      ...(execution.submittedAt ? [{ at: execution.submittedAt, projectId, taskId, summary: `Execution ${execution.executionId} submitted` }] : []),
      ...(execution.closedAt ? [{ at: execution.closedAt, projectId, taskId, summary: `Execution ${execution.executionId} closed (${execution.state})` }] : [])
    ]),
    ...row.snapshot.reviews.map((review) => ({ at: review.reviewedAt, projectId, taskId, summary: `Review ${review.reviewId}: ${review.verdict}` })),
    ...row.snapshot.consents.map((consent) => ({ at: consent.consentedAt, projectId, taskId, summary: `Consent ${consent.consentId} recorded` })),
    ...row.snapshot.codeDocWitnesses.map((witness) => ({ at: witness.reconciledAt, projectId, taskId, summary: `Code/doc witness ${witness.witnessId}` })),
    ...row.snapshot.gateWitnesses.map((witness) => ({ at: witness.verifiedAt, projectId, taskId, summary: `Gate ${witness.gateId}: ${witness.result}` }))
  ];
  return events.sort((left, right) => right.at.localeCompare(left.at));
}

/**
 * 沿 parentTaskId 链上溯到根任务 id。投影行以 Map 形式提供(taskId→parentTaskId)。
 * 根任务的 rootTaskId=自身。链中检测到环或指向不存在的 task 时,以当前 task 为根
 * (防御:不无限循环,投影数据不应有环,但前端不能信任输入)。
 */
export function computeRootTaskId(
  taskId: string,
  parentById: ReadonlyMap<string, string | undefined>,
): string {
  let current = taskId;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(current)) return taskId; // 环防御
    visited.add(current);
    const parent = parentById.get(current);
    if (!parent || !parentById.has(parent)) return current;
    current = parent;
  }
}

/**
 * 在 adaptProjectionRow 之上补齐 rootTaskId / rootTitle。两阶段:先建 parentById
 * 查找表,再按表给每个 row 标根与根标题。
 */
export function adaptProjectionRows(rows: ReadonlyArray<TaskSnapshotProjectionRow>, projectId: string, projectionStatus: "ready" | "pending" = "ready", context: TaskAdaptContext = {}): TaskRow[] {
  const base = deriveBlocking(rows.map((row) => adaptProjectionRow(row, projectId, projectionStatus, context)), context);
  const parentById = new Map<string, string | undefined>();
  const titleById = new Map<string, string>();
  for (const task of base) {
    parentById.set(task.taskId, task.parentTaskId);
    titleById.set(task.taskId, task.title);
  }
  return base.map((task) => {
    const rootTaskId = computeRootTaskId(task.taskId, parentById);
    const rootTitle = titleById.get(rootTaskId) ?? task.title;
    return { ...task, rootTaskId, rootTitle };
  });
}

export function deriveBlocking(tasks: ReadonlyArray<TaskRow>, context: TaskAdaptContext): TaskRow[] {
  const taskById = new Map(tasks.map((task) => [task.taskId, task])), blockers = new Map<string, BlockingContributor[]>(), unknown = new Map<string, string[]>(), cycleNodes = new Set<string>();
  const globalUnknown = context.relationState !== undefined && context.relationState !== "ready" || (context.relationWarnings ?? []).some((warning) => warning.severity === "hard-fail");
  if (globalUnknown) for (const task of tasks) add(unknown, task.taskId, context.relationState === "error" ? "relation query failed" : context.relationState === "loading" ? "relation query loading" : "relation projection hard-fail warning");
  const graph = new Map<string, string[]>();
  for (const edge of context.relations ?? []) {
    if (edge.kind !== "blocks" && edge.kind !== "depends-on") continue;
    const sourceId = exactTaskId(edge.from), targetId = exactTaskId(edge.to), knownIds = [sourceId, targetId].filter((id): id is string => Boolean(id && taskById.has(id)));
    if (edge.state === "retired" || edge.state === "deleted") continue;
    if (edge.state !== "active" || edge.direction !== "directed" || !sourceId || !targetId || !taskById.has(sourceId) || !taskById.has(targetId)) {
      const message = !sourceId || !targetId ? `invalid blocking endpoint: ${edge.from} → ${edge.to}` : !taskById.has(sourceId) || !taskById.has(targetId) ? `blocking endpoint missing from task snapshot: ${!taskById.has(sourceId) ? sourceId : targetId}` : `blocking relation ${edge.relationId ?? "unknown"} is not active directed`;
      for (const id of knownIds.length ? knownIds : tasks.map((task) => task.taskId)) add(unknown, id, message);
      continue;
    }
    add(graph, sourceId, targetId);
    const blockedId = edge.kind === "blocks" ? targetId : taskById.get(targetId)?.canonicalStatus === "done" ? null : sourceId;
    if (blockedId) add(blockers, blockedId, { relationId: edge.relationId ?? "unknown", kind: edge.kind, sourceTaskId: sourceId, targetTaskId: targetId, ...(edge.rationale ? { rationale: edge.rationale } : {}) });
  }
  findCycleNodes(graph).forEach((id) => cycleNodes.add(id));
  for (const id of cycleNodes) add(unknown, id, "active blocking relation cycle detected; cycle nodes remain blocked");
  return tasks.map((task) => {
    const taskBlockers = blockers.get(task.taskId) ?? [], warnings = unknown.get(task.taskId) ?? [], blocking = taskBlockers.length || cycleNodes.has(task.taskId) ? "blocked" : warnings.length ? "unknown" : "clear";
    const coordinationStatus = blocking === "blocked" && (task.canonicalStatus === "planned" || task.canonicalStatus === "active") ? "blocked" : task.canonicalStatus ?? task.coordinationStatus;
    return { ...task, coordinationStatus, blocking, blockingLabel: blocking === "blocked" ? `${taskBlockers.length || "cycle"} 个 active blocking relation` : blocking === "unknown" ? "阻塞关系未能确定" : "当前投影无 active blocking relation", blockers: taskBlockers, blockingWarnings: [...new Set(warnings)] };
  });
}

function exactTaskId(ref: string): string | null { const match = /^task\/([^/]+)$/u.exec(ref); return match?.[1] ?? null; }
function add<K, V>(map: Map<K, V[]>, key: K, value: V): void { map.set(key, [...map.get(key) ?? [], value]); }
function findCycleNodes(graph: ReadonlyMap<string, ReadonlyArray<string>>): Set<string> {
  const cycle = new Set<string>(), visited = new Set<string>(), stack: string[] = [], active = new Set<string>();
  const visit = (id: string): void => { if (active.has(id)) { stack.slice(stack.indexOf(id)).forEach((node) => cycle.add(node)); return; } if (visited.has(id)) return; visited.add(id); active.add(id); stack.push(id); for (const next of graph.get(id) ?? []) visit(next); stack.pop(); active.delete(id); };
  for (const id of graph.keys()) visit(id); return cycle;
}
