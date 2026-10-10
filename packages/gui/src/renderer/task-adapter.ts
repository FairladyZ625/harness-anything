import { principalLabel as principalId } from "./model/actor-name.ts";
import type { ActorIdentity } from "../api/renderer-dto.ts";
import type { TaskSnapshotProjectionRow } from "../api/renderer-dto.ts";
import { t } from "./i18n/index.tsx";
import type { EventEntry, TaskRow } from "./model/types.ts";
import { WORK_STEP_LABEL_KEY, type WorkStepKind } from "./model/workspace-narrative.ts";
import { NO_WORKS, type WorkIndex } from "./model/work-collections.ts";

/**
 * Maps the rebuild L2 task snapshot onto the renderer view model. UI-only
 * readiness and freshness fields are derived here; the daemon returns the
 * canonical snapshot without recreating the retired GUI projection schema.
 */

/**
 * 派生 placement 不再需要 renderer 侧上下文:decision→task 的 `derives` 派生由
 * daemon 在 `repo.tasks.list` 的 `row.placement` 里完成(`productLines` /
 * `spawningDecisionIds`,同一批 active derives 边的同一结果),
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
    // 签发总池按 status 区分 failed/missing(ok 三态压平了这一层),原样透传。
    status: gate.status,
    ...(gate.detail ? { detail: gate.detail } : {}),
  }));
  const blocking = row.blockingAssessment;
  const coordinationStatus = row.coordinationStatus;
  return {
    taskId: row.taskId,
    revision: row.snapshot.revision,
    assignment: task.assignment,
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
    productLines: placement.productLines,
    ...(spawningDecisionIds.length > 1
      ? { placementWarning: "存在多个 spawning decision，placement 已合并但来源不唯一" }
      : {}),
    placementProvenance: row.placement.provenance,
    packagePath: row.packagePath,
    ...(row.workspace ? { workspace: row.workspace } : {}),
    taskClass: task.taskClass,
    workKind: task.metadata?.workKind,
    vertical: task.metadata?.verticalId,
    preset: task.metadata?.presetId,
    profile: task.metadata?.profileId,
    createdBy: principalId(task.createdBy.principal),
    parentTaskId: row.placement.parentTaskId ?? undefined,
    spawningDecisionIds,
    ...(task.pinned === true ? { pinned: true } : {}),
    currentNode: task.currentNode,
    iteration: task.iteration,
    ...(row.snapshot.lease
      ? {
          activeExecutionId: row.snapshot.lease.executionId,
          leaseExpiresAt: row.snapshot.lease.expiresAt,
          leaseHolder: leaseHolderLabel(row.snapshot.lease.actor),
          leasePhase: row.snapshot.lease.phase,
          // 结构字段原样透传:协作视图按 actor/source 结构消费,不从显示串反解析。
          leaseActor: row.snapshot.lease.actor,
          leaseSource: row.snapshot.lease.source,
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
function leaseHolderLabel(actor: ActorIdentity): string {
  return actor.executor === null
    ? principalId(actor.principal)
    : `${principalId(actor.principal)} · ${actor.executor.id}`;
}

// 快照记录 → 时间线事件种类。词表单源是 workspace-narrative 的 WorkStepKind
// (与工作概况「最近进展」同一套),渲染层经 STEP_META 查标签与色调,这里不拼英文短语。
const EXECUTION_CLOSED_KIND: Readonly<Record<string, WorkStepKind>> = {
  accepted: "completed",
  changes_requested: "returned",
  abandoned: "abandoned",
};
const REVIEW_VERDICT_KIND: Readonly<Record<string, WorkStepKind>> = {
  approved: "approved",
  changes_requested: "rejected",
  dismissed: "dismissed",
};
const GATE_RESULT_KIND: Readonly<Record<string, WorkStepKind>> = {
  pass: "gatePass",
  fail: "gateFail",
  advisory: "gateCheck",
  not_run: "gateCheck",
};

function lifecycleEvents(row: TaskSnapshotProjectionRow, projectId: string): TaskRow["events"] {
  const taskId = row.taskId;
  // 引用对象的 recordRef 在记录源头按种类拼好(execution/review/consent/witness),
  // 渲染层不从 ref 文本猜类型;同 execution 的多条事件共用同一引用。
  const event = (at: string, kind: WorkStepKind, ref: string, recordKind: string): EventEntry => ({
    at,
    projectId,
    taskId,
    kind,
    ref,
    recordRef: `${recordKind}/${ref}`,
    summary: t(WORK_STEP_LABEL_KEY[kind]),
  });
  const events = [
    ...row.snapshot.executions.flatMap((execution) => [
      event(execution.claimedAt, "start", execution.executionId, "execution"),
      ...(execution.submittedAt ? [event(execution.submittedAt, "submit", execution.executionId, "execution")] : []),
      // 未登记的终态按已完成收束(词表没有中性的「关闭」;编号行尾仍可达)。
      ...(execution.closedAt
        ? [
            event(
              execution.closedAt,
              EXECUTION_CLOSED_KIND[execution.state] ?? "completed",
              execution.executionId,
              "execution",
            ),
          ]
        : []),
    ]),
    ...row.snapshot.reviews.map((review) =>
      event(review.reviewedAt, REVIEW_VERDICT_KIND[review.verdict] ?? "rejected", review.reviewId, "review"),
    ),
    ...row.snapshot.consents.map((consent) => event(consent.consentedAt, "consent", consent.consentId, "consent")),
    ...row.snapshot.codeDocWitnesses.map((witness) =>
      witness.schema === "code-doc-witness/v1"
        ? event(witness.reconciledAt, "witness", witness.witnessId, "witness")
        : event(witness.repointedAt, "witness", witness.recordId, "witness"),
    ),
    ...row.snapshot.gateWitnesses.map((witness) =>
      event(witness.verifiedAt, GATE_RESULT_KIND[witness.result] ?? "gateCheck", witness.witnessId, "witness"),
    ),
  ];
  return events.sort((left, right) => right.at.localeCompare(left.at));
}

/**
 * 行级 keyed 重建(W9):上游 `joinLedgerCut` 对未出现在增量页里的行保留
 * previous 的行对象引用,react-query structuralSharing 让零变更轮询连 `data`
 * 引用都不换。adapter 在这里兑现同一不变量:输入行引用未变的行直接复用上一份
 * TaskRow,只有真正变化的行产生新对象——下游 memo 的比较键因此就是行对象引用,
 * 不需要任何深比较。输出语义(字段、所属工作、行序随输入)不变。
 */
interface TaskRowCacheEntry {
  readonly row: TaskSnapshotProjectionRow;
  readonly task: TaskRow;
}

interface TaskRowsCache {
  readonly projectId: string;
  readonly projectionStatus: "ready" | "pending";
  readonly rows: ReadonlyArray<TaskSnapshotProjectionRow> | null;
  readonly works: WorkIndex | null;
  readonly output: readonly TaskRow[] | null;
  readonly entries: ReadonlyMap<string, TaskRowCacheEntry>;
}

let taskRowsCache: TaskRowsCache | null = null;

/**
 * 在 adaptProjectionRow 之上盖上所属工作(workId / workTitle)。所属工作由 daemon 工作索引
 * (`repo.works.index`)给出,renderer 不沿父链自己判定;索引换代时只有所属工作真的变了的行
 * 才换新对象——比较是两个短字符串的等值比较,不是深比较。
 */
export function adaptProjectionRows(
  rows: ReadonlyArray<TaskSnapshotProjectionRow>,
  projectId: string,
  projectionStatus: "ready" | "pending" = "ready",
  works: WorkIndex = NO_WORKS,
): readonly TaskRow[] {
  const prev: TaskRowsCache | null =
    taskRowsCache !== null &&
    taskRowsCache.projectId === projectId &&
    taskRowsCache.projectionStatus === projectionStatus
      ? taskRowsCache
      : null;
  if (prev !== null && prev.rows === rows && prev.works === works && prev.output !== null) return prev.output;

  const entries = new Map<string, TaskRowCacheEntry>();
  const output: TaskRow[] = [];
  for (const row of rows) {
    const cached = prev?.entries.get(row.taskId);
    const base =
      cached !== undefined && cached.row === row ? cached.task : adaptProjectionRow(row, projectId, projectionStatus);
    const work = works.workOf(base.taskId);
    const task =
      base.workId === work?.taskId && base.workTitle === work?.title
        ? base
        : { ...base, workId: work?.taskId, workTitle: work?.title };
    output.push(task);
    entries.set(row.taskId, { row, task });
  }

  // 全部行引用未变且输出逐位同引用(行序也未变)→ 上一份输出数组原样复用,
  // 下游 memo 全链路保持命中;否则返回本次新建的数组(内含复用的行引用)。
  if (
    prev !== null &&
    prev.output !== null &&
    prev.output.length === output.length &&
    prev.output.every((task, index) => task === output[index])
  ) {
    taskRowsCache = { projectId, projectionStatus, rows, works, output: prev.output, entries };
    return prev.output;
  }
  taskRowsCache = { projectId, projectionStatus, rows, works, output, entries };
  return output;
}
