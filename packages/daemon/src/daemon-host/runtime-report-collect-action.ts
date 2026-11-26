import { randomUUID } from "node:crypto";
import {
  canStartExecution,
  canonicalEventWritePlan,
  compileTaskProgress,
  resolveTaskBoundRuntimeBinding,
  runtimeSessionIdFromActor,
  sha256Text,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import { compileInboxEnqueuedEvent } from "@harness-anything/kernel/internal/domain/agent-runtime-event.ts";
import { INBOX_SUMMARY_LIMIT } from "@harness-anything/kernel/internal/domain/inbox.ts";
import { executionCredentialRejected } from "./runtime-execution-credential.ts";
import { resolveTaskWorkRoot } from "./runtime-coordinator-scope.ts";
import type { RepoCellBinding, RepoCellOperationalContext, RepoTaskAction } from "./repo-cell-types.ts";

export const runtimeReportKinds = ["milestone", "blocker", "question", "converged"] as const;
export type RuntimeReportKind = (typeof runtimeReportKinds)[number];

const REPORT_PREFIX_PATTERN = /^\[runtime-report:(milestone|blocker|question|converged)\]\s+([\s\S]*)$/u;
const COLLECT_CHILDREN_LIMIT = 100;
const COLLECT_INBOX_LIMIT = 100;
const COLLECT_ARTIFACTS_LIMIT = 32;
const collectWaiters = new Map<string, Set<() => void>>();

function collectWaitKey(repoId: string, taskId: string): string {
  return `${repoId}\0${taskId}`;
}

/** Wake any `ha runtime collect --wait-event` waiter subscribed to the affected task(s). */
export function notifyRuntimeCollectWaiters(repoId: string, taskIds: readonly (string | null | undefined)[]): void {
  for (const taskId of taskIds) {
    if (!taskId) continue;
    const key = collectWaitKey(repoId, taskId),
      listeners = collectWaiters.get(key);
    if (!listeners || listeners.size === 0) continue;
    for (const wake of [...listeners]) wake();
  }
}

function subscribeRuntimeCollectWaiter(repoId: string, taskId: string, wake: () => void): () => void {
  const key = collectWaitKey(repoId, taskId);
  let listeners = collectWaiters.get(key);
  if (!listeners) {
    listeners = new Set();
    collectWaiters.set(key, listeners);
  }
  listeners.add(wake);
  return () => {
    const current = collectWaiters.get(key);
    if (!current) return;
    current.delete(wake);
    if (current.size === 0) collectWaiters.delete(key);
  };
}

function isRuntimeReportKind(value: unknown): value is RuntimeReportKind {
  return typeof value === "string" && (runtimeReportKinds as readonly string[]).includes(value);
}

function truncateSummary(text: string, limit = INBOX_SUMMARY_LIMIT): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, Math.max(1, limit - 3)).trimEnd()}...`;
}

/**
 * `ha runtime report --task <id> --kind milestone|blocker|question|converged --summary "..."`:
 * Atomically records structured task progress and enqueues a lightweight notification in the
 * parent inbox (`task:<parentTaskId>` or owner `person:<ownerId>`).
 */
export function runRuntimeReportAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
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
    consumerKind = parentTaskId ? ("unattended_dispatch" as const) : ("interactive_watch" as const),
    at = cell.now(),
    baseRevision = cell.store.readHead()?.revision ?? 0,
    seed = idempotencyKey
      ? `${cell.input.repoId}\0runtime-report\0${taskId}\0${idempotencyKey}`
      : `${cell.input.repoId}\0runtime-report\0${taskId}\0${at}\0${randomUUID()}`,
    itemId = `report_${sha256Text(seed).slice(0, 24)}`,
    dedupeKey = idempotencyKey ? `runtime-report:${taskId}:${idempotencyKey}` : `runtime-report:${itemId}`,
    opId = idempotencyKey
      ? `runtime-report-${sha256Text(`${cell.input.repoId}\0${taskId}\0${idempotencyKey}`).slice(0, 32)}`
      : cell.operationId(action, binding, cell.input.repoId, baseRevision);

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
      } as WriteReceipt;
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
    progressPath = `${taskRead.packagePath}/progress.md`,
    document = cell.projection.readDocument(progressPath);
  if (document.watermark < document.sourceRevision)
    throw cell.cellCodedError("content_not_ready", `Progress projection for ${taskId} is not ready.`);

  const progressRevision = baseRevision + 1,
    inboxRevision = baseRevision + 2,
    formattedProgressText = `[runtime-report:${reportKind}] ${summary}`,
    progressOpId = `${opId}-progress`,
    compiledProgress = compileTaskProgress({
      taskId,
      executionId,
      packagePath: taskRead.packagePath,
      text: formattedProgressText,
      evidence: [],
      currentDocument:
        document.document && document.document.path === progressPath
          ? {
              path: progressPath,
              blobSha256: document.document.blobSha256,
              body: document.document.body,
            }
          : null,
      activeLease: lease,
      startRecoveryAvailable: canStartExecution(recoverySnapshot, recoveryExecutionId),
      ...(runtimeBinding ? { runtimeBinding } : {}),
      asOwner: false,
      taskCreatedBy: task.createdBy,
      taskClass: task.taskClass,
      actor: binding.actor,
      source: binding.source,
      eventId: `event-${sha256Text(progressOpId)}`,
      opId: progressOpId,
      workspaceRevision: progressRevision,
      occurredAt: at,
    });

  const workId = resolveTaskWorkRoot(cell.projection, taskId),
    inboxEvent = compileInboxEnqueuedEvent({
      eventId: `event-${sha256Text(opId)}`,
      workspaceRevision: inboxRevision,
      opId,
      actor: binding.actor,
      source: binding.source,
      occurredAt: at,
      payload: {
        inboxId: parentInboxId,
        itemId,
        source: "runtime_report",
        sourceRef: `task/${taskId}/${reportKind}`,
        sourceEpoch: inboxRevision,
        dedupeKey,
        admission: "dispatchable",
        consumerKind,
        taskId: parentTaskId,
        agentId: null,
        senderPersonId: binding.actor.principal.personId,
        workId,
        lane: reportKind,
        correlationId: taskId,
        minRevision: inboxRevision,
        summary: truncateSummary(`[${reportKind}] ${taskId}: ${summary}`),
        enqueuedAt: at,
      },
    }),
    inboxPlan = canonicalEventWritePlan(inboxEvent, "inbox", parentInboxId);

  const appended = cell.store.append({
    event: inboxEvent,
    plan: inboxPlan,
    blobs: [],
    preceding: [{ event: compiledProgress.event, plan: compiledProgress.plan, blobs: compiledProgress.blobs }],
  });
  cell.projection.apply(compiledProgress.event, compiledProgress.plan);
  cell.projection.apply(inboxEvent, inboxPlan);
  notifyRuntimeCollectWaiters(cell.input.repoId, [taskId, parentTaskId]);

  return {
    outcome: "applied",
    origin: "runtime-report",
    opId,
    taskId,
    reportKind,
    inboxId: parentInboxId,
    inboxItemId: itemId,
    progressPath,
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
      progressRevision: compiledProgress.event.workspaceRevision,
      revision: appended.revision,
    }),
    summary: `runtime-report: [${reportKind}] recorded on ${taskId} and notified ${parentInboxId} (${itemId})`,
  } as WriteReceipt;
}

function resolveCollectTargetTaskId(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
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

/**
 * `ha runtime collect <taskId|sessionId> [--since <rev>] [--wait-event]`:
 * Non-blocking incremental snapshot of structured milestone/report stream, direct child task
 * real-time status table, task inbox notifications, and latest artifact pointers.
 */
export function runRuntimeCollectAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
  const sinceRaw = action.since === undefined ? 0 : Number(action.since);
  if (!Number.isSafeInteger(sinceRaw) || sinceRaw < 0)
    throw cell.cellCodedError("invalid_field", "--since must be a non-negative integer workspace revision.");
  const { taskId, resolvedFrom } = resolveCollectTargetTaskId(cell, action),
    taskRead = cell.projection.read(taskId),
    task = taskRead.snapshot.task;
  if (!task) throw cell.cellCodedError("task_not_found", `Task ${taskId} does not exist.`);

  // Enforce bounded coordinator collect scope: own task or direct child tasks only.
  const principal = binding.executionPrincipal;
  if (principal?.role === "coordinator" && principal.taskId !== null) {
    if (taskId !== principal.taskId && task.metadata?.parentTaskId !== principal.taskId)
      throw executionCredentialRejected("write-other-task", {
        dispatchId: principal.dispatchId,
        role: principal.role,
        detail: `Coordinator collect is limited to own task ${principal.taskId} and its direct children.`,
      });
  }

  const cut = cell.projection.readCut(),
    opId = cell.operationId(action, binding, cell.input.repoId, cut.sourceRevision),
    progressRead = cell.projection.readProgress(taskId),
    reports =
      progressRead.status === "ready"
        ? progressRead.rows.filter((row) => row.workspaceRevision > sinceRaw).map(parseReportProgressRow)
        : [],
    inboxRead = cell.projection.readInbox({
      by: "inbox",
      inboxId: `task:${taskId}`,
      limit: COLLECT_INBOX_LIMIT,
    }),
    inbox =
      inboxRead.status === "ready"
        ? inboxRead.items
            .filter((item) => item.revision > sinceRaw)
            .map((item) => ({
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
            }))
        : [],
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
    artifactsRead = taskRead.packagePath
      ? cell.projection.readDocuments(`${taskRead.packagePath}/artifacts/`, { limit: COLLECT_ARTIFACTS_LIMIT })
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
      nextSince: cut.watermark,
      watermark: cut.watermark,
      hasEvents: reports.length > 0 || inbox.length > 0,
      task: {
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        parentTaskId: task.metadata?.parentTaskId ?? null,
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
      `runtime-collect ${taskId} (since ${String(sinceRaw)} -> ${String(cut.watermark)}): ` +
      `${String(reports.length)} report(s), ${String(inbox.length)} inbox item(s), ` +
      `${String(children.length)} child task(s), ${String(artifacts.length)} artifact(s).`,
  } as WriteReceipt;
}

const WAIT_EVENT_DEFAULT_MS = 30_000;
const WAIT_EVENT_MAX_MS = 60_000;

function collectSnapshotSignature(receipt: WriteReceipt): {
  readonly taskId: string | null;
  readonly hasEvents: boolean;
  readonly childSignature: string;
} {
  try {
    const parsed = JSON.parse(String(receipt.evidence ?? "{}")) as {
      readonly taskId?: string;
      readonly hasEvents?: boolean;
      readonly children?: readonly {
        readonly taskId: string;
        readonly status: string;
        readonly latestPhase?: string | null;
        readonly latestOutcome?: string | null;
      }[];
    };
    const childSignature = (parsed.children ?? [])
      .map((child) => `${child.taskId}:${child.status}:${String(child.latestPhase)}:${String(child.latestOutcome)}`)
      .join("|");
    return {
      taskId: typeof parsed.taskId === "string" ? parsed.taskId : null,
      hasEvents: parsed.hasEvents === true,
      childSignature,
    };
  } catch {
    return { taskId: null, hasEvents: false, childSignature: "" };
  }
}

/**
 * Off-queue waiter for `runtime-collect --wait-event`: subscribes event-driven without holding
 * the repo-cell single-writer lock until a new report, inbox notification, or child transition
 * wakes it (bounded by `timeoutMs`, capped at 60s), never waiting for process exit.
 */
export function executeRuntimeCollectAction<R extends WriteReceipt>(
  repoId: string,
  action: RepoTaskAction,
  initial: R,
  reRead: () => Promise<R>,
  cellCodedError: RepoCellOperationalContext["cellCodedError"],
  signal?: AbortSignal,
): R | Promise<R> {
  if (action.waitEvent !== true) return initial;
  const initialSig = collectSnapshotSignature(initial);
  if (initialSig.hasEvents || initialSig.taskId === null) return initial;
  const rawTimeout = action.timeoutMs === undefined ? WAIT_EVENT_DEFAULT_MS : Number(action.timeoutMs);
  if (!Number.isSafeInteger(rawTimeout) || rawTimeout < 0 || rawTimeout > WAIT_EVENT_MAX_MS)
    throw cellCodedError("invalid_field", "--timeout-ms must be an integer between 0 and 60000.");
  if (rawTimeout === 0 || signal?.aborted) return initial;
  const targetTaskId = initialSig.taskId;
  return new Promise<R>((resolve, reject) => {
    let settled = false,
      checking = false,
      recheckRequested = false;
    const finish = (receipt: R) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      resolve(receipt);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      reject(error);
    };
    const check = () => {
      if (settled) return;
      if (checking) {
        recheckRequested = true;
        return;
      }
      checking = true;
      void reRead()
        .then((latest) => {
          checking = false;
          if (settled) return;
          const sig = collectSnapshotSignature(latest);
          if (sig.hasEvents || sig.childSignature !== initialSig.childSignature) {
            finish(latest);
            return;
          }
          if (recheckRequested) {
            recheckRequested = false;
            check();
          }
        })
        .catch(fail);
    };
    const onAbort = () => finish(initial);
    const unsubscribe = subscribeRuntimeCollectWaiter(repoId, targetTaskId, check);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      void reRead().then(finish, fail);
    }, rawTimeout);
    timer.unref();
    // Re-check once after subscribing so an event committed between initial read and subscribe is never lost.
    check();
  });
}
