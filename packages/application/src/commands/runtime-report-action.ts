import { isSameExecution, isSamePerson } from "@harness-anything/kernel/internal/domain/actor-domain-services.ts";
import { canStartExecution } from "@harness-anything/kernel/internal/domain/task-lifecycle-command-transitions.ts";
import {
  isTaskBoundRuntimeWriter,
  resolveTaskBoundRuntimeBinding,
  runtimeSessionIdFromActor,
} from "@harness-anything/kernel/internal/domain/task-bound-runtime-authority.ts";
import { compileInboxEnqueuedEvent } from "@harness-anything/kernel/internal/domain/agent-runtime-event.ts";
import { INBOX_SUMMARY_LIMIT } from "@harness-anything/kernel/internal/domain/inbox.ts";
import { canonicalEventWritePlan } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import { sha256Text, stableStringify } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import type { TaskProjection, WriteReceiptDraft } from "@harness-anything/kernel";
import type { CommandAction, CommandBinding, CommandOperationPort } from "./command-ports.ts";

export const runtimeReportKinds = ["milestone", "blocker", "question", "converged"] as const;
export type RuntimeReportKind = (typeof runtimeReportKinds)[number];

export type RuntimeReportCommandCell = CommandOperationPort;

function isRuntimeReportKind(value: unknown): value is RuntimeReportKind {
  return typeof value === "string" && (runtimeReportKinds as readonly string[]).includes(value);
}

function truncateSummary(text: string, limit = INBOX_SUMMARY_LIMIT): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, Math.max(1, limit - 3)).trimEnd()}...`;
}

function resolveTaskWorkRoot(projection: Pick<TaskProjection, "read">, taskId: string): string | null {
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
 * `ha runtime report --task <id> --kind milestone|blocker|question|converged --summary "..."`:
 * Atomically records a structured O(1) self-report event on `task:<taskId>` and enqueues a
 * bounded notification in the parent inbox (`task:<parentTaskId>` or owner `person:<ownerId>`).
 * Never reads, re-renders, hashes, or rewrites accumulated `progress.md` history (dec_EF5F3820).
 */
export function runRuntimeReportCommand(
  cell: RuntimeReportCommandCell,
  action: CommandAction,
  binding: CommandBinding,
): WriteReceiptDraft {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    reportKind = action.reportKind,
    summary = cell.requiredCellText(action.summary, "summary").trim();
  if (!isRuntimeReportKind(reportKind))
    throw cell.cellCodedError("invalid_field", `reportKind must be one of: ${runtimeReportKinds.join(", ")}.`);
  const taskRead = cell.projection.read(taskId);
  if (taskRead.watermark < taskRead.sourceRevision || !taskRead.snapshot.task || !taskRead.packagePath)
    throw cell.cellCodedError("content_not_ready", `Task ${taskId} is not ready for runtime report.`);

  const task = taskRead.snapshot.task,
    idempotencyKey =
      typeof action.idempotencyKey === "string" && action.idempotencyKey.trim().length > 0
        ? action.idempotencyKey.trim()
        : null,
    parentTaskId = task.metadata?.parentTaskId ?? null,
    ownerPersonId = task.createdBy?.principal.personId ?? binding.actor.principal.personId,
    parentInboxId = parentTaskId ? `task:${parentTaskId}` : `person:${ownerPersonId}`,
    selfInboxId = `task:${taskId}`,
    parentConsumerKind = parentTaskId ? ("unattended_dispatch" as const) : ("interactive_watch" as const),
    at = cell.now(),
    baseRevision = cell.store.readHead()?.revision ?? 0,
    opId = idempotencyKey
      ? `runtime-report-${sha256Text(`${cell.input.repoId}\0${taskId}\0${idempotencyKey}`).slice(0, 32)}`
      : cell.operationId(action, binding, cell.input.repoId, baseRevision),
    seed = idempotencyKey
      ? `${cell.input.repoId}\0runtime-report\0${taskId}\0${idempotencyKey}`
      : `${cell.input.repoId}\0runtime-report\0${taskId}\0${String(baseRevision)}\0${at}\0${opId}`,
    itemId = `report_${sha256Text(seed).slice(0, 24)}`,
    selfReportItemId = `self_${itemId}`,
    dedupeKey = idempotencyKey ? `runtime-report:${taskId}:${idempotencyKey}` : `runtime-report:${itemId}`,
    selfDedupeKey = `self-${dedupeKey}`;

  if (idempotencyKey) {
    const existingRead = cell.projection.readInbox({ by: "dedupe", inboxId: parentInboxId, dedupeKey });
    if (existingRead.status === "ready" && existingRead.items.length > 0) {
      const existing = existingRead.items[0]!;
      return {
        outcome: "no_changes",
        code: "no_changes",
        origin: "runtime-report",
        opId,
        taskId,
        reportKind,
        inboxId: parentInboxId,
        inboxItemId: existing.itemId,
        revision: existing.enqueuedRevision,
        proof: {
          committedRevision: existing.enqueuedRevision,
          appliedCut: existing.enqueuedRevision,
          durable: true,
          canonicalVisible: true,
          worktreeVisible: null,
        },
        visibility: "center",
        evidence: JSON.stringify({
          taskId,
          reportKind,
          summary,
          inboxId: parentInboxId,
          inboxItemId: existing.itemId,
          revision: existing.enqueuedRevision,
          deduplicated: true,
        }),
        summary: `runtime-report: [${reportKind}] already recorded for ${taskId} (${existing.itemId})`,
      } as WriteReceiptDraft;
    }
  }

  const lease = cell.projection.currentLease(taskId, at),
    executionId =
      typeof action.executionId === "string"
        ? action.executionId
        : (lease?.executionId ??
          taskRead.snapshot.executions.findLast((value) => value.iteration === task.iteration)?.executionId ??
          ""),
    recoveryExecutionId =
      lease?.executionId ??
      taskRead.snapshot.executions.find((value) => value.iteration === task.iteration && value.state === "active")
        ?.executionId ??
      "progress-recovery",
    recoverySnapshot = lease?.phase === "orphaned" ? { ...taskRead.snapshot, lease: null } : taskRead.snapshot,
    runtimeSessionId = runtimeSessionIdFromActor(binding.actor),
    runtimeSession = runtimeSessionId === null ? null : cell.projection.readRuntimeSession(runtimeSessionId),
    runtimeBinding = resolveTaskBoundRuntimeBinding(runtimeSession, taskId, executionId),
    workOwner =
      task.taskClass === "work" && task.createdBy !== undefined && isSamePerson(task.createdBy, binding.actor);

  if (lease === null || lease.phase !== "held") {
    if (!workOwner) {
      const recoverable = canStartExecution(recoverySnapshot, recoveryExecutionId);
      throw cell.cellCodedError(
        "progress_lease_required",
        recoverable
          ? `runtime-report requires an active lease on ${taskId}; run ha task start ${taskId}`
          : `runtime-report requires an active lease on ${taskId}.`,
      );
    }
  } else {
    const directHolder = isSameExecution(lease.actor, binding.actor) && runtimeBinding === null,
      runtimeWorker =
        runtimeBinding !== null && isTaskBoundRuntimeWriter(lease, binding.actor, binding.source, runtimeBinding);
    if (
      lease.taskId !== taskId ||
      lease.executionId !== executionId ||
      stableStringify(lease.source) !== stableStringify(binding.source) ||
      (!directHolder && !runtimeWorker)
    )
      throw cell.cellCodedError(
        "progress_lease_mismatch",
        `runtime-report actor does not hold the active lease on ${taskId}.`,
      );
  }

  const workId = resolveTaskWorkRoot(cell.projection, taskId),
    selfRevision = baseRevision + 1,
    parentRevision = baseRevision + 2,
    selfOpId = `${opId}-self`,
    selfEvent = compileInboxEnqueuedEvent({
      eventId: `event-${sha256Text(selfOpId)}`,
      workspaceRevision: selfRevision,
      opId: selfOpId,
      actor: binding.actor,
      source: binding.source,
      occurredAt: at,
      payload: {
        inboxId: selfInboxId,
        itemId: selfReportItemId,
        source: "runtime_report",
        sourceRef: `self-report/${taskId}/${reportKind}`,
        sourceEpoch: selfRevision,
        dedupeKey: selfDedupeKey,
        admission: "dispatchable",
        consumerKind: "interactive_watch",
        taskId,
        agentId: binding.actor.executor?.id ?? null,
        senderPersonId: binding.actor.principal.personId,
        workId,
        lane: reportKind,
        correlationId: executionId || taskId,
        minRevision: selfRevision,
        summary: truncateSummary(summary),
        enqueuedAt: at,
      },
    }),
    selfPlan = canonicalEventWritePlan(selfEvent, "inbox", selfInboxId),
    parentEvent = compileInboxEnqueuedEvent({
      eventId: `event-${sha256Text(opId)}`,
      workspaceRevision: parentRevision,
      opId,
      actor: binding.actor,
      source: binding.source,
      occurredAt: at,
      payload: {
        inboxId: parentInboxId,
        itemId,
        source: "runtime_report",
        sourceRef: `task/${taskId}/${reportKind}`,
        sourceEpoch: parentRevision,
        dedupeKey,
        admission: "dispatchable",
        consumerKind: parentConsumerKind,
        taskId: parentTaskId,
        agentId: null,
        senderPersonId: binding.actor.principal.personId,
        workId,
        lane: reportKind,
        correlationId: taskId,
        minRevision: parentRevision,
        summary: truncateSummary(`[${reportKind}] ${taskId}: ${summary}`),
        enqueuedAt: at,
      },
    }),
    parentPlan = canonicalEventWritePlan(parentEvent, "inbox", parentInboxId);

  const appended = cell.store.append({
    event: parentEvent,
    plan: parentPlan,
    blobs: [],
    preceding: [{ event: selfEvent, plan: selfPlan, blobs: [] }],
  });
  cell.projection.apply(selfEvent, selfPlan);
  cell.projection.apply(parentEvent, parentPlan);

  return {
    outcome: "applied",
    origin: "runtime-report",
    opId,
    taskId,
    reportKind,
    inboxId: parentInboxId,
    inboxItemId: itemId,
    revision: appended.revision,
    proof: {
      committedRevision: appended.revision,
      appliedCut: appended.revision,
      durable: true,
      canonicalVisible: true,
      worktreeVisible: null,
    },
    visibility: "center",
    evidence: JSON.stringify({
      taskId,
      reportKind,
      summary,
      inboxId: parentInboxId,
      inboxItemId: itemId,
      selfReportItemId,
      reportRevision: selfRevision,
      revision: appended.revision,
    }),
    summary: `runtime-report: [${reportKind}] recorded on ${taskId} and notified ${parentInboxId} (${itemId})`,
  } as WriteReceiptDraft;
}
