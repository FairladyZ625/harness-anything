import type { TaskProjection } from "@harness-anything/kernel";
import type { RepoTaskAction } from "./repo-cell-types.ts";
import { executionCredentialRejected, type RuntimeExecutionPrincipal } from "./runtime-execution-credential.ts";

/** Own-task write actions admitted for a bounded coordinator credential (same taskId only). */
const coordinatorOwnTaskWriteActions = new Set([
  "task-submit",
  "task-push",
  "task-progress-append",
  "task-artifact-add",
  "task-escalate",
  "task-annotate",
  "task-attest",
  "task-declare-executor",
  "fact-record",
  "runtime-report",
  "doc-conflict-resolve",
  "doc-conflict-discard-local",
  "doc-conflict-overwrite-center",
]);

/** Runtime control actions admitted for a bounded coordinator only against direct child tasks. */
export const coordinatorChildRuntimeActions = new Set([
  "runtime-run",
  "runtime-spawn",
  "runtime-steer",
  "runtime-cancel",
]);

/** Inbox actions admitted for a bounded coordinator only on its own task inbox or parent inbox. */
const coordinatorInboxActions = new Set(["inbox-enqueue", "inbox-read"]);

export type CoordinatorScopeProjection = Pick<TaskProjection, "read" | "readRuntimeSession" | "readRuntimeDispatch"> & {
  readonly readRuntimeDispatchById?: TaskProjection["readRuntimeDispatchById"];
};

/** Walk parentTaskId links to find the work root ancestor for cross-work isolation checks. */
export function resolveTaskWorkRoot(projection: Pick<TaskProjection, "read">, taskId: string): string | null {
  const visited = new Set<string>();
  let currentId: string | null = taskId;
  while (currentId !== null && !visited.has(currentId)) {
    visited.add(currentId);
    const task: ReturnType<TaskProjection["read"]>["snapshot"]["task"] = projection.read(currentId).snapshot.task;
    if (!task) return null;
    const parentId: string | null = task.metadata?.parentTaskId ?? null;
    if (task.taskClass === "work" || parentId === null) return task.taskId;
    currentId = parentId;
  }
  return null;
}

/**
 * Entry-gate check for a `coordinator` principal (before a projection exists).
 * Keeps the whitelist closed to four bounded families and refuses self-approval,
 * missing `--parent`, agent/squad mutation, and `proven_stopped` ruling bypass.
 */
export function requireCoordinatorActionScope(
  principal: RuntimeExecutionPrincipal,
  action: RepoTaskAction,
  hasSelectedDocPaths: boolean,
): void {
  if (principal.taskId === null)
    throw executionCredentialRejected("scope", { dispatchId: principal.dispatchId, role: principal.role });
  // (a) Direct child task creation requires explicit parentTaskId === principal.taskId.
  if (action.kind === "task-create") {
    if (typeof action.parentTaskId === "string" && action.parentTaskId === principal.taskId) return;
    throw executionCredentialRejected("write-other-task", {
      dispatchId: principal.dispatchId,
      role: principal.role,
      detail: `Coordinator dispatches may only create direct child tasks with --parent ${principal.taskId}.`,
    });
  }
  // (b) Runtime control on direct child tasks (projection-verified in writer turn).
  if (coordinatorChildRuntimeActions.has(action.kind)) {
    if (action.kind === "runtime-cancel" && action.ruling !== undefined)
      throw executionCredentialRejected("self-approval", {
        dispatchId: principal.dispatchId,
        role: principal.role,
        detail: "Coordinator dispatches cannot issue owner cancellation rulings or bypass proven_stopped.",
      });
    if (typeof action.taskId === "string" && action.taskId === principal.taskId)
      throw executionCredentialRejected("write-other-task", {
        dispatchId: principal.dispatchId,
        role: principal.role,
        detail: "Coordinator runtime control is limited to direct child tasks, not its own parent task.",
      });
    const hasTarget =
      typeof action.taskId === "string" ||
      typeof action.runtimeSessionId === "string" ||
      typeof action.dispatchId === "string";
    if (hasTarget) return;
    throw executionCredentialRejected("write-other-task", {
      dispatchId: principal.dispatchId,
      role: principal.role,
      detail: "Coordinator runtime control requires a direct child task, runtime session, or dispatch target.",
    });
  }
  // (c) Bounded inbox actions (verified against own task inbox or parent inbox in writer turn).
  if (coordinatorInboxActions.has(action.kind)) return;
  // (d) Own parent task package documents and submit/report/progress.
  if (action.kind === "doc-materialize" || action.kind === "doc-submit") {
    if (hasSelectedDocPaths) return;
    throw executionCredentialRejected("write-other-task", {
      dispatchId: principal.dispatchId,
      role: principal.role,
    });
  }
  if (coordinatorOwnTaskWriteActions.has(action.kind) && action.taskId === principal.taskId) return;
  throw executionCredentialRejected("write-other-task", {
    dispatchId: principal.dispatchId,
    role: principal.role,
  });
}

function resolveRuntimeControlTargetTaskId(
  action: RepoTaskAction,
  projection: CoordinatorScopeProjection,
): string | null {
  if (typeof action.taskId === "string" && action.taskId.length > 0) return action.taskId;
  if (typeof action.runtimeSessionId === "string" && action.runtimeSessionId.length > 0) {
    const dispatchTaskId = projection.readRuntimeDispatch(action.runtimeSessionId)?.payload.taskId ?? null;
    if (dispatchTaskId) return dispatchTaskId;
    return projection.readRuntimeSession(action.runtimeSessionId)?.taskBindings[0]?.taskId ?? null;
  }
  if (typeof action.dispatchId === "string" && action.dispatchId.length > 0) {
    return projection.readRuntimeDispatchById?.(action.dispatchId)?.event.payload.taskId ?? null;
  }
  return null;
}

/** Writer-turn projection-verified enforcement for bounded `coordinator` dispatches. */
export function requireCurrentCoordinatorScope(
  principal: RuntimeExecutionPrincipal,
  action: RepoTaskAction,
  projection: CoordinatorScopeProjection,
): void {
  if (principal.taskId === null)
    throw executionCredentialRejected("scope", { dispatchId: principal.dispatchId, role: principal.role });
  const parentTask = projection.read(principal.taskId).snapshot.task;
  if (!parentTask)
    throw executionCredentialRejected("scope", {
      dispatchId: principal.dispatchId,
      role: principal.role,
      detail: `Coordinator parent task ${principal.taskId} does not exist in the canonical projection.`,
    });
  const parentWorkRoot = resolveTaskWorkRoot(projection, principal.taskId);
  if (action.kind === "task-create") {
    if (action.parentTaskId !== principal.taskId)
      throw executionCredentialRejected("write-other-task", {
        dispatchId: principal.dispatchId,
        role: principal.role,
        detail: `Coordinator task-create requires parentTaskId === ${principal.taskId}.`,
      });
    if (
      typeof action.workId === "string" &&
      action.workId.length > 0 &&
      parentWorkRoot !== null &&
      action.workId !== parentWorkRoot
    )
      throw executionCredentialRejected("write-other-task", {
        dispatchId: principal.dispatchId,
        role: principal.role,
        detail: `Coordinator task-create cannot cross work boundary (${action.workId} !== ${parentWorkRoot}).`,
      });
    return;
  }
  if (coordinatorChildRuntimeActions.has(action.kind)) {
    const targetTaskId = resolveRuntimeControlTargetTaskId(action, projection);
    if (targetTaskId === null || targetTaskId === principal.taskId)
      throw executionCredentialRejected("write-other-task", {
        dispatchId: principal.dispatchId,
        role: principal.role,
        detail: `Coordinator ${action.kind} requires a direct child task of ${principal.taskId}.`,
      });
    const childTask = projection.read(targetTaskId).snapshot.task;
    if (!childTask || childTask.metadata?.parentTaskId !== principal.taskId)
      throw executionCredentialRejected("write-other-task", {
        dispatchId: principal.dispatchId,
        role: principal.role,
        detail: `Task ${targetTaskId} is not a direct child of coordinator task ${principal.taskId}.`,
      });
    const childWorkRoot = resolveTaskWorkRoot(projection, targetTaskId);
    if (parentWorkRoot !== null && childWorkRoot !== null && childWorkRoot !== parentWorkRoot)
      throw executionCredentialRejected("write-other-task", {
        dispatchId: principal.dispatchId,
        role: principal.role,
        detail: `Task ${targetTaskId} belongs to another work (${childWorkRoot} !== ${parentWorkRoot}).`,
      });
    return;
  }
  if (coordinatorInboxActions.has(action.kind)) {
    const ownInbox = `task:${principal.taskId}`,
      parentParentId = parentTask.metadata?.parentTaskId ?? null,
      parentInbox = parentParentId ? `task:${parentParentId}` : `person:${principal.personId}`;
    if (action.inboxId !== ownInbox && action.inboxId !== parentInbox)
      throw executionCredentialRejected("write-other-task", {
        dispatchId: principal.dispatchId,
        role: principal.role,
        detail: `Coordinator inbox access is limited to ${ownInbox} and ${parentInbox}.`,
      });
    return;
  }
}
