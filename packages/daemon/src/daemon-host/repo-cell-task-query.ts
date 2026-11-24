import type * as ProjectionStatus from "@harness-anything/kernel/internal/domain/task-read-set.ts";
import { mergedCloseoutCandidates } from "./task-merged-closeout.ts";
import { taskPresentationReads } from "@harness-anything/application/internal/queries/task-presentation-read.ts";
import {
  admitTaskExecutionWip,
  allowsTaskStatusMove,
  deriveTaskRoot,
  explainStatusTransition,
  hasCloseoutEvidence,
  isDomainStatus,
  isExecutionWipTask,
  serializeTaskWipRootRow,
  taskWipOccupyingStatuses,
  type DomainStatus,
  type ReceiptDiagnostic,
  type TaskProjection,
  type TaskProjectionListQuery,
  type TaskRelationQuery,
  type TaskWipSnapshotEntryV1,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import { readTaskReadSet } from "@harness-anything/application/internal/task-read-set-service.ts";
import { requireCurrentTaskProjection } from "./projection-readiness.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { taskPackageDisposition, type TaskQueryReadModel } from "./task-query-read.ts";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import { projectedTaskSettings, resolveTaskRootThreshold, resolveTaskWipLimit } from "./task-wip-settings.ts";
import {
  taskListPayload,
  withWorkspacePackagePaths,
} from "@harness-anything/application/internal/queries/task-list-read.ts";
export {
  DEFAULT_TASK_LIST_LIMIT,
  taskListPayload,
  type TaskListReads,
} from "@harness-anything/application/internal/queries/task-list-read.ts";


export interface TaskQueryCell {
  readonly input: { readonly repoId: string };
  readonly rootDir: string;
  readonly projection: TaskProjection;
  readonly taskListQueryFromAction: (action: RepoTaskAction) => TaskProjectionListQuery;
  readonly relationQueryFromAction: (action: RepoTaskAction) => TaskRelationQuery;
  readonly queryRead: () => TaskQueryReadModel;
  readonly operationId: (
    action: RepoTaskAction,
    binding: RepoCellBinding,
    workspaceId: string,
    expectedRevision: number,
  ) => string;
  readonly readResult: (
    opId: string,
    value: object,
    revision: number,
    worktreeVisible: boolean | null,
    cut?: {
      readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
      readonly watermark: number;
      readonly sourceRevision: number;
    },
  ) => WriteReceipt;
  readonly cellCodedError: (code: string, message: string, diagnostic?: ReceiptDiagnostic) => Error;
  readonly requiredCellText: (value: unknown, name: string) => string;
  readonly wipSnapshotEntries: (activatingTaskId: string) => readonly TaskWipSnapshotEntryV1[];
  readonly legacyReviewLint: typeof import("./repo-cell-review-lint.ts").legacyReviewLint;
  readonly now: () => string;
}

export function listTasks(cell: TaskQueryCell, action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt {
  const { payload: canonicalPayload, read } = taskListPayload(
      {
        readTaskIndex: taskPresentationReads(cell.projection).readTaskIndex,
        readTaskChildCounts: cell.projection.readTaskChildCounts,
        rootThreshold: resolveTaskRootThreshold(projectedTaskSettings(cell.projection)).threshold,
      },
      cell.taskListQueryFromAction(action),
      action,
      cell.cellCodedError,
    ),
    payload = withWorkspacePackagePaths(cell.rootDir, canonicalPayload),
    receipt = cell.readResult(
      cell.operationId(action, binding, cell.input.repoId, read.sourceRevision),
      payload,
      read.sourceRevision,
      null,
      read,
    );
  return { ...receipt, ...payload } as WriteReceipt;
}

export function taskWipEnteringAction(
  cell: TaskQueryCell,
  action: RepoTaskAction,
): {
  readonly taskId: string;
  readonly nextStatus: DomainStatus;
} | null {
  if (action.kind !== "task-transition") return null;
  const target = String(action.status);
  return isDomainStatus(target) &&
    target === "blocked" &&
    (taskWipOccupyingStatuses as readonly DomainStatus[]).includes(target)
    ? {
        taskId: cell.requiredCellText(action.taskId, "taskId"),
        nextStatus: target,
      }
    : null;
}

export function assertTaskWipCapacity(cell: TaskQueryCell, taskId: string, nextStatus: DomainStatus): void {
  const tasks = cell.wipSnapshotEntries(taskId),
    activating = tasks.find((task: TaskWipSnapshotEntryV1) => task.taskId === taskId);
  if (!activating) return;
  const allowed =
      nextStatus === "blocked"
        ? allowsTaskStatusMove(cell.projection.read(taskId).snapshot, nextStatus)
        : activating.status !== nextStatus && explainStatusTransition(activating.status, nextStatus).allowed,
    settings = projectedTaskSettings(cell.projection),
    setting = resolveTaskWipLimit(settings),
    rootSetting = resolveTaskRootThreshold(settings),
    admission = admitTaskExecutionWip({
      limit: setting.limit,
      limitLabel: setting.label,
      tasks,
      activatingTaskId: taskId,
      nextStatus: allowed ? nextStatus : activating.status,
      rootThreshold: rootSetting.threshold,
    });
  if (!admission.ok) {
    const closeouts = mergedCloseoutCandidates(cell).slice(0, 3),
      closeoutAdvice = closeouts.length
        ? "Merged approved closeouts (owner consent remains explicit): " +
          closeouts.map((candidate) => `${candidate.taskId}: ${candidate.commands.join("; ")}`).join(". ") +
          ". "
        : "";
    throw cell.cellCodedError(
      admission.code === "TASK_WIP_LIMIT_REACHED" ? "task_wip_limit_reached" : "task_wip_limit_invalid",
      `${closeoutAdvice}${admission.message} Root threshold source: ${rootSetting.label}.`,
    );
  }
}

// Only WIP-occupying task rows (plus the activating task itself, which may still be
// planned) are read: one SQL-status-filtered list() call per occupying status, so the row
// count stays bounded by the worktable rather than the whole task ledger. Direct child
// counts for those rows come from one grouped count query.
export function wipSnapshotEntries(cell: TaskQueryCell, activatingTaskId: string): readonly TaskWipSnapshotEntryV1[] {
  const occupying = occupyingWipSnapshotEntries(cell),
    activatingRead = occupying.some((row) => row.taskId === activatingTaskId)
      ? null
      : cell.projection.read(activatingTaskId);
  if (!activatingRead?.snapshot.task) return occupying;
  const directChildCount = cell.projection.readTaskChildCounts([activatingTaskId])[activatingTaskId] ?? 0;
  return [
    ...occupying,
    {
      taskId: activatingTaskId,
      title: activatingRead.snapshot.task.title,
      status: activatingRead.snapshot.task.status,
      taskClass: activatingRead.snapshot.task.taskClass,
      packageDisposition: taskPackageDisposition(activatingRead.snapshot.task.packageDisposition),
      hasCloseoutEvidence: hasCloseoutEvidence(activatingRead.snapshot.executions),
      hasOwnExecution:
        activatingRead.snapshot.lease !== null ||
        activatingRead.snapshot.executions.some(
          (execution) => execution.state === "active" || execution.state === "submitted",
        ),
      directChildCount,
    },
  ];
}

export function readTaskWipSnapshot(cell: TaskQueryCell) {
  const entries = occupyingWipSnapshotEntries(cell),
    settings = projectedTaskSettings(cell.projection),
    limitSetting = resolveTaskWipLimit(settings),
    rootSetting = resolveTaskRootThreshold(settings);
  return {
    ok: true,
    limit: limitSetting.limit,
    limitLabel: limitSetting.label,
    counted: entries
      .filter((entry) => isExecutionWipTask(entry, rootSetting.threshold))
      .map(({ taskId, status, title }) => ({
        taskId,
        status: status as (typeof taskWipOccupyingStatuses)[number],
        title,
      })),
    roots: entries.flatMap((entry) => {
      const row = serializeTaskWipRootRow(entry.taskId, deriveTaskRoot(entry, rootSetting.threshold));
      return row === null ? [] : [row];
    }),
    threshold: rootSetting.threshold,
  } as const;
}

function occupyingWipSnapshotEntries(cell: TaskQueryCell): readonly TaskWipSnapshotEntryV1[] {
  const rows = taskWipOccupyingStatuses.flatMap(
      (status) => cell.projection.list({ status, decisionRelationsOnly: true }).rows,
    ),
    childCounts = cell.projection.readTaskChildCounts(rows.map((row) => row.taskId));
  return rows.map((row) => ({
    taskId: row.taskId,
    title: row.snapshot.task?.title ?? "",
    status: row.snapshot.task?.status ?? "planned",
    taskClass: row.snapshot.task?.taskClass ?? "standard",
    packageDisposition: taskPackageDisposition(row.snapshot.task?.packageDisposition),
    hasCloseoutEvidence: hasCloseoutEvidence(row.snapshot.executions),
    hasOwnExecution:
      row.snapshot.lease !== null ||
      row.snapshot.executions.some((execution) => execution.state === "active" || execution.state === "submitted"),
    directChildCount: childCounts[row.taskId] ?? 0,
  }));
}

export function listRelations(cell: TaskQueryCell, action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt {
  const query = cell.relationQueryFromAction(action),
    read = cell
      .queryRead()
      .relationGraphPage(
        Object.keys(query).length ? query : { limit: storageReadPolicy.defaultValue.pageSizes.standard },
      ),
    rows = read.edges.filter(
      (edge) =>
        (!action.entity || edge.sourceRef === action.entity || edge.targetRef === action.entity) &&
        (!action.source || edge.sourceRef === action.source) &&
        (!action.target || edge.targetRef === action.target) &&
        (!action.relationType || edge.relationType === action.relationType) &&
        (!action.state || edge.state === action.state),
    ),
    payload = {
      rows,
      count: rows.length,
      status: read.status,
      watermark: read.watermark,
      sourceRevision: read.sourceRevision,
      warnings: read.warnings,
      ...(read.page ? { page: read.page } : {}),
    };
  return cell.readResult(
    cell.operationId(action, binding, cell.input.repoId, read.sourceRevision),
    payload,
    read.sourceRevision,
    null,
    read,
  );
}

/**
 * The read-only read set for one Task: which entities its declared relations say to
 * read, in what order, and whether the answer is blocked. Pure read — no lease, no
 * write path, and nothing persisted back into the Task package.
 */
export function taskReadSet(cell: TaskQueryCell, action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    current = requireCurrentTaskProjection(cell.projection, taskId, "task read-set"),
    derived = readTaskReadSet(cell.projection, taskId);
  return cell.readResult(
    cell.operationId(action, binding, cell.input.repoId, current.sourceRevision),
    derived,
    current.sourceRevision,
    null,
    derived.projectionCut,
  );
}

export function reviewTask(cell: TaskQueryCell, action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    current = requireCurrentTaskProjection(cell.projection, taskId, "task review");
  const document = cell.projection.readDocument(`${current.packagePath}/review.md`),
    report = document.document
      ? cell.legacyReviewLint(
          document.document.body,
          taskId,
          typeof action.reviewerId === "string" ? action.reviewerId : binding.actor.principal.personId,
          cell.now(),
        )
      : {
          applicable: false,
          valid: true,
          status: "not-applicable",
          issues: [],
          reviewerId: typeof action.reviewerId === "string" ? action.reviewerId : null,
        };
  return cell.readResult(
    cell.operationId(action, binding, cell.input.repoId, current.sourceRevision),
    {
      taskId,
      legacyReview: report,
      completionAuthority: false,
    },
    current.sourceRevision,
    null,
  );
}
