import type { TaskSnapshotProjectionRow } from "../api/renderer-dto.ts";
import type { DecisionRow, RelationEdge, TaskRow } from "./model/types.ts";

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
  const gates = row.closeoutAssessment.gates.map((gate) => ({ name: gate.gateId, ok: gate.status === "unknown" ? null : gate.status === "passed", ...(gate.detail ? { detail: gate.detail } : {}) }));
  const blocking = row.blockingAssessment;
  const coordinationStatus = row.coordinationStatus;
  return {
    taskId: row.taskId,
    title: task.title,
    projectId,
    coordinationStatus,
    canonicalStatus: task.status,
    blocking: blocking.state,
    blockingLabel: blocking.state === "blocked" ? `${blocking.blockers.length || "cycle"} 个 active blocking relation` : blocking.state === "unknown" ? "阻塞关系未能确定" : "当前投影无 active blocking relation",
    blockers: [...blocking.blockers],
    blockingWarnings: [...blocking.warnings],
    rawStatus: `${task.status}/${task.currentNode}`,
    freshness: projectionStatus === "ready" ? "fresh" : "stale-but-usable",
    packageDisposition: row.placement.packageDisposition,
    closeoutReadiness: row.closeoutAssessment.readiness,
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
    ...(task.pinned === true ? { pinned: true } : {}),
    currentNode: task.currentNode,
    iteration: task.iteration,
    ...(row.snapshot.lease ? { activeExecutionId: row.snapshot.lease.executionId, leaseExpiresAt: row.snapshot.lease.expiresAt } : {}),
    createdAt: row.createdAt,
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
  const base = rows.map((row) => adaptProjectionRow(row, projectId, projectionStatus, context));
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
