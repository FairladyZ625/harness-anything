import {
  consumeKnownError,
  runtimeSessionOutcomeFromEvidence,
  type AgentRuntimeEventV1,
  type RuntimeSession,
  type TaskProjection,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import { readDecisionAnnotationsByDispatch } from "./decision-annotations.ts";
import {
  agentRuntimeSessionGroupTotals,
  buildAgentRuntimeSessionGroups,
  latestDispatchStartedAt,
} from "./agent-runtime-session-groups.ts";
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
  | "readTaskRelationsBySources"
  | "readLeaseIntervals"
  | "readCanonicalEvents"
  | "readEventWitness"
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
  input: { readonly projection: TaskProjectionQueries; readonly rootDir?: string } & DaemonTaskDispatchesPayload,
): DaemonTaskDispatchesResult {
  const { projection, rootDir } = input;
  if (input.agentId !== undefined || input.squadId !== undefined) return readMemberTaskDispatches(input);
  const singleTaskId = input.taskId,
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
  const dispatchEvents = projection
      .readRuntimeDispatches()
      .filter((event) => event.payload.taskId && tasks.has(event.payload.taskId)),
    annotations = rootDir
      ? readDecisionAnnotationsByDispatch(
          rootDir,
          dispatchEvents.map((event) => event.payload.dispatchId),
          input.advisorySurface ?? "task.dispatches",
        )
      : new Map();
  for (const event of dispatchEvents)
    rows.set(
      event.payload.dispatchId,
      canonicalDispatchRow(
        projection,
        event,
        sessions.get(event.payload.runtimeSessionId),
        rootDir,
        annotations.get(event.payload.dispatchId) ?? [],
      ),
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

/** The member-scoped page of `repo.task.dispatches`: an executor's newest dispatch rows, one
 * read bounded by the caller's limit — the first screen never pays for the member's total
 * history. Rows carry the same canonical construction as every other dispatch listing, the
 * groups describe exactly the returned window, and `totals` count the member's full history with
 * the same task-group normalization as the window (bindings, decision review, unattributed). */
function readMemberTaskDispatches(input: {
  readonly projection: TaskProjectionQueries;
  readonly agentId?: string;
  readonly squadId?: string;
  readonly limit: number;
}): DaemonTaskDispatchesResult {
  const member = input.projection.readRuntimeDispatchesByMember({
    ...(input.agentId !== undefined ? { agentId: input.agentId } : { squadId: input.squadId! }),
    limit: input.limit,
  });
  const sessions = member.rows
      .map((event) => input.projection.readRuntimeSession(event.payload.runtimeSessionId))
      .filter((session): session is RuntimeSession => session !== null),
    dispatches = readSessionGroupDispatches({ sessions, events: member.rows, projection: input.projection }),
    cut = input.projection.readCut(),
    taskLabels = runtimeTaskLabels(input.projection, [
      ...new Set(dispatches.flatMap((row) => (row.taskId ? [row.taskId] : []))),
    ]),
    entityNames = new Map<string, ReadonlyMap<string, string>>();
  const entityLabel = (kind: "agent" | "squad", id: string): string | null => {
    if (cut.status !== "ready") return null;
    let names = entityNames.get(kind);
    if (names === undefined) {
      names = latestEntityNames(input.projection.listEntities(kind));
      entityNames.set(kind, names);
    }
    return names.get(id) ?? null;
  };
  const groups = buildAgentRuntimeSessionGroups({
    sessions,
    dispatches,
    dispatchEvents: member.rows,
    dispatchStartedAt: latestDispatchStartedAt(member.rows),
    taskLabels,
    entityLabel,
    query: {
      groupBy: "task",
      since: "1970-01-01T00:00:00.000Z",
      tokens: [],
      agentId: null,
      squadId: null,
      status: [],
      sessionIds: [],
      limit: input.limit,
    },
    cut,
  });
  const resumed = new Map(
      dispatches.flatMap((row) => (row.nextDispatchId ? [[row.dispatchId, row.nextDispatchId]] : [])),
    ),
    terminal = taskDispatchesOutcome(dispatches, resumed);
  return {
    ok: true,
    status: cut.status,
    dispatches,
    outcome: terminal.outcome,
    exitCode: terminal.exitCode,
    watermark: cut.watermark,
    sourceRevision: cut.sourceRevision,
    ...(input.agentId !== undefined ? { agentId: input.agentId } : { squadId: input.squadId! }),
    groups: groups.groups,
    taskLabels: [...taskLabels.entries()].map(([taskId, title]) => ({ taskId, title })),
    totals: agentRuntimeSessionGroupTotals(member.sessions),
    truncated: member.truncated,
  };
}

/** The aggregate terminal verdict for a task's dispatch list, computed once beside the rows so
 * transports render it instead of re-deriving outcome semantics per caller. A still-dispatched
 * fallback attempt is not a verdict; its successor row is. */
export function taskDispatchesOutcome(
  dispatches: readonly TaskDispatchRow[],
  resumedDispatches: ReadonlyMap<string, string>,
): {
  readonly outcome: "succeeded" | "failed" | "cancelled" | "unknown" | "stopped";
  readonly exitCode: number;
} {
  const finalRows = dispatches.filter(
      (row) => row.fallbackState !== "dispatched" && !resumedDispatches.has(row.dispatchId),
    ),
    unsettled =
      finalRows.length === 0 ||
      finalRows.some(
        (row) => !["succeeded", "failed", "cancelled", "stopped", "blocked", "lost", "unknown"].includes(row.status),
      ),
    outcome =
      unsettled || finalRows.some((row) => row.status === "lost" || row.status === "unknown")
        ? "unknown"
        : finalRows.some((row) => row.status === "failed")
          ? "failed"
          : finalRows.some((row) => row.status === "cancelled")
            ? "cancelled"
            : finalRows.some((row) => row.status === "stopped" || row.status === "blocked")
              ? "stopped"
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
  if (
    row.status === "succeeded" ||
    row.status === "failed" ||
    row.status === "cancelled" ||
    row.status === "stopped" ||
    row.status === "blocked" ||
    row.status === "lost"
  )
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

/**
 * One run's dispatch rows read by identity instead of by task: each named dispatch plus the
 * fallback successors it spawned, so a task-less run (a schedule-occurrence Squad) joins exactly
 * its own dispatch history. Terminates on the visited-rows set; fallback chains are linear.
 */
export function readDispatchRowsByIds(input: {
  readonly projection: DispatchQueries & Pick<TaskProjectionQueries, "readRuntimeDispatchById" | "readRuntimeSession">;
  readonly rootDir?: string;
  readonly dispatchIds: readonly string[];
}): readonly TaskDispatchRow[] {
  const rows = new Map<string, TaskDispatchRow>(),
    queue = [...input.dispatchIds];
  while (queue.length > 0) {
    const dispatchId = queue.shift()!;
    if (rows.has(dispatchId)) continue;
    const event = input.projection.readRuntimeDispatchById(dispatchId)?.event;
    if (!event) continue;
    const row = canonicalDispatchRow(
      input.projection,
      event,
      input.projection.readRuntimeSession(event.payload.runtimeSessionId) ?? undefined,
      input.rootDir,
    );
    rows.set(dispatchId, row);
    if (row.nextDispatchId) queue.push(row.nextDispatchId);
  }
  return [...rows.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
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
          faultClass,
          resetAt,
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
          ...(faultClass ? { faultClass } : {}),
          ...(resetAt ? { resetAt } : {}),
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
  rootDir?: string,
  annotations: readonly import("./decision-annotations.ts").DecisionAnnotationEntry[] = [],
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
    dispatchStream = rootDir ? readDispatchStreamSummary(rootDir, payload.dispatchId) : null,
    fallbackReason = dispatchStream?.records.findLast(
      (record) => record.kind === "fallback_state" && typeof record.reason === "string",
    )?.reason,
    classification =
      outcomeEvent?.payload.attempt?.classification ??
      (isClassification(archive?.classification) ? archive.classification : null),
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
    reason:
      (typeof fallbackReason === "string" ? fallbackReason : null) ??
      outcomeEvent?.payload.attempt?.reason ??
      (typeof archive?.reason === "string" ? archive.reason : null),
    ...(outcomeEvent?.payload.attempt?.faultClass ? { faultClass: outcomeEvent.payload.attempt.faultClass } : {}),
    ...(outcomeEvent?.payload.attempt?.resetAt ? { resetAt: outcomeEvent.payload.attempt.resetAt } : {}),
    ...resumeDispatch(payload, providerSessionId, resumed, classification),
    // The event's fallback state describes the state at settlement, when it can still be
    // "scheduled". The dispatch stream is updated to "dispatched" after the successor launches,
    // so prefer that current projection when reading the row later.
    fallbackState:
      dispatchStream?.fallbackState ??
      outcomeEvent?.payload.attempt?.fallbackState ??
      (successor ? "dispatched" : null),
    nextDispatchId: successor?.payload.dispatchId ?? null,
    ...(metrics ? { metrics: { ...metrics, compacted: null } } : {}),
    ...(payload.agentId ? { agentId: payload.agentId, agentName: payload.agentName ?? payload.agentId } : {}),
    ...(payload.squadId ? { squadId: payload.squadId } : {}),
    providerSessionId,
    eventStreamRef: null,
    startedAt: payload.startedAt ?? event.occurredAt,
    endedAt: outcomeEvent?.payload.endedAt ?? (outcome !== null ? (session?.lastObservedAt ?? event.occurredAt) : null),
    outcome,
    status:
      outcome === "stopped" && taskExecutionDelivered(projection, event)
        ? "succeeded"
        : outcome === "stopped" && taskHasStructuredBlock(projection, event)
          ? "blocked"
          : (outcome ?? (session?.liveness === "live" ? "running" : "unknown")),
    resultRef,
    exitCode,
    ...(documentPath && document ? { dispatchPath: documentPath } : {}),
    ...(reportPath && projection.readDocument(reportPath).document ? { reportPath } : {}),
    ...(annotations.length > 0
      ? {
          advisories: annotations.flatMap((entry) =>
            entry.advisory ? [{ ...entry.advisory, evaluatedAt: entry.updatedAt }] : [],
          ),
        }
      : {}),
  };
}

function resumeDispatch(
  dispatch: {
    readonly dispatchId: string;
    readonly agentId?: string | null;
    readonly definitionSnapshot?: { readonly kindId?: string };
  },
  providerSessionId: string | null,
  resumedDispatches: ReadonlyMap<string, string>,
  classification: TaskDispatchRow["classification"],
): Pick<TaskDispatchRow, "resume" | "nextAction"> | undefined {
  const admission = runtimeResumeAdmission({
    dispatchId: dispatch.dispatchId,
    agentId: dispatch.agentId ?? null,
    kindId: dispatch.definitionSnapshot?.kindId ?? null,
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
  return (
    value === "succeeded" || value === "failed" || value === "unknown" || value === "cancelled" || value === "stopped"
  );
}
function isClassification(value: unknown): value is NonNullable<TaskDispatchRow["classification"]> {
  return value === "provider_fault" || value === "provider_quota" || value === "worker_stop" || value === "gate_red";
}

/** A stopped round whose own execution has an accepted submission is delivered. The submit
 * boundary is the sole delivery decision; attribution is per executionId. */
function taskExecutionDelivered(projection: DispatchQueries, dispatch: DispatchEvent): boolean {
  const { taskId, executionId } = dispatch.payload;
  if (!taskId || !executionId) return false;
  const submission = projection
    .read(taskId)
    .snapshot.executions?.find((execution) => execution.executionId === executionId)?.submission;
  return submission != null;
}

/** Task titles for dispatch-row and group labels, batched per 500 task ids. */
export function runtimeTaskLabels(
  projection: Pick<TaskProjection, "readTaskRuntimeBatch">,
  taskIds: readonly string[],
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (let offset = 0; offset < taskIds.length; offset += 500)
    for (const row of projection.readTaskRuntimeBatch({ taskIds: taskIds.slice(offset, offset + 500) }).rows)
      result.set(row.taskId, row.title);
  return result;
}

// getEntity semantics over a full listing: the highest-revision row wins, and only its name
// labels the entity — an unnamed newer row shadows an older named one, matching the point query.
export function latestEntityNames(
  rows: readonly ReturnType<TaskProjection["listEntities"]>[number][],
): ReadonlyMap<string, string> {
  const latest = new Map<string, ReturnType<TaskProjection["listEntities"]>[number]>();
  for (const row of rows) {
    const known = latest.get(row.id);
    if (known === undefined || row.workspaceRevision >= known.workspaceRevision) latest.set(row.id, row);
  }
  const names = new Map<string, string>();
  for (const [id, row] of latest) {
    const name = row.value.name;
    if (typeof name === "string" && name) names.set(id, name);
  }
  return names;
}

/** CH2 (dec_614F7BBB18C8687E7EFC72173D): current task state alone cannot
 * attribute another dispatch's blocker to this worker. Select its lease interval
 * and the canonical blocker write made inside that interval. */
function taskHasStructuredBlock(projection: DispatchQueries, dispatch: DispatchEvent): boolean {
  const { taskId, executionId, runtimeSessionId } = dispatch.payload;
  if (!taskId || !executionId) return false;
  const executorId = `runtime-session:${runtimeSessionId}`,
    leases = projection.readLeaseIntervals(taskId),
    intervals = leases.filter(
      (interval) => interval.executionId === executionId && interval.holder.actor.executor?.id === executorId,
    );
  if (projection.read(taskId).snapshot.task?.status === "blocked")
    for (const interval of intervals) {
      if (interval !== leases.at(-1) || interval.releasedRevision === null) continue;
      const release = projection.readCanonicalEvents(interval.releasedRevision - 1, 1).events[0];
      if (
        release?.schema === "task-event/v1" &&
        release.type === "lease_released" &&
        release.payload.task.status === "blocked" &&
        release.payload.mutation.fields.includes("status")
      )
        return true;
    }
  return projection.readTaskRelationsBySources([`task/${taskId}`], "awaits").rows.some((row) => {
    if (row.state !== "active" || row.sourceRef !== `task/${taskId}` || row.workspaceRevision === null) return false;
    const revision = row.workspaceRevision;
    const interval = intervals.find(
      (lease) =>
        revision >= lease.acquiredRevision && (lease.releasedRevision === null || revision <= lease.releasedRevision),
    );
    if (!interval) return false;
    const write = projection.readEventWitness(revision);
    return write !== null && Date.parse(write.occurredAt) <= Date.parse(interval.leaseExpiresAt);
  });
}
