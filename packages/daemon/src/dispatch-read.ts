import {
  consumeKnownError,
  runtimeSessionOutcomeFromEvidence,
  type AgentRuntimeEventV1,
  type RuntimeSession,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import {
  readDispatchStreamSummary,
  type RuntimeMetrics,
  type DispatchProcessState,
  type DispatchTerminalOutcome,
} from "./dispatch-stream.ts";
import type {
  DaemonTaskDispatchesPayload,
  DaemonTaskDispatchesResult,
  TaskDispatchRow,
} from "./protocol/daemon-protocol.contract.ts";
import { runtimePidIsAlive } from "./runtime-process-liveness.ts";
import { projectedTaskNotFound } from "./projection-readiness.ts";
import type { AgentRuntimeAttemptChainDto } from "./runtime-attempt-contract.ts";
import { runtimeResumeAdmission } from "./runtime-resume-admission.ts";

type DispatchEvent = Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }>;
type DispatchQueries = Pick<
  TaskProjectionQueries,
  | "read"
  | "readDocument"
  | "readRuntimeSessionEvents"
  | "readRuntimeDispatchByResumeSource"
  | "readRuntimeDispatchesByAttemptGroup"
>;

export interface RuntimeSessionActivityEvidence {
  readonly lastObservedAt: string;
  readonly workerHostAlive: boolean;
  readonly process: DispatchProcessState | null;
  readonly terminalOutcome: DispatchTerminalOutcome | null;
  /** Latest dispatch-stream metrics for the session's dispatch; null until the worker emits them. */
  readonly runtimeMetrics: RuntimeMetrics | null;
}

export function readRuntimeSessionActivityEvidence(
  rootDir: string,
  dispatchId: string,
): RuntimeSessionActivityEvidence | undefined {
  if (!/^dispatch_[a-f0-9]{24}$/u.test(dispatchId)) return undefined;
  const stream = readDispatchStreamSummary(rootDir, dispatchId);
  if (!stream) return undefined;
  return {
    lastObservedAt: stream.lastObservedAt,
    workerHostAlive: stream.process?.exited === false && runtimePidIsAlive(stream.process.pid),
    runtimeMetrics: stream.runtimeMetrics,
    process: stream.process,
    terminalOutcome: stream.terminalOutcome,
  };
}

/** Repository dispatch reads consume only canonical queries; local activity has its separate reader above. */
export function readTaskDispatches(
  input: { readonly projection: TaskProjectionQueries } & DaemonTaskDispatchesPayload,
): DaemonTaskDispatchesResult {
  const { projection } = input,
    singleTaskId = input.taskId,
    batch = projection.readTaskRuntimeBatch(
      singleTaskId === undefined
        ? {
            taskIds: input.taskIds,
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          }
        : { taskIds: [singleTaskId] },
    );
  if (singleTaskId !== undefined) {
    const notFound = projectedTaskNotFound(projection.read(singleTaskId), singleTaskId);
    if (notFound !== null) throw notFound;
  }
  const rows = new Map<string, TaskDispatchRow>(),
    tasks = new Set(batch.taskIds),
    sessions = new Map(
      batch.rows.flatMap((task) => task.sessions.map((session) => [session.runtimeSessionId, session] as const)),
    );
  if (
    singleTaskId !== undefined &&
    batch.status === "ready" &&
    !batch.rows.find((row) => row.taskId === singleTaskId)?.packagePath
  )
    throw Object.assign(new Error(`Task ${singleTaskId} has no projected package.`), { code: "task_not_found" });
  for (const event of projection.readRuntimeDispatches())
    if (event.payload.taskId && tasks.has(event.payload.taskId))
      rows.set(
        event.payload.dispatchId,
        canonicalDispatchRow(projection, event, sessions.get(event.payload.runtimeSessionId)),
      );
  const dispatches = [...rows.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
    resumed = new Map(dispatches.flatMap((row) => (row.nextDispatchId ? [[row.dispatchId, row.nextDispatchId]] : []))),
    terminal = taskDispatchesOutcome(dispatches, resumed);
  return {
    ok: true,
    status: batch.status,
    dispatches,
    outcome: terminal.outcome,
    exitCode: terminal.exitCode,
    watermark: batch.watermark,
    sourceRevision: batch.sourceRevision,
    ...(singleTaskId === undefined
      ? {
          taskIds: batch.taskIds,
          unavailableTaskIds: batch.taskIds.filter(
            (taskId) => !batch.rows.some((row) => row.taskId === taskId && row.packagePath),
          ),
          page: batch.page,
        }
      : { taskId: singleTaskId }),
  };
}

/** The aggregate terminal verdict for a task's dispatch list, computed once beside the rows so
 * transports render it instead of re-deriving outcome semantics per caller. A still-dispatched
 * fallback attempt is not a verdict; its successor row is. */
export function taskDispatchesOutcome(
  dispatches: readonly TaskDispatchRow[],
  resumedDispatches: ReadonlyMap<string, string>,
): {
  readonly outcome: "succeeded" | "failed" | "cancelled" | "unknown";
  readonly exitCode: number;
} {
  const finalRows = dispatches.filter(
      (row) => row.fallbackState !== "dispatched" && !resumedDispatches.has(row.dispatchId),
    ),
    unsettled =
      finalRows.length === 0 ||
      finalRows.some((row) => !["succeeded", "failed", "cancelled", "lost", "unknown"].includes(row.status)),
    outcome =
      unsettled || finalRows.some((row) => row.status === "lost" || row.status === "unknown")
        ? "unknown"
        : finalRows.some((row) => row.status === "failed")
          ? "failed"
          : finalRows.some((row) => row.status === "cancelled")
            ? "cancelled"
            : "succeeded";
  return { outcome, exitCode: unsettled || outcome === "succeeded" ? 0 : 1 };
}

/** Terminal verdict for one dispatch row as the await surface sees it: a still-scheduled or
 * still-dispatched fallback attempt keeps waiting on its successor row, and a just-exited
 * process is terminal only once its outcome event has been projected (status+outcome unknown). */
export function taskDispatchRowSettled(row: TaskDispatchRow, dispatchIds: readonly string[]): boolean {
  if (row.fallbackState === "scheduled") return false;
  if (row.fallbackState === "dispatched" && (row.nextDispatchId === null || !dispatchIds.includes(row.nextDispatchId)))
    return false;
  if (row.status === "succeeded" || row.status === "failed" || row.status === "cancelled" || row.status === "lost")
    return true;
  return row.status === "unknown" && row.outcome === "unknown";
}

/** A dispatch list is settled when every row reached its own terminal verdict. */
export function taskDispatchRowsSettled(rows: readonly TaskDispatchRow[]): boolean {
  const dispatchIds = rows.map((row) => row.dispatchId);
  return rows.every((row) => taskDispatchRowSettled(row, dispatchIds));
}

export function readTaskDispatchSession(
  projection: Pick<TaskProjectionQueries, "readRuntimeDispatchById">,
  taskId: string,
  dispatchId: string,
): { readonly runtimeSessionId: string } | null {
  const event = projection.readRuntimeDispatchById(dispatchId)?.event;
  return event?.payload.taskId === taskId ? { runtimeSessionId: event.payload.runtimeSessionId } : null;
}

export function readTaskLineageDispatches(input: {
  readonly projection: TaskProjectionQueries;
  readonly taskId: string;
}): readonly TaskDispatchRow[] {
  const taskIds: string[] = [],
    visited = new Set<string>();
  let candidate: string | null = input.taskId;
  while (candidate !== null && !visited.has(candidate)) {
    taskIds.push(candidate);
    visited.add(candidate);
    candidate = input.projection.read(candidate).snapshot.task?.metadata?.parentTaskId ?? null;
  }
  const rows: TaskDispatchRow[] = [];
  for (let offset = 0; offset < taskIds.length; offset += 500)
    rows.push(
      ...readTaskDispatches({ projection: input.projection, taskIds: taskIds.slice(offset, offset + 500) }).dispatches,
    );
  return rows.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

export function readSessionGroupDispatches(input: {
  readonly sessions: readonly RuntimeSession[];
  readonly events: readonly DispatchEvent[];
  readonly projection: DispatchQueries;
}): readonly TaskDispatchRow[] {
  const sessions = new Map(input.sessions.map((session) => [session.runtimeSessionId, session]));
  return input.events.map((event) =>
    canonicalDispatchRow(input.projection, event, sessions.get(event.payload.runtimeSessionId)),
  );
}

export function readRuntimeAttemptChain(
  runtimeSessionId: string,
  projection: DispatchQueries & Pick<TaskProjectionQueries, "readRuntimeDispatchesBySession" | "readRuntimeSession">,
): AgentRuntimeAttemptChainDto | undefined {
  const target = projection.readRuntimeDispatchesBySession(runtimeSessionId)[0]?.event;
  if (!target?.payload.attemptGroupId) return undefined;
  const groupId = target.payload.attemptGroupId;
  return {
    attemptGroupId: groupId,
    attempts: projection
      .readRuntimeDispatchesByAttemptGroup(groupId)
      .map(({ event }) =>
        canonicalDispatchRow(
          projection,
          event,
          projection.readRuntimeSession(event.payload.runtimeSessionId) ?? undefined,
        ),
      )
      .map(
        ({
          dispatchId,
          runtimeSessionId,
          attemptIndex,
          provider,
          classification,
          reason,
          resume,
          nextAction,
          fallbackState,
          nextDispatchId,
        }) => ({
          dispatchId,
          runtimeSessionId,
          attemptIndex,
          provider,
          classification,
          reason,
          ...(resume ? { resume } : {}),
          ...(nextAction ? { nextAction } : {}),
          fallbackState,
          nextDispatchId,
        }),
      )
      .sort((a, b) => a.attemptIndex - b.attemptIndex),
  };
}

function canonicalDispatchRow(
  projection: DispatchQueries,
  event: DispatchEvent,
  session: RuntimeSession | undefined,
): TaskDispatchRow {
  const payload = event.payload,
    packagePath = payload.taskId ? projection.read(payload.taskId).packagePath : null,
    documentPath = packagePath ? `${packagePath}/artifacts/dispatches/${payload.dispatchId}.json` : null,
    document = documentPath ? projection.readDocument(documentPath).document : null,
    archive = document ? parseArchive(document.body) : null,
    outcomeEvent = projection
      .readRuntimeSessionEvents(payload.runtimeSessionId, 0, Number.MAX_SAFE_INTEGER)
      .findLast(
        (entry): entry is Extract<AgentRuntimeEventV1, { type: "runtime_session_outcome_observed" }> =>
          entry.schema === "agent-runtime-event/v1" && entry.type === "runtime_session_outcome_observed",
      ),
    metrics = outcomeEvent?.payload.runtimeMetrics,
    groupId = payload.attemptGroupId ?? payload.dispatchId,
    successor =
      projection.readRuntimeDispatchByResumeSource(payload.dispatchId)?.event ??
      projection
        .readRuntimeDispatchesByAttemptGroup(groupId)
        .map((row) => row.event)
        .find((next) => (next.payload.attemptIndex ?? 0) === (payload.attemptIndex ?? 0) + 1),
    resumed = new Map(successor ? [[payload.dispatchId, successor.payload.dispatchId]] : []),
    resultRef = session?.resultRef ?? (typeof archive?.resultRef === "string" ? archive.resultRef : null),
    exitCode = session?.exitCode ?? (typeof archive?.exitCode === "number" ? archive.exitCode : null),
    outcome = runtimeSessionOutcomeFromEvidence({
      outcome: session?.outcome ?? (isOutcome(archive?.outcome) ? archive.outcome : null),
      resultRef,
      exitCode,
      ...(session?.reasonCode ? { reasonCode: session.reasonCode } : {}),
    }),
    classification = isClassification(archive?.classification) ? archive.classification : null,
    providerSessionId =
      session?.providerSessionId ?? (typeof archive?.providerSessionId === "string" ? archive.providerSessionId : null),
    reportPath = packagePath ? `${packagePath}/artifacts/reports/${payload.dispatchId}.md` : null;
  return {
    dispatchId: payload.dispatchId,
    taskId: payload.taskId ?? "",
    executionId: payload.executionId ?? "",
    ...(payload.reviewTarget?.kind === "decision" && payload.reviewTarget.decisionId
      ? {
          reviewTarget: {
            kind: "decision" as const,
            decisionId: payload.reviewTarget.decisionId,
            digest: payload.reviewTarget.digest,
          },
        }
      : payload.reviewTarget?.kind === "task" && payload.reviewTarget.taskId && payload.reviewTarget.executionId
        ? {
            reviewTarget: {
              kind: "task" as const,
              taskId: payload.reviewTarget.taskId,
              executionId: payload.reviewTarget.executionId,
              digest: payload.reviewTarget.digest,
            },
          }
        : {}),
    ...(typeof archive?.parentRuntimeSessionId === "string"
      ? { parentRuntimeSessionId: archive.parentRuntimeSessionId }
      : {}),
    ...(typeof archive?.delegatedByAgentId === "string"
      ? {
          delegatedByAgentId: archive.delegatedByAgentId,
          delegatedByAgentName:
            typeof archive.delegatedByAgentName === "string"
              ? archive.delegatedByAgentName
              : archive.delegatedByAgentId,
        }
      : {}),
    runtimeSessionId: payload.runtimeSessionId,
    instanceId: payload.instanceId,
    attemptGroupId: groupId,
    attemptIndex: payload.attemptIndex ?? 0,
    provider: { instance: payload.instanceId, model: payload.definitionSnapshot?.model ?? null },
    classification,
    reason: typeof archive?.reason === "string" ? archive.reason : null,
    ...resumeDispatch(payload, providerSessionId, resumed, classification),
    fallbackState: successor ? "dispatched" : null,
    nextDispatchId: successor?.payload.dispatchId ?? null,
    ...(metrics ? { metrics: { ...metrics, compacted: null } } : {}),
    ...(payload.agentId ? { agentId: payload.agentId, agentName: payload.agentName ?? payload.agentId } : {}),
    ...(payload.squadId ? { squadId: payload.squadId } : {}),
    providerSessionId,
    eventStreamRef: null,
    startedAt: payload.startedAt ?? event.occurredAt,
    endedAt: outcomeEvent?.payload.endedAt ?? (outcome !== null ? (session?.lastObservedAt ?? event.occurredAt) : null),
    outcome,
    status: outcome ?? (session?.liveness === "live" ? "running" : "unknown"),
    resultRef,
    exitCode,
    ...(documentPath && document ? { dispatchPath: documentPath } : {}),
    ...(reportPath && projection.readDocument(reportPath).document ? { reportPath } : {}),
  };
}

function resumeDispatch(
  dispatch: { readonly dispatchId: string; readonly agentId?: string | null },
  providerSessionId: string | null,
  resumedDispatches: ReadonlyMap<string, string>,
  classification: TaskDispatchRow["classification"],
): Pick<TaskDispatchRow, "resume" | "nextAction"> | undefined {
  const admission = runtimeResumeAdmission({
    dispatchId: dispatch.dispatchId,
    agentId: dispatch.agentId ?? null,
    providerSessionId,
    resumedDispatches,
  });
  if (!admission.resumable) return undefined;
  const resume = { dispatchId: admission.dispatchId, agentId: admission.agentId };
  return {
    resume,
    ...(classification === "provider_quota" ? { nextAction: resumeDispatchAction(resume) } : {}),
  };
}
function resumeDispatchAction(resume: NonNullable<TaskDispatchRow["resume"]>): string {
  return resume.agentId
    ? `ha agent run ${resume.agentId} --resume-dispatch ${resume.dispatchId}`
    : `ha runtime run --resume-dispatch ${resume.dispatchId} --prompt <follow-up>`;
}
function parseArchive(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) && value.schema === "runtime-dispatch/v1" ? value : null;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isOutcome(value: unknown): value is NonNullable<TaskDispatchRow["outcome"]> {
  return value === "succeeded" || value === "failed" || value === "unknown" || value === "cancelled";
}
function isClassification(value: unknown): value is NonNullable<TaskDispatchRow["classification"]> {
  return value === "provider_fault" || value === "provider_quota" || value === "worker_stop" || value === "gate_red";
}
