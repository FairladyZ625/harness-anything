import type { WriteReceiptDraft } from "@harness-anything/kernel";
import type { InboxItem } from "@harness-anything/kernel/internal/domain/inbox.ts";
import type { QueryAction, QueryBinding, QueryOperationPort } from "./query-ports.ts";

const runtimeReportKinds = ["milestone", "blocker", "question", "converged"] as const;
type RuntimeReportKind = (typeof runtimeReportKinds)[number];

const REPORT_PREFIX_PATTERN = /^\[runtime-report:(milestone|blocker|question|converged)\]\s+([\s\S]*)$/u;
export const COLLECT_CHILDREN_LIMIT = 100;
export const COLLECT_INBOX_LIMIT = 100;
export const COLLECT_REPORTS_LIMIT = 100;
export const COLLECT_ARTIFACTS_LIMIT = 32;

export interface RuntimeCollectQueryCell extends QueryOperationPort {
  readonly now: () => string;
}

export function resolveCollectTargetTaskId(
  cell: Pick<RuntimeCollectQueryCell, "projection" | "cellCodedError">,
  action: QueryAction,
): { readonly taskId: string; readonly resolvedFrom: "task" | "session" | "dispatch" } {
  if (typeof action.taskId === "string" && action.taskId.trim().length > 0)
    return { taskId: action.taskId.trim(), resolvedFrom: "task" };
  if (typeof action.runtimeSessionId === "string" && action.runtimeSessionId.trim().length > 0) {
    const sessionId = action.runtimeSessionId.trim(),
      dispatch = cell.projection.readRuntimeDispatch(sessionId),
      session = cell.projection.readRuntimeSession(sessionId),
      taskId = dispatch?.payload.taskId ?? session?.taskBindings[0]?.taskId ?? null;
    if (!taskId)
      throw cell.cellCodedError("entity_not_found", `Runtime session ${sessionId} is not bound to a canonical task.`);
    return { taskId, resolvedFrom: "session" };
  }
  if (typeof action.dispatchId === "string" && action.dispatchId.trim().length > 0) {
    const dispatchId = action.dispatchId.trim(),
      row = cell.projection.readRuntimeDispatchById(dispatchId),
      taskId = row?.event.payload.taskId ?? null;
    if (!taskId)
      throw cell.cellCodedError("entity_not_found", `Runtime dispatch ${dispatchId} is not bound to a canonical task.`);
    return { taskId, resolvedFrom: "dispatch" };
  }
  throw cell.cellCodedError("missing_field", "Specify a taskId, runtimeSessionId, or dispatchId to collect.");
}

function isRuntimeReportKind(value: unknown): value is RuntimeReportKind {
  return typeof value === "string" && (runtimeReportKinds as readonly string[]).includes(value);
}

function isSelfReportInboxItem(item: InboxItem): boolean {
  return item.source === "runtime_report" && item.sourceRef.startsWith("self-report/");
}

function parseReportProgressRow(row: {
  readonly workspaceRevision: number;
  readonly occurredAt: string;
  readonly actor: {
    readonly principal: { readonly personId: string };
    readonly executor: { readonly id: string } | null;
  };
  readonly payload: { readonly executionId: string; readonly text: string };
}) {
  const match = REPORT_PREFIX_PATTERN.exec(row.payload.text.trim());
  return {
    revision: row.workspaceRevision,
    occurredAt: row.occurredAt,
    executionId: row.payload.executionId,
    actorPersonId: row.actor.principal.personId,
    actorExecutorId: row.actor.executor?.id ?? null,
    kind: match ? (match[1] as RuntimeReportKind) : ("progress" as const),
    summary: match ? match[2]!.trim() : row.payload.text.trim(),
  };
}

function parseSelfReportInboxItem(item: InboxItem) {
  return {
    revision: item.revision,
    occurredAt: item.enqueuedAt,
    executionId: item.correlationId ?? "",
    actorPersonId: item.senderPersonId ?? "",
    actorExecutorId: item.agentId,
    kind: isRuntimeReportKind(item.lane) ? item.lane : ("milestone" as const),
    summary: item.summary,
  };
}

/**
 * Pure application query for `ha runtime collect <taskId|sessionId> [--since <rev>]`:
 * Pushes the `--since` revision lower bound into SQL for both `task_progress` and `inbox_item`,
 * returns a consistent replayable prefix `(since, nextSince]`, and advances `nextSince` only to
 * the last enumerated revision when either stream has more updates (never skipping item #101 or
 * status transitions on older items).
 */
export function runRuntimeCollectRead(
  cell: RuntimeCollectQueryCell,
  action: QueryAction,
  binding: QueryBinding,
  options?: {
    readonly resolvedTarget?: { readonly taskId: string; readonly resolvedFrom: "task" | "session" | "dispatch" };
  },
): WriteReceiptDraft {
  const sinceRaw = action.since === undefined ? 0 : Number(action.since);
  if (!Number.isSafeInteger(sinceRaw) || sinceRaw < 0)
    throw cell.cellCodedError("invalid_field", "--since must be a non-negative integer workspace revision.");
  const { taskId, resolvedFrom } = options?.resolvedTarget ?? resolveCollectTargetTaskId(cell, action),
    taskRead = cell.projection.readTaskIndex({ taskIds: [taskId] }),
    task = taskRead.rows[0] ?? null;
  if (!task) throw cell.cellCodedError("task_not_found", `Task ${taskId} does not exist.`);

  const cut = cell.projection.readCut(),
    opId = cell.operationId(action, binding, cell.input.repoId, cut.sourceRevision),
    progressRead = cell.projection.readProgress(taskId, {
      afterRevision: sinceRaw,
      limit: COLLECT_REPORTS_LIMIT + 1,
    }),
    rawProgressRows = progressRead.status === "ready" ? progressRead.rows : [],
    progressHasMore = rawProgressRows.length > COLLECT_REPORTS_LIMIT,
    boundedProgress = rawProgressRows.slice(0, COLLECT_REPORTS_LIMIT),
    inboxRead = cell.projection.readInbox({
      by: "inbox-updates",
      inboxId: `task:${taskId}`,
      afterRevision: sinceRaw,
      limit: COLLECT_INBOX_LIMIT,
    }),
    rawInboxItems = inboxRead.status === "ready" ? inboxRead.items : [],
    inboxHasMore = inboxRead.status === "ready" && inboxRead.nextCursor !== null,
    hasMore = progressHasMore || inboxHasMore,
    progressCutoff =
      progressHasMore && boundedProgress.length > 0
        ? boundedProgress.at(-1)!.workspaceRevision
        : Number.POSITIVE_INFINITY,
    inboxCutoff = inboxHasMore && rawInboxItems.length > 0 ? rawInboxItems.at(-1)!.revision : Number.POSITIVE_INFINITY,
    upperBound = hasMore ? Math.min(progressCutoff, inboxCutoff) : cut.watermark,
    nextSince = Number.isFinite(upperBound) ? upperBound : cut.watermark,
    windowProgress = hasMore ? boundedProgress.filter((row) => row.workspaceRevision <= nextSince) : boundedProgress,
    windowInbox = hasMore ? rawInboxItems.filter((item) => item.revision <= nextSince) : rawInboxItems,
    selfReportItems = windowInbox.filter(isSelfReportInboxItem),
    incomingInboxItems = windowInbox.filter((item) => !isSelfReportInboxItem(item)),
    reports = [...windowProgress.map(parseReportProgressRow), ...selfReportItems.map(parseSelfReportInboxItem)].sort(
      (left, right) => left.revision - right.revision,
    ),
    inbox = incomingInboxItems.map((item) => ({
      itemId: item.itemId,
      source: item.source,
      status: item.status,
      lane: item.lane,
      correlationId: item.correlationId,
      summary: item.summary,
      enqueuedAt: item.enqueuedAt,
      enqueuedRevision: item.enqueuedRevision,
      revision: item.revision,
      completedByDispatchId: item.completedByDispatchId,
    })),
    childrenRead = cell.projection.readTaskIndex({
      parentTaskId: taskId,
      limit: COLLECT_CHILDREN_LIMIT,
    }),
    childRows = childrenRead.status === "ready" ? childrenRead.rows : [],
    childIds = childRows.map((row) => row.taskId),
    latestChildDispatches = childIds.length > 0 ? cell.projection.readLatestRuntimeDispatchesByTaskIds(childIds) : [],
    latestDispatchByTask = new Map(
      latestChildDispatches
        .filter((event) => typeof event.payload.taskId === "string")
        .map((event) => [event.payload.taskId!, event] as const),
    ),
    childDispatchIds = latestChildDispatches.map((event) => event.payload.dispatchId),
    lifecycleRead =
      childDispatchIds.length > 0
        ? cell.projection.readDispatchLifecycle({ by: "dispatch-batch", dispatchIds: childDispatchIds })
        : null,
    lifecycleByDispatch = new Map(
      lifecycleRead && lifecycleRead.status === "ready"
        ? lifecycleRead.rows.map((row) => [row.attempt.dispatchId, row] as const)
        : [],
    ),
    children = childRows.map((row) => {
      const dispatch = latestDispatchByTask.get(row.taskId),
        lifecycle = dispatch ? lifecycleByDispatch.get(dispatch.payload.dispatchId) : undefined;
      return {
        taskId: row.taskId,
        title: row.title,
        status: row.status,
        updatedAt: row.updatedAt,
        latestDispatchId: dispatch?.payload.dispatchId ?? null,
        latestRuntimeSessionId: dispatch?.payload.runtimeSessionId ?? null,
        latestAgentId: dispatch?.payload.agentId ?? null,
        latestPhase: lifecycle?.attempt.phase ?? null,
        latestOutcome: lifecycle?.attempt.outcome ?? null,
        processAlive: lifecycle?.policy.processAlive ?? false,
      };
    }),
    artifactsRead = task.packagePath
      ? cell.projection.readDocuments(`${task.packagePath}/artifacts/`, { limit: COLLECT_ARTIFACTS_LIMIT })
      : null,
    artifacts =
      artifactsRead && artifactsRead.status === "ready"
        ? artifactsRead.documents
            .filter((doc) => doc.retired !== true)
            .map((doc) => ({
              path: doc.path,
              size: doc.size,
              mediaType: doc.mediaType,
              blobSha256: doc.blobSha256,
            }))
        : [],
    activeLease = cell.projection.currentLease(taskId, cell.now()),
    payload = {
      schema: "runtime-collect/v1",
      taskId,
      resolvedFrom,
      since: sinceRaw,
      nextSince,
      hasMore,
      watermark: cut.watermark,
      hasEvents: reports.length > 0 || inbox.length > 0,
      task: {
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        parentTaskId: task.parentTaskId ?? null,
        activeExecutorId: activeLease?.phase === "held" ? (activeLease.actor.executor?.id ?? null) : null,
      },
      reports,
      inbox,
      children,
      artifacts,
    };

  const receipt = cell.readResult(opId, payload, cut.sourceRevision, null);
  return {
    ...receipt,
    summary:
      `runtime-collect ${taskId} (since ${String(sinceRaw)} -> ${String(nextSince)}): ` +
      `${String(reports.length)} report(s), ${String(inbox.length)} inbox item(s), ` +
      `${String(children.length)} child task(s), ${String(artifacts.length)} artifact(s).`,
  } as WriteReceiptDraft;
}
