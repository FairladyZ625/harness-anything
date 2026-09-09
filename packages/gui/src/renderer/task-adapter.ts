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
    // 三态 gate 结论(kernel `closeoutGateOk`):unknown 投影为 null,不是第三种通过。
    ok: gate.ok,
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
    blockingLabel: blocking.label,
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
      ? {
          activeExecutionId: row.snapshot.lease.executionId,
          leaseExpiresAt: row.snapshot.lease.expiresAt,
          leaseHolder: leaseHolderLabel(row.snapshot.lease.actor),
          leasePhase: row.snapshot.lease.phase,
        }
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
    // dec_5B135F46 CH4:看板列/排序、归档降噪、行级能力与收口风险旗标由 daemon
    // 派生(kernel task-board-projection.ts),这里原样透传。
    board: row.board,
    visibility: row.visibility,
    capabilities: row.capabilities,
    risk: row.risk,
    phase: row.phase,
    ...(task.metadata?.riskTier ? { riskTier: task.metadata.riskTier } : {}),
    ...(task.metadata?.urgency ? { urgency: task.metadata.urgency } : {}),
    docs: [],
    events: lifecycleEvents(row, projectId),
  };
}

/** 列表行内的 lease 持有者标签:principal personId,agent executor 附 session 标识。 */
function leaseHolderLabel(
  actor: { readonly principal: { readonly personId: string } } & {
    readonly executor: { readonly kind: "agent"; readonly id: string } | null;
  },
): string {
  return actor.executor === null ? actor.principal.personId : `${actor.principal.personId} · ${actor.executor.id}`;
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
 * 行级 keyed 重建(W9):上游 `joinLedgerCut` 对未出现在增量页里的行保留
 * previous 的行对象引用,react-query structuralSharing 让零变更轮询连 `data`
 * 引用都不换。adapter 在这里兑现同一不变量:输入行引用未变的行直接复用上一份
 * TaskRow,只有真正变化的行产生新对象——下游 memo 的比较键因此就是行对象引用,
 * 不需要任何深比较。输出语义(字段、root 派生、行序随输入)不变。
 */
interface TaskRowCacheEntry {
  readonly row: TaskSnapshotProjectionRow;
  readonly task: TaskRow;
}

interface TaskRowsCache {
  readonly projectId: string;
  readonly projectionStatus: "ready" | "pending";
  readonly rows: ReadonlyArray<TaskSnapshotProjectionRow> | null;
  readonly output: readonly TaskRow[] | null;
  readonly entries: ReadonlyMap<string, TaskRowCacheEntry>;
}

let taskRowsCache: TaskRowsCache | null = null;

/**
 * 在 adaptProjectionRow 之上补齐 rootTaskId / rootTitle。root 派生依赖整份
 * parentById/titleById(任一行的 parent 或标题变化都可能改变别的行的根),
 * 所以查找表每次全量重建(纯读);行引用未变的行只有在派生结果真的变了时
 * 才换新对象——比较是两个短字符串的等值比较,不是深比较。
 */
export function adaptProjectionRows(
  rows: ReadonlyArray<TaskSnapshotProjectionRow>,
  projectId: string,
  projectionStatus: "ready" | "pending" = "ready",
): readonly TaskRow[] {
  const prev: TaskRowsCache | null =
    taskRowsCache !== null &&
    taskRowsCache.projectId === projectId &&
    taskRowsCache.projectionStatus === projectionStatus
      ? taskRowsCache
      : null;
  if (prev !== null && prev.rows === rows && prev.output !== null) return prev.output;

  const parentById = new Map<string, string | undefined>();
  const titleById = new Map<string, string>();
  for (const row of rows) {
    parentById.set(row.taskId, row.placement.parentTaskId ?? undefined);
    titleById.set(row.taskId, row.snapshot.task?.title ?? "");
  }

  const entries = new Map<string, TaskRowCacheEntry>();
  const output: TaskRow[] = [];
  for (const row of rows) {
    const cached = prev?.entries.get(row.taskId);
    if (cached !== undefined && cached.row === row) {
      const rootTaskId = computeRootTaskId(row.taskId, parentById);
      const rootTitle = titleById.get(rootTaskId) ?? cached.task.title;
      const task =
        cached.task.rootTaskId === rootTaskId && cached.task.rootTitle === rootTitle
          ? cached.task
          : { ...cached.task, rootTaskId, rootTitle };
      output.push(task);
      entries.set(row.taskId, { row, task });
    } else {
      const base = adaptProjectionRow(row, projectId, projectionStatus);
      const rootTaskId = computeRootTaskId(base.taskId, parentById);
      const task = { ...base, rootTaskId, rootTitle: titleById.get(rootTaskId) ?? base.title };
      output.push(task);
      entries.set(row.taskId, { row, task });
    }
  }

  // 全部行引用未变且输出逐位同引用(行序也未变)→ 上一份输出数组原样复用,
  // 下游 memo 全链路保持命中;否则返回本次新建的数组(内含复用的行引用)。
  if (
    prev !== null &&
    prev.output !== null &&
    prev.output.length === output.length &&
    prev.output.every((task, index) => task === output[index])
  ) {
    taskRowsCache = { projectId, projectionStatus, rows, output: prev.output, entries };
    return prev.output;
  }
  taskRowsCache = { projectId, projectionStatus, rows, output, entries };
  return output;
}
