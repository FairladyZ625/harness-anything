import type { TaskSnapshotProjectionRow } from "../api/renderer-dto.ts";
import type { TaskRow } from "./model/types.ts";

/**
 * Maps the rebuild L2 task snapshot onto the renderer view model. UI-only
 * readiness and freshness fields are derived here; the daemon returns the
 * canonical snapshot without recreating the retired GUI projection schema.
 */

/**
 * 派生 placement 不再需要 renderer 侧上下文:decision→task 的 `derives` 派生由
 * daemon 在 `repo.tasks.list` 的 `row.placement` 里完成(`moduleKeys` /
 * `productLines` / `spawningDecisionIds`,同一批 active derives 边的同一结果),
 * 任务行适配因此不依赖任何三元读取——这是把三元读取从应用根上摘掉的必要条件。
 */
function adaptProjectionRow(
  row: TaskSnapshotProjectionRow,
  projectId: string,
  projectionStatus: "ready" | "pending",
): TaskRow {
  const task = row.snapshot.task!;
  const placement = row.placement;
  const spawningDecisionIds = placement.spawningDecisionIds;
  const gates = row.closeoutAssessment.gates.map((gate) => ({
    name: gate.gateId,
    ok:
      /* @gate-identity check-gui-status-judgments/gui-status-050 */
      gate.status === "unknown"
        ? null
        : /* @gate-identity check-gui-status-judgments/gui-status-051 */
          gate.status === "passed",
    ...(gate.detail ? { detail: gate.detail } : {}),
  }));
  const blocking = row.blockingAssessment;
  const coordinationStatus = row.coordinationStatus;
  return {
    taskId: row.taskId,
    title: task.title,
    projectId,
    coordinationStatus,
    canonicalStatus: task.status,
    blocking: blocking.state,
    blockingLabel:
      /* @gate-identity check-gui-status-judgments/gui-status-052 */
      blocking.state === "blocked"
        ? `${blocking.blockers.length || "cycle"} 个 active blocking relation`
        : /* @gate-identity check-gui-status-judgments/gui-status-053 */
          blocking.state === "unknown"
          ? "阻塞关系未能确定"
          : "当前投影无 active blocking relation",
    blockers: blocking.blockers,
    blockingWarnings: blocking.warnings,
    rawStatus: `${task.status}/${task.currentNode}`,
    freshness: projectionStatus === "ready" ? "fresh" : "stale-but-usable",
    packageDisposition: row.placement.packageDisposition,
    closeoutReadiness: row.closeoutAssessment.readiness,
    engine: row.placement.engine,
    origin: row.placement.origin,
    source:
      row.placement.origin === "external"
        ? "external-engine"
        : row.placement.origin === "archival"
          ? "snapshot-cache"
          : "local-document",
    module:
      placement.moduleKeys.length === 0
        ? "unassigned"
        : placement.moduleKeys.length === 1
          ? placement.moduleKeys[0]!
          : `multiple (${placement.moduleKeys.join(", ")})`,
    moduleKeys: placement.moduleKeys,
    productLines: placement.productLines,
    ...(spawningDecisionIds.length > 1
      ? { placementWarning: "存在多个 spawning decision，placement 已合并但来源不唯一" }
      : {}),
    placementProvenance: row.placement.provenance,
    packagePath: row.packagePath,
    taskClass: task.taskClass,
    workKind: task.metadata?.workKind,
    vertical: task.metadata?.verticalId,
    preset: task.metadata?.presetId,
    profile: task.metadata?.profileId,
    createdBy: task.createdBy.principal.personId,
    parentTaskId: row.placement.parentTaskId ?? undefined,
    spawningDecisionIds,
    ...(spawningDecisionIds.length === 1 ? { spawningDecision: spawningDecisionIds[0] } : {}),
    ...(task.pinned === true ? { pinned: true } : {}),
    currentNode: task.currentNode,
    iteration: task.iteration,
    ...(row.snapshot.lease
      ? { activeExecutionId: row.snapshot.lease.executionId, leaseExpiresAt: row.snapshot.lease.expiresAt }
      : {}),
    createdAt: row.createdAt,
    lastKnownAt: row.updatedAt,
    gates,
    ...(row.closeoutAssessment.blocker ? { closeoutBlocker: row.closeoutAssessment.blocker } : {}),
    snapshotAvailability: row.snapshotAvailability,
    reviews: row.snapshot.reviews,
    consents: row.snapshot.consents,
    codeDocWitnesses: row.snapshot.codeDocWitnesses,
    gateWitnesses: row.snapshot.gateWitnesses,
    // W5:执行证据页撤销后,execution 输出/回执的渲染归 Task 详情「收口」页签;
    // 这里按 reviews 等既有模式原样透传,renderer 不重解释 kernel 字段。
    executions: row.snapshot.executions,
    executionEvidence: row.executionEvidence,
    ...(task.metadata?.riskTier ? { riskTier: task.metadata.riskTier } : {}),
    ...(task.metadata?.urgency ? { urgency: task.metadata.urgency } : {}),
    docs: [],
    events: lifecycleEvents(row, projectId),
  };
}

function lifecycleEvents(row: TaskSnapshotProjectionRow, projectId: string): TaskRow["events"] {
  const taskId = row.taskId,
    events = [
      ...row.snapshot.executions.flatMap((execution) => [
        { at: execution.claimedAt, projectId, taskId, summary: `Execution ${execution.executionId} started` },
        ...(execution.submittedAt
          ? [{ at: execution.submittedAt, projectId, taskId, summary: `Execution ${execution.executionId} submitted` }]
          : []),
        ...(execution.closedAt
          ? [
              {
                at: execution.closedAt,
                projectId,
                taskId,
                summary: `Execution ${execution.executionId} closed (${execution.state})`,
              },
            ]
          : []),
      ]),
      ...row.snapshot.reviews.map((review) => ({
        at: review.reviewedAt,
        projectId,
        taskId,
        summary: `Review ${review.reviewId}: ${review.verdict}`,
      })),
      ...row.snapshot.consents.map((consent) => ({
        at: consent.consentedAt,
        projectId,
        taskId,
        summary: `Consent ${consent.consentId} recorded`,
      })),
      ...row.snapshot.codeDocWitnesses.map((witness) => ({
        at: witness.schema === "code-doc-witness/v1" ? witness.reconciledAt : witness.repointedAt,
        projectId,
        taskId,
        summary: `Code/doc witness ${witness.schema === "code-doc-witness/v1" ? witness.witnessId : witness.recordId}`,
      })),
      ...row.snapshot.gateWitnesses.map((witness) => ({
        at: witness.verifiedAt,
        projectId,
        taskId,
        summary: `Gate ${witness.gateId}: ${witness.result}`,
      })),
    ];
  return events.sort((left, right) => right.at.localeCompare(left.at));
}

/**
 * 沿 parentTaskId 链上溯到根任务 id。投影行以 Map 形式提供(taskId→parentTaskId)。
 * 根任务的 rootTaskId=自身。链中检测到环或指向不存在的 task 时,以当前 task 为根
 * (防御:不无限循环,投影数据不应有环,但前端不能信任输入)。
 */
export function computeRootTaskId(taskId: string, parentById: ReadonlyMap<string, string | undefined>): string {
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
export function adaptProjectionRows(
  rows: ReadonlyArray<TaskSnapshotProjectionRow>,
  projectId: string,
  projectionStatus: "ready" | "pending" = "ready",
): readonly TaskRow[] {
  const base = rows.map((row) => adaptProjectionRow(row, projectId, projectionStatus));
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
