import type { CanonicalEventV1, TaskProjection, WriteReceiptDraft as WriteReceipt } from "@harness-anything/kernel";
import { isInboxEvent } from "@harness-anything/kernel/internal/domain/inbox.ts";
import {
  runRuntimeReportCommand,
  runtimeReportKinds,
  type RuntimeReportKind,
} from "@harness-anything/application/internal/commands/runtime-report-action.ts";
import {
  resolveCollectTargetTaskId,
  runRuntimeCollectRead,
} from "@harness-anything/application/internal/queries/runtime-collect-read.ts";
import { executionCredentialRejected } from "./runtime-execution-credential.ts";
import type { RepoCellBinding, RepoCellOperationalContext, RepoTaskAction } from "./repo-cell-types.ts";

export { runtimeReportKinds, type RuntimeReportKind };

const collectWaiters = new Map<string, Set<() => void>>();

function collectWaitKey(repoId: string, taskId: string): string {
  return `${repoId}\0${taskId}`;
}

/** Wake any `ha runtime collect --wait-event` waiter subscribed to the affected task(s). */
export function notifyRuntimeCollectWaiters(repoId: string, taskIds: readonly (string | null | undefined)[]): void {
  const notified = new Set<string>();
  for (const taskId of taskIds) {
    if (!taskId || notified.has(taskId)) continue;
    notified.add(taskId);
    const key = collectWaitKey(repoId, taskId),
      listeners = collectWaiters.get(key);
    if (!listeners || listeners.size === 0) continue;
    for (const wake of [...listeners]) wake();
  }
}

/**
 * Projection commit observer for `--wait-event`: notifies subscribed waiters whenever a committed
 * canonical event changes a task's status, progress, inbox, artifacts, or child runtime lifecycle.
 */
export function observeProjectionCommitForCollectWaiters(
  repoId: string,
  projection: Pick<TaskProjection, "read" | "readRuntimeSession">,
  event: CanonicalEventV1,
): void {
  if (collectWaiters.size === 0) return;
  const affected: (string | null | undefined)[] = [];
  const addTaskAndParent = (taskId: string | null | undefined) => {
    if (!taskId) return;
    affected.push(taskId);
    const parentTaskId = projection.read(taskId).snapshot.task?.metadata?.parentTaskId;
    if (parentTaskId) affected.push(parentTaskId);
  };
  if (event.schema === "task-event/v1" || event.schema === "task-bootstrap-event/v1") {
    addTaskAndParent(event.taskId);
  } else if (event.schema === "task-progress-event/v1") {
    addTaskAndParent(event.payload.taskId);
  } else if (event.schema === "agent-runtime-event/v1") {
    if (isInboxEvent(event)) {
      const inboxId = event.payload.inboxId;
      if (inboxId.startsWith("task:")) affected.push(inboxId.slice("task:".length));
    } else {
      const payload = event.payload as Readonly<Record<string, unknown>>;
      if (typeof payload.taskId === "string") addTaskAndParent(payload.taskId);
      const taskBinding = payload.taskBinding as { readonly taskId?: unknown } | undefined;
      if (typeof taskBinding?.taskId === "string") addTaskAndParent(taskBinding.taskId);
      if (typeof payload.runtimeSessionId === "string") {
        const session = projection.readRuntimeSession(payload.runtimeSessionId);
        for (const bound of session?.taskBindings ?? []) addTaskAndParent(bound.taskId);
      }
    }
  } else if (event.schema === "doc-event/v1") {
    for (const change of event.payload.changes) {
      const match = /^tasks\/(task_[^/-]+)/u.exec(change.path);
      if (match) addTaskAndParent(match[1]);
    }
  }
  if (affected.length > 0) notifyRuntimeCollectWaiters(repoId, affected);
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

/** Daemon request adapter for `runtime-report`; delegates business orchestration to `@harness-anything/application`. */
export function runRuntimeReportAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
  const receipt = runRuntimeReportCommand(cell, action, binding);
  const taskId = typeof action.taskId === "string" && action.taskId.trim().length > 0 ? action.taskId.trim() : null;
  if (taskId) {
    const parentTaskId = cell.projection.read(taskId).snapshot.task?.metadata?.parentTaskId ?? null;
    notifyRuntimeCollectWaiters(cell.input.repoId, [taskId, parentTaskId]);
  }
  return receipt;
}

/** Daemon request adapter for `runtime-collect`; enforces coordinator credential scope and delegates to application query. */
export function runRuntimeCollectAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
  const resolvedTarget = resolveCollectTargetTaskId(cell, action),
    principal = binding.executionPrincipal;
  if (principal?.role === "coordinator" && principal.taskId !== null) {
    const task = cell.projection.readTaskIndex({ taskIds: [resolvedTarget.taskId] }).rows[0] ?? null;
    if (task && resolvedTarget.taskId !== principal.taskId && task.parentTaskId !== principal.taskId)
      throw executionCredentialRejected("write-other-task", {
        dispatchId: principal.dispatchId,
        role: principal.role,
        detail: `Coordinator collect is limited to own task ${principal.taskId} and its direct children.`,
      });
  }
  return runRuntimeCollectRead(cell, action, binding, { resolvedTarget });
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
 * the repo-cell single-writer lock until a committed projection event (new report, inbox write,
 * or child status/lifecycle change) wakes it (bounded by `timeoutMs`, capped at 60s).
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
          if (latest.outcome === "pending") {
            if (recheckRequested) {
              recheckRequested = false;
              check();
            }
            return;
          }
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
