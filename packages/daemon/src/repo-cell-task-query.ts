import {
  admitTaskExecutionWip,
  allowsTaskStatusMove,
  deriveTaskRoot,
  explainStatusTransition,
  hasCloseoutEvidence,
  isDomainStatus,
  readRelationGraphProjection,
  taskWipOccupyingStatuses,
  type DomainStatus,
  type TaskWipSnapshotEntryV1,
  type WriteReceipt,
} from "../../kernel/src/index.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { resolveTaskRootThreshold, resolveTaskWipLimit } from "./task-wip-settings.ts";

export function listTasks(cell: any, action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt {
  const query = cell.taskListQueryFromAction(action),
    hasPostFilter = ["module", "workKind", "riskTier", "urgency", "parentTaskId", "search"].some(
      (field) => action[field] !== undefined,
    );
  if (hasPostFilter && (query.limit !== undefined || query.cursor !== undefined))
    throw cell.cellCodedError(
      "invalid_command",
      [
        "Task list pagination cannot be combined with module, kind, risk, ",
        "urgency, parent, or search filters; narrow those filters first, then ",
        "page the result.",
      ].join(""),
    );
  const read = cell.queryRead.guiTasks(query),
    rootSetting = resolveTaskRootThreshold(cell.rootDir),
    childCounts = cell.directChildCounts(),
    search = typeof action.search === "string" ? action.search.toLocaleLowerCase() : null;
  const rows = read.rows.filter((row: any) => {
    const task = row.snapshot.task,
      metadata = task?.metadata;
    return (
      (!action.status || task?.status === action.status) &&
      (!action.module ||
        metadata?.moduleKey === action.module ||
        row.placement.moduleKeys.includes(String(action.module))) &&
      (!action.workKind || metadata?.workKind === action.workKind) &&
      (!action.riskTier || metadata?.riskTier === action.riskTier) &&
      (!action.urgency || metadata?.urgency === action.urgency) &&
      (!action.parentTaskId ||
        metadata?.parentTaskId === action.parentTaskId ||
        row.placement.parentTaskId === action.parentTaskId) &&
      (!search || `${row.taskId}\n${task?.title ?? ""}`.toLocaleLowerCase().includes(search))
    );
  });
  return cell.readResult(
    cell.operationId(action, binding, cell.input.repoId, read.sourceRevision),
    {
      rows: rows.map((row: any) => {
        const task = row.snapshot.task,
          directChildCount = childCounts.get(row.taskId) ?? 0,
          rootAssessment = task
            ? deriveTaskRoot(
                {
                  taskId: row.taskId,
                  title: task.title,
                  status: task.status,
                  taskClass: task.taskClass,
                  packageDisposition: task.packageDisposition ?? "active",
                  hasCloseoutEvidence: hasCloseoutEvidence(row.snapshot.executions),
                  directChildCount,
                },
                rootSetting.threshold,
              )
            : null;
        return {
          taskId: row.taskId,
          status: task?.status ?? "unknown",
          title: task?.title ?? "",
          module: task?.metadata?.moduleKey ?? "",
          updatedAt: row.updatedAt,
          packagePath: row.packagePath,
          packageDisposition: row.placement.packageDisposition,
          taskClass: task?.taskClass ?? "unknown",
          rootAssessment,
        };
      }),
      count: rows.length,
      warnings: read.warnings,
      ...(read.page ? { page: read.page } : {}),
    },
    read.sourceRevision,
    null,
  );
}

export function taskWipEnteringAction(
  cell: any,
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

export function assertTaskWipCapacity(cell: any, taskId: string, nextStatus: DomainStatus): void {
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

export function wipSnapshotEntries(cell: any): readonly TaskWipSnapshotEntryV1[] {
  const l2 = new Map(
      readRelationGraphProjection({ rootDir: cell.rootDir }).taskRows.map((row) => [
        row.taskId,
        row.packageDisposition,
      ]),
    ),
    childCounts = cell.directChildCounts();
  return cell.projection.list().rows.map((row: any) => {
    const task = row.snapshot.task;
    return {
      taskId: row.taskId,
      title: task?.title ?? "",
      status: task?.status ?? "planned",
      taskClass: task?.taskClass ?? "standard",
      packageDisposition: task?.packageDisposition ?? l2.get(row.taskId) ?? "active",
      hasCloseoutEvidence: hasCloseoutEvidence(row.snapshot.executions),
      directChildCount: childCounts.get(row.taskId) ?? 0,
    };
  });
}

export function directChildCounts(cell: any): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of cell.projection.list().rows) {
    const parentTaskId = row.snapshot.task?.metadata?.parentTaskId;
    if (parentTaskId) counts.set(parentTaskId, (counts.get(parentTaskId) ?? 0) + 1);
  }
  return counts;
}

export function listRelations(cell: any, action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt {
  const query = cell.relationQueryFromAction(action),
    read = Object.keys(query).length ? cell.queryRead.relationGraphPage(query) : cell.queryRead.relationGraph(),
    rows = read.edges.filter(
      (edge: any) =>
        (!action.entity || edge.sourceRef === action.entity || edge.targetRef === action.entity) &&
        (!action.source || edge.sourceRef === action.source) &&
        (!action.target || edge.targetRef === action.target) &&
        (!action.relationType || edge.relationType === action.relationType) &&
        (!action.state || edge.state === action.state),
    );
  return cell.readResult(
    cell.operationId(action, binding, cell.input.repoId, cell.store.readHead()?.revision ?? 0),
    {
      rows,
      count: rows.length,
      warnings: read.warnings,
      ...(read.page ? { page: read.page } : {}),
    },
    cell.store.readHead()?.revision ?? 0,
    null,
  );
}

export function reviewTask(cell: any, action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt {
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
      nextAction: report.valid
        ? `Use ha task review-execution ${taskId} for typed approval.`
        : `Repair ${current.packagePath}/review.md, then rerun ha task review ${taskId}.`,
    },
    current.sourceRevision,
    null,
  );
}
