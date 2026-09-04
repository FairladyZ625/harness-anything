import {
  admitTaskExecutionWip,
  allowsTaskStatusMove,
  deriveTaskRoot,
  explainStatusTransition,
  hasCloseoutEvidence,
  isDomainStatus,
  taskWipOccupyingStatuses,
  type DomainStatus,
  type TaskProjection,
  type TaskProjectionListQuery,
  type TaskRelationQuery,
  type TaskWipSnapshotEntryV1,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import { readTaskReadSet } from "../../application/src/index.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { requiredPackageDisposition, type TaskQueryReadModel } from "./task-query-read.ts";
import { resolveTaskRootThreshold, resolveTaskWipLimit } from "./task-wip-settings.ts";
import { selectTaskIndex } from "./task-index-query.ts";

export interface TaskQueryCell {
  readonly input: { readonly repoId: string };
  readonly rootDir: string;
  readonly projection: TaskProjection;
  readonly taskListQueryFromAction: (action: RepoTaskAction) => TaskProjectionListQuery;
  readonly relationQueryFromAction: (action: RepoTaskAction) => TaskRelationQuery;
  readonly queryRead: () => TaskQueryReadModel;
  readonly directChildCounts: () => Map<string, number>;
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
    cut?: { readonly status: "ready" | "pending"; readonly watermark: number; readonly sourceRevision: number },
  ) => WriteReceipt;
  readonly cellCodedError: (code: string, message: string) => Error;
  readonly requiredCellText: (value: unknown, name: string) => string;
  readonly wipSnapshotEntries: () => readonly TaskWipSnapshotEntryV1[];
  readonly legacyReviewLint: typeof import("./repo-cell-review-lint.ts").legacyReviewLint;
  readonly projectionReady: (value: { readonly status: string }) => boolean;
  readonly now: () => string;
}

export function listTasks(cell: TaskQueryCell, action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt {
  const query = cell.taskListQueryFromAction(action),
    depth = taskListDepth(action.depth);
  if (depth === null)
    throw cell.cellCodedError(
      "invalid_command",
      "Task list depth must be a positive integer or all; use it with --parent <task-id>.",
    );
  if (depth !== undefined && typeof action.parentTaskId !== "string")
    throw cell.cellCodedError(
      "invalid_command",
      "Task list --depth requires --parent <task-id> so the recursive subtree has one root.",
    );
  const read = cell.projection.readTaskIndex();
  let selected: ReturnType<typeof selectTaskIndex>;
  try {
    selected = selectTaskIndex(
      read.rows.filter((row) => row.packageDisposition === "active"),
      {
        ...(typeof action.parentTaskId === "string" ? { parentTaskId: action.parentTaskId } : {}),
        ...(depth === undefined ? {} : { depth }),
        filters: {
          ...(query.status ? { status: query.status } : {}),
          ...(typeof action.module === "string" ? { module: action.module } : {}),
          ...(typeof action.workKind === "string" ? { workKind: action.workKind } : {}),
          ...(typeof action.riskTier === "string" ? { riskTier: action.riskTier } : {}),
          ...(typeof action.urgency === "string" ? { urgency: action.urgency } : {}),
          ...(typeof action.search === "string" ? { search: action.search } : {}),
          ...(query.updatedAfter ? { updatedAfter: query.updatedAfter } : {}),
          ...(query.updatedBefore ? { updatedBefore: query.updatedBefore } : {}),
        },
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "task list cursor is invalid")
      throw cell.cellCodedError("invalid_command", "Task list cursor is invalid; restart the filtered query.");
    throw error;
  }
  const rootSetting = resolveTaskRootThreshold(cell.rootDir),
    value =
      selected.mode === "tree"
        ? {
            schema: "task-list/v2" as const,
            mode: "tree" as const,
            parentTaskId: action.parentTaskId,
            depth,
            rows: selected.rows,
            count: selected.count,
            warnings: read.warnings,
            ...(selected.page ? { page: selected.page } : {}),
          }
        : {
            schema: "task-list/v2" as const,
            mode: "flat" as const,
            rows: selected.rows.map((row) => {
              const directChildCount = selected.childCounts.get(row.taskId) ?? 0;
              return {
                taskId: row.taskId,
                status: row.status,
                title: row.title,
                pinned: row.pinned,
                module: row.moduleKey ?? "",
                updatedAt: row.updatedAt,
                packagePath: row.packagePath,
                packageDisposition: row.packageDisposition,
                taskClass: row.taskClass,
                rootAssessment: deriveTaskRoot(
                  {
                    taskId: row.taskId,
                    title: row.title,
                    status: row.status,
                    taskClass: row.taskClass,
                    packageDisposition: row.packageDisposition,
                    hasCloseoutEvidence: false,
                    directChildCount,
                  },
                  rootSetting.threshold,
                ),
              };
            }),
            count: selected.rows.length,
            warnings: read.warnings,
            ...(selected.page ? { page: selected.page } : {}),
          };
  const payload = {
      ...value,
      status: read.status,
      watermark: read.watermark,
      sourceRevision: read.sourceRevision,
    },
    receipt = cell.readResult(
      cell.operationId(action, binding, cell.input.repoId, read.sourceRevision),
      payload,
      read.sourceRevision,
      null,
      read,
    );
  return { ...receipt, ...payload } as WriteReceipt;
}

function taskListDepth(value: unknown): number | "all" | undefined | null {
  if (value === undefined) return undefined;
  if (value === "all") return value;
  const depth = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(depth) || depth < 1) return null;
  return depth;
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
  const tasks = cell.wipSnapshotEntries(),
    activating = tasks.find((task: TaskWipSnapshotEntryV1) => task.taskId === taskId);
  if (!activating) return;
  const allowed =
      nextStatus === "blocked"
        ? allowsTaskStatusMove(cell.projection.read(taskId).snapshot, nextStatus)
        : activating.status !== nextStatus && explainStatusTransition(activating.status, nextStatus).allowed,
    setting = resolveTaskWipLimit(cell.rootDir),
    rootSetting = resolveTaskRootThreshold(cell.rootDir),
    admission = admitTaskExecutionWip({
      limit: setting.limit,
      limitLabel: setting.label,
      tasks,
      activatingTaskId: taskId,
      nextStatus: allowed ? nextStatus : activating.status,
      rootThreshold: rootSetting.threshold,
    });
  if (!admission.ok)
    throw cell.cellCodedError(
      admission.code === "TASK_WIP_LIMIT_REACHED" ? "task_wip_limit_reached" : "task_wip_limit_invalid",
      `${admission.message} Root threshold source: ${rootSetting.label}.`,
    );
}

export function wipSnapshotEntries(cell: TaskQueryCell): readonly TaskWipSnapshotEntryV1[] {
  const rows = cell.projection.list().rows,
    childCounts = directChildCountsFrom(rows);
  return rows.map((row) => {
    const task = row.snapshot.task;
    return {
      taskId: row.taskId,
      title: task?.title ?? "",
      status: task?.status ?? "planned",
      taskClass: task?.taskClass ?? "standard",
      packageDisposition: requiredPackageDisposition(row.taskId, task?.packageDisposition),
      hasCloseoutEvidence: hasCloseoutEvidence(row.snapshot.executions),
      directChildCount: childCounts.get(row.taskId) ?? 0,
    };
  });
}

export function directChildCounts(cell: TaskQueryCell): Map<string, number> {
  return directChildCountsFrom(cell.projection.list().rows);
}

function directChildCountsFrom(rows: ReturnType<TaskProjection["list"]>["rows"]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const parentTaskId = row.snapshot.task?.metadata?.parentTaskId;
    if (parentTaskId) counts.set(parentTaskId, (counts.get(parentTaskId) ?? 0) + 1);
  }
  return counts;
}

export function listRelations(cell: TaskQueryCell, action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt {
  const query = cell.relationQueryFromAction(action),
    read = cell.queryRead().relationGraphPage(Object.keys(query).length ? query : { limit: 500 }),
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
    current = cell.projection.read(taskId);
  if (!cell.projectionReady(current) || !current.snapshot.task)
    throw cell.cellCodedError(
      "task_not_found",
      `Run ha task list, choose an existing task id, then retry task read-set.`,
    );
  const derived = readTaskReadSet(cell.projection, taskId);
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
    current = cell.projection.read(taskId);
  if (!cell.projectionReady(current) || !current.snapshot.task || !current.packagePath)
    throw cell.cellCodedError(
      "task_not_found",
      `Run ha task list, choose an existing task id, then retry task review.`,
    );
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
