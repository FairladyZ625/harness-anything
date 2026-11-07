import {
  consumeKnownError,
  documentWorkspacePath,
  resolveHarnessLayout,
  runtimeSessionOutcomeFromEvidence,
  type AgentRuntimeEventV1,
  type CanonicalSquadRun,
  type DecisionReadSurface,
  type RuntimeSession,
  type TaskProjection,
  type TaskProjectionQueries,
  latestRuntimeActivityAt,
} from "@harness-anything/kernel";
import { readDecisionAnnotationsByDispatch } from "./decision-annotations.ts";
import { readDispatchRuling } from "./runtime-ruling.ts";
import { incidentActionFromRecord } from "./decision-incident-receipt.ts";
import {
  agentRuntimeSessionGroupTotals,
  buildAgentRuntimeSessionGroups,
  latestDispatchStartedAt,
} from "./agent-runtime-session-groups.ts";
import {
  readDispatchStreamSummary,
  type RuntimeMetrics,
  type DispatchProcessState,
  type DispatchProviderReconnect,
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
import { dispatchActivityIdleMinutes, dispatchActivityStatus, providerConnectionFailure } from "./dispatch-activity.ts";
import { cursorStep } from "./paginated-read.ts";
import { isProviderFailureClassification } from "./runtime-fallback-contract.ts";

type DispatchBatchRead = Extract<DaemonTaskDispatchesResult, { readonly taskIds: readonly string[] }>;

/** Internal consumers that need a complete verdict must drain the same public pages. */
export async function readAllTaskDispatchPages(
  readPage: (facets: { readonly cursor?: string }) => Promise<DaemonTaskDispatchesResult>,
): Promise<DispatchBatchRead> {
  const rows = new Map<string, TaskDispatchRow>(),
    taskIds = new Set<string>(),
    unavailable = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined,
    pending = false,
    watermark = Infinity,
    sourceRevision = 0;
  while (true) {
    const result = await readPage(cursor === undefined ? {} : { cursor });
    if (!("page" in result)) throw new Error("Task dispatch batch read returned no page receipt.");
    for (const row of result.dispatches) rows.set(row.dispatchId, row);
    for (const taskId of result.taskIds) taskIds.add(taskId);
    for (const taskId of result.unavailableTaskIds) unavailable.add(taskId);
    pending ||= result.status === "pending";
    watermark = Math.min(watermark, result.watermark);
    sourceRevision = Math.max(sourceRevision, result.sourceRevision);
    const next = cursorStep(result.page, cursors, "task dispatches");
    if (next === undefined) {
      const dispatches = [...rows.values()].sort(
        (left, right) =>
          left.startedAt.localeCompare(right.startedAt) || left.dispatchId.localeCompare(right.dispatchId),
      );
      return {
        ...result,
        dispatches,
        taskIds: [...taskIds],
        unavailableTaskIds: [...unavailable],
        ...taskDispatchesOutcome(
          dispatches,
          new Map(dispatches.flatMap((row) => (row.nextDispatchId ? [[row.dispatchId, row.nextDispatchId]] : []))),
        ),
        status: pending ? "pending" : "ready",
        watermark,
        sourceRevision,
        page: { ...result.page, cursor: null, nextCursor: null },
      };
    }
    cursor = next;
  }
}

type DispatchEvent = Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }>;
type DispatchQueries = Pick<
  TaskProjectionQueries,
  | "read"
  | "readTaskIndex"
  | "readDocument"
  | "readRuntimeSession"
  | "readRuntimeSessionEventsByType"
  | "readRuntimeDispatchesByTaskExecution"
  | "readRuntimeDispatchByResumeSource"
  | "readRuntimeDispatchesByAttemptGroup"
  | "readSquadRun"
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
  /** Last provider or workspace progress; reconnect attempts are excluded. */
  readonly lastProgressAt?: string;
  readonly lastProviderReconnect?: DispatchProviderReconnect | null;
  /** Frozen stall threshold, so every reader judges the same session with the same deadline. */
  readonly stallTimeoutMs?: number;
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
    lastProgressAt: stream.lastProgressAt,
    lastProviderReconnect: stream.lastProviderReconnect,
    ...(stream.header.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: stream.header.stallTimeoutMs }),
  };
}

/** Repository dispatch reads consume only canonical queries; local activity has its separate reader above. */
export function readTaskDispatches(
  input: { readonly projection: TaskProjectionQueries; readonly rootDir?: string } & DaemonTaskDispatchesPayload,
): DaemonTaskDispatchesResult {
  const { projection, rootDir } = input;
  if (input.agentId !== undefined || input.squadId !== undefined) return readMemberTaskDispatches(input);
  if (input.latestOnly === true && input.taskIds !== undefined)
    return readLatestTaskDispatches({ ...input, taskIds: input.taskIds });
  const singleTaskId = input.taskId,
    paged = singleTaskId === undefined && (input.limit !== undefined || input.cursor !== undefined),
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
  const dispatchEvents = tasks.size === 0 ? [] : projection.readRuntimeDispatchesByTaskIds([...tasks]),
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
  const dispatches = [...rows.values()].sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) || (paged ? left.dispatchId.localeCompare(right.dispatchId) : 0),
    ),
    resumed = new Map(dispatches.flatMap((row) => (row.nextDispatchId ? [[row.dispatchId, row.nextDispatchId]] : []))),
    terminal = taskDispatchesOutcome(dispatches, resumed);
  const result: DaemonTaskDispatchesResult = {
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
  return "page" in result && paged ? { ...result, page: { ...result.page, cursor: input.cursor ?? null } } : result;
}

/** The aggregate read: one current dispatch per requested task, never the task's whole history.
 * Fleet overview only shows what each in-flight lease is running now, so its cost is the number
 * of leases, not the number of dispatches those tasks accumulated. Rows are deliberately shallow:
 * the full canonical row re-derives delivered/blocked/relations that this view never renders. */
function readLatestTaskDispatches(input: {
  readonly projection: TaskProjectionQueries;
  readonly taskIds: readonly string[];
}): DispatchBatchRead {
  const { projection } = input,
    taskIds = [...input.taskIds],
    dispatches = projection
      .readLatestRuntimeDispatchesByTaskIds(taskIds)
      .map((event) => {
        const session = projection.readRuntimeSession(event.payload.runtimeSessionId),
          payload = event.payload,
          outcome = session?.outcome ?? null;
        return {
          dispatchId: payload.dispatchId,
          taskId: payload.taskId ?? "",
          taskTitle: undefined,
          executionId: payload.executionId ?? "",
          runtimeSessionId: payload.runtimeSessionId,
          instanceId: payload.instanceId,
          attemptGroupId: payload.attemptGroupId ?? payload.dispatchId,
          attemptIndex: payload.attemptIndex ?? 1,
          provider: {
            instance: payload.definitionSnapshot?.providerId ?? payload.instanceId,
            model: payload.definitionSnapshot?.model ?? null,
          },
          classification: null,
          reason: null,
          fallbackState: null,
          nextDispatchId: null,
          providerSessionId: null,
          eventStreamRef: null,
          startedAt: payload.startedAt ?? event.occurredAt,
          endedAt: null,
          outcome,
          status: outcome ?? (session?.liveness === "live" ? "running" : "unknown"),
          ...(payload.agentId === undefined ? {} : { agentId: payload.agentId }),
          ...(payload.agentName === undefined ? {} : { agentName: payload.agentName }),
          ...(payload.squadId === undefined ? {} : { squadId: payload.squadId }),
          ...(payload.role === undefined ? {} : { role: payload.role }),
          ...(session?.lastObservedAt === undefined ? {} : { lastObservedAt: session.lastObservedAt }),
          ...(session?.resultRef === undefined ? {} : { resultRef: session.resultRef }),
          ...(session?.exitCode === undefined ? {} : { exitCode: session.exitCode }),
        } satisfies TaskDispatchRow;
      })
      .sort(
        (left, right) =>
          left.startedAt.localeCompare(right.startedAt) || left.dispatchId.localeCompare(right.dispatchId),
      ),
    resumed = new Map(dispatches.flatMap((row) => (row.nextDispatchId ? [[row.dispatchId, row.nextDispatchId]] : []))),
    terminal = taskDispatchesOutcome(dispatches, resumed),
    cut = projection.readCut();
  return {
    ok: true,
    status: cut.status,
    dispatches,
    outcome: terminal.outcome,
    exitCode: terminal.exitCode,
    watermark: cut.watermark,
    sourceRevision: cut.sourceRevision,
    taskIds,
    unavailableTaskIds: [],
    page: { limit: taskIds.length, cursor: null, nextCursor: null },
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
  const result: DaemonTaskDispatchesResult = {
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
  return result;
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

/** Terminal verdict for one dispatch row as the await surface sees it. A provider failure is
 * settled only after the fallback stream is exhausted or its successor is projected; a just-exited
 * process is terminal only once its outcome event has been projected. */
export function taskDispatchRowSettled(row: TaskDispatchRow, dispatchIds: readonly string[]): boolean {
  const providerFailureTerminal =
      row.status === "failed" &&
      row.outcome === "failed" &&
      row.classification !== null &&
      isProviderFailureClassification(row.classification),
    successorProjected = row.nextDispatchId !== null && dispatchIds.includes(row.nextDispatchId);
  if (row.fallbackState === "scheduled") return false;
  if (row.fallbackState === "dispatched" && !successorProjected && !providerFailureTerminal) return false;
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

/**
 * Reviewer dispatches bound to exactly one submission cut that have not reached their own terminal
 * verdict: still queued, still running, or still projecting their exit. Consent is the owner's
 * confirmation that this cut's reviews concluded, so any one of these makes that confirmation
 * premature. A dispatch of an earlier cut is not this cut's review, and a cancelled, failed, or
 * stopped one already reached its verdict.
 */
export function unsettledCutReviewDispatches(input: {
  readonly projection: TaskProjectionQueries;
  readonly rootDir?: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly submissionDigest: `sha256:${string}`;
}): readonly TaskDispatchRow[] {
  const events = input.projection
      .readRuntimeDispatchesByTaskExecution(input.taskId, input.executionId)
      .map(({ event }) => event)
      .filter(
        (event) =>
          event.payload.role === "reviewer" &&
          event.payload.reviewTarget?.kind === "task" &&
          event.payload.reviewTarget.digest === input.submissionDigest,
      ),
    sessions = events.flatMap((event) => input.projection.readRuntimeSession(event.payload.runtimeSessionId) ?? []),
    rows = readSessionGroupDispatches({ events, sessions, projection: input.projection, rootDir: input.rootDir }),
    dispatchIds = rows.map((row) => row.dispatchId);
  return rows.filter((row) => !taskDispatchRowSettled(row, dispatchIds));
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
  /**
   * Walk parent tasks too. Defaults to false so submit's automatic attribution only replays a
   * dispatch that provably belongs to this execution; a parent's author cannot be assumed to be
   * the child's author when the child may have been authored outside the ledger.
   */
  readonly includeAncestors?: boolean;
}): readonly TaskDispatchRow[] {
  const taskIds: string[] = [],
    visited = new Set<string>();
  let candidate: string | null = input.taskId;
  while (candidate !== null && !visited.has(candidate)) {
    taskIds.push(candidate);
    visited.add(candidate);
    candidate =
      input.includeAncestors === true
        ? (input.projection.read(candidate).snapshot.task?.metadata?.parentTaskId ?? null)
        : null;
  }
  const rows: TaskDispatchRow[] = [];
  for (let offset = 0; offset < taskIds.length; offset += 500)
    rows.push(
      ...readTaskDispatches({ projection: input.projection, taskIds: taskIds.slice(offset, offset + 500) }).dispatches,
    );
  return rows.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

export interface TaskAuthoringExecutorCandidate {
  readonly runtimeSessionId: string;
  readonly executorId: string;
  readonly agentId: string | undefined;
  readonly dispatchTaskId: string;
  readonly executionId: string;
}

/** The raw and prefixed spellings a declared executor may use for one reviewer session. */
function reviewerIdentityForms(runtimeSessionId: string, agentId: string | undefined): readonly string[] {
  return [runtimeSessionId, `runtime-session:${runtimeSessionId}`, ...(agentId === undefined ? [] : [agentId])];
}

function normalizeDeclaredExecutor(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("agent:") ? trimmed.slice("agent:".length) : trimmed;
}

/**
 * The authoring dispatches `declare-executor` may replay for this cut, split by what they prove.
 * `exact` rows are bound to this execution; `fallback` also includes ancestors for the legacy
 * recovery path. Reviewer dispatches are never candidates: attribution exists to judge reviewer
 * independence, so a review session offered as a candidate would let the reviewer become the author.
 */
export function taskLineageExecutorCandidates(input: {
  readonly projection: TaskProjectionQueries;
  readonly taskId: string;
  readonly executionId?: string;
}): {
  readonly exact: readonly TaskAuthoringExecutorCandidate[];
  readonly fallback: readonly TaskAuthoringExecutorCandidate[];
  readonly reviewerIdentities: ReadonlySet<string>;
} {
  const rows = readTaskLineageDispatches({ ...input, includeAncestors: true }),
    reviewerRows = rows.filter((dispatch) => isReviewerDispatch(input.projection, dispatch.dispatchId)),
    authoringRows = rows.filter((dispatch) => !isReviewerDispatch(input.projection, dispatch.dispatchId)),
    candidate = (dispatch: TaskDispatchRow): TaskAuthoringExecutorCandidate => ({
      runtimeSessionId: dispatch.runtimeSessionId,
      executorId: `runtime-session:${dispatch.runtimeSessionId}`,
      agentId: dispatch.agentId,
      dispatchTaskId: dispatch.taskId,
      executionId: dispatch.executionId,
    }),
    dedupe = (entries: readonly TaskDispatchRow[]): readonly TaskAuthoringExecutorCandidate[] => [
      ...new Map(entries.map((dispatch) => [dispatch.runtimeSessionId, candidate(dispatch)])).values(),
    ];
  return {
    exact: dedupe(
      input.executionId === undefined ? [] : authoringRows.filter((row) => row.executionId === input.executionId),
    ),
    fallback: dedupe(authoringRows),
    reviewerIdentities: new Set(
      reviewerRows.flatMap((dispatch) => reviewerIdentityForms(dispatch.runtimeSessionId, dispatch.agentId)),
    ),
  };
}

export type ExecutorDeclarationSelection =
  | { readonly kind: "replay"; readonly candidate: TaskAuthoringExecutorCandidate }
  | { readonly kind: "external"; readonly executorId: string }
  | { readonly kind: "reviewer-alias"; readonly requested: string }
  | { readonly kind: "choose"; readonly requested: string | undefined; readonly choices: readonly string[] }
  | { readonly kind: "owner-declaration-required" };

/**
 * One decision shared by the writer and its tests. Exact dispatches are authoritative; ancestors
 * are only a fallback when the caller did not name a different agent. An explicit agent that
 * matches no authoring dispatch is an owner declaration, so an unrelated parent dispatch cannot
 * block recording the real external author. Reviewer aliases are rejected before any match.
 */
export function selectExecutorDeclaration(input: {
  readonly requested?: string;
  readonly exact: readonly TaskAuthoringExecutorCandidate[];
  readonly fallback: readonly TaskAuthoringExecutorCandidate[];
  readonly reviewerIdentities: ReadonlySet<string>;
}): ExecutorDeclarationSelection {
  const requested = input.requested === undefined ? undefined : normalizeDeclaredExecutor(input.requested);
  if (requested !== undefined && input.reviewerIdentities.has(requested)) return { kind: "reviewer-alias", requested };
  const search = input.exact.length > 0 ? input.exact : input.fallback,
    matches =
      requested === undefined
        ? search
        : search.filter(
            (candidate) =>
              requested === candidate.executorId ||
              requested === candidate.runtimeSessionId ||
              requested === candidate.agentId,
          );
  if (matches.length === 1) return { kind: "replay", candidate: matches[0]! };
  if (input.exact.length === 0 && requested !== undefined && matches.length === 0)
    return { kind: "external", executorId: requested };
  if (requested !== undefined)
    return { kind: "choose", requested, choices: search.map((candidate) => candidate.executorId) };
  if (search.length === 0) return { kind: "owner-declaration-required" };
  return { kind: "choose", requested: undefined, choices: search.map((candidate) => candidate.executorId) };
}

/** Reviewer identity is canonical in the dispatch event, including rows whose projected role is absent. */
export function isReviewerDispatch(
  projection: Pick<TaskProjectionQueries, "readRuntimeDispatchById">,
  dispatchId: string,
): boolean {
  const payload = projection.readRuntimeDispatchById(dispatchId)?.event.payload;
  return payload?.role === "reviewer" || payload?.reviewTarget !== undefined;
}

export function readSessionGroupDispatches(input: {
  readonly sessions: readonly RuntimeSession[];
  readonly events: readonly DispatchEvent[];
  readonly projection: DispatchQueries;
  readonly rootDir?: string;
  /** Aggregate pages need grouping fields, not the full delivered/blocked dispatch derivation. */
  readonly shallow?: boolean;
}): readonly TaskDispatchRow[] {
  const sessions = new Map(input.sessions.map((session) => [session.runtimeSessionId, session]));
  return input.events.map((event) =>
    input.shallow
      ? shallowSessionGroupRow(event, sessions.get(event.payload.runtimeSessionId))
      : canonicalDispatchRow(input.projection, event, sessions.get(event.payload.runtimeSessionId), input.rootDir),
  );
}

/** Bounded group-row projection: only fields the session-group aggregation renders are filled;
 * delivered/blocked, task snapshot, document and dispatch-stream reads are intentionally absent. */
function shallowSessionGroupRow(event: DispatchEvent, session: RuntimeSession | undefined): TaskDispatchRow {
  const payload = event.payload,
    outcome = session?.outcome ?? null,
    status = outcome ?? (session?.liveness === "live" ? "running" : "unknown");
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
    runtimeSessionId: payload.runtimeSessionId,
    ...(payload.role ? { role: payload.role } : {}),
    instanceId: payload.instanceId,
    attemptGroupId: payload.attemptGroupId ?? payload.dispatchId,
    attemptIndex: payload.attemptIndex ?? 0,
    provider: { instance: payload.instanceId, model: payload.definitionSnapshot?.model ?? null },
    classification: null,
    reason: null,
    fallbackState: null,
    nextDispatchId: null,
    ...(payload.agentId ? { agentId: payload.agentId, agentName: payload.agentName ?? payload.agentId } : {}),
    ...(payload.squadId ? { squadId: payload.squadId } : {}),
    providerSessionId: session?.providerSessionId ?? null,
    eventStreamRef: null,
    startedAt: payload.startedAt ?? event.occurredAt,
    endedAt: outcome === null ? null : (session?.lastObservedAt ?? event.occurredAt),
    outcome,
    status,
    resultRef: session?.resultRef ?? null,
    exitCode: session?.exitCode ?? null,
  };
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

/** Assemble one dispatch row from its canonical event. Callers that selected a single dispatch
 *  use this instead of assembling every dispatch of the task. */
export function readTaskDispatchRow(
  projection: DispatchQueries,
  event: DispatchEvent,
  options: { readonly rootDir?: string; readonly advisorySurface?: DecisionReadSurface } = {},
): TaskDispatchRow {
  const annotations = options.rootDir
    ? readDecisionAnnotationsByDispatch(
        options.rootDir,
        [event.payload.dispatchId],
        options.advisorySurface ?? "task.dispatches",
      )
    : new Map<string, readonly import("./decision-annotations.ts").DecisionAnnotationEntry[]>();
  return canonicalDispatchRow(
    projection,
    event,
    projection.readRuntimeSession(event.payload.runtimeSessionId) ?? undefined,
    options.rootDir,
    annotations.get(event.payload.dispatchId) ?? [],
  );
}

function dispatchStartedAt(event: DispatchEvent): string {
  return event.payload.startedAt ?? event.occurredAt;
}

/** The last dispatch of one execution whose runtime session is one of the given executor ids.
 *  Reads that execution's dispatch events only, then assembles the selected row. */
export function readLastExecutionWorkerDispatch(
  projection: DispatchQueries,
  input: {
    readonly taskId: string;
    readonly executionId: string;
    readonly workerExecutorIds: ReadonlySet<string>;
  },
): TaskDispatchRow | undefined {
  const event = projection
    .readRuntimeDispatchesByTaskExecution(input.taskId, input.executionId)
    .map((row) => row.event)
    .filter((candidate) => input.workerExecutorIds.has(`runtime-session:${candidate.payload.runtimeSessionId}`))
    .sort((left, right) => dispatchStartedAt(left).localeCompare(dispatchStartedAt(right)))
    .at(-1);
  return event === undefined ? undefined : readTaskDispatchRow(projection, event);
}

/** The dispatch a fresh child task was accepted with, resolved from the dispatch events alone. */
export function readTaskAgentDispatch(
  projection: Pick<TaskProjectionQueries, "readRuntimeDispatchesByTaskIds">,
  taskId: string,
  agentId: string,
): { readonly dispatchId: string; readonly runtimeSessionId: string; readonly executionId: string } | null {
  const event = projection
    .readRuntimeDispatchesByTaskIds([taskId])
    .filter((candidate) => candidate.payload.agentId === agentId)
    .sort((left, right) => dispatchStartedAt(left).localeCompare(dispatchStartedAt(right)))[0];
  return event === undefined
    ? null
    : {
        dispatchId: event.payload.dispatchId,
        runtimeSessionId: event.payload.runtimeSessionId,
        executionId: event.payload.executionId ?? "",
      };
}

function canonicalDispatchRow(
  projection: DispatchQueries,
  event: DispatchEvent,
  session: RuntimeSession | undefined,
  rootDir?: string,
  annotations: readonly import("./decision-annotations.ts").DecisionAnnotationEntry[] = [],
): TaskDispatchRow {
  const layout = rootDir ? resolveHarnessLayout(rootDir) : null,
    payload = event.payload,
    taskRead = payload.taskId ? projection.readTaskIndex({ taskIds: [payload.taskId] }).rows[0] : null,
    packagePath = taskRead?.packagePath ?? null,
    // The title rides beside taskId from this one read: a caller labelling the row must never
    // re-join the task through a second listing whose readability rules can differ.
    taskTitle = taskRead?.title,
    documentPath = packagePath ? `${packagePath}/artifacts/dispatches/${payload.dispatchId}.json` : null,
    document = documentPath ? projection.readDocument(documentPath).document : null,
    archive = document ? parseArchive(document.body) : null,
    squadRunId = payload.squadRun?.squadRunId,
    squadChildTaskIds = squadOwnerChildTaskIds(projection, payload),
    outcomeEvent = projection
      .readRuntimeSessionEventsByType(payload.runtimeSessionId, ["runtime_session_outcome_observed"])
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
    decisionAction = dispatchStream?.decisionActionRecord
      ? incidentActionFromRecord(dispatchStream.decisionActionRecord)
      : null,
    ownerEscalation =
      decisionAction !== null && decisionAction.status !== "claimed" && decisionAction.action === "needs_attention"
        ? decisionAction
        : null,
    lastObservedAt = latestRuntimeActivityAt([
      ...(session ? [session.lastObservedAt] : []),
      ...(dispatchStream ? [dispatchStream.lastObservedAt] : []),
    ]),
    activityObservedAt =
      lastObservedAt === "1970-01-01T00:00:00.000Z" ? (payload.startedAt ?? event.occurredAt) : lastObservedAt,
    activityProjectionObservedAt = dispatchStream?.lastProgressAt ?? activityObservedAt,
    status =
      outcome === "stopped" && taskExecutionDelivered(projection, event)
        ? "succeeded"
        : outcome === "stopped" && taskHasStructuredBlock(projection, event)
          ? "blocked"
          : (outcome ?? (session?.liveness === "live" ? "running" : "unknown")),
    // 进程存活信号:派工流里有进程记录才有;无记录是信号缺失(null),不是进程已死。
    processAlive =
      dispatchStream?.process === null || dispatchStream?.process === undefined
        ? null
        : dispatchStream.process.exited === true
          ? false
          : runtimePidIsAlive(dispatchStream.process.pid),
    providerUnreachable =
      dispatchStream === null
        ? session !== null && session !== undefined && session.liveness === "live" && session.outcome === null
          ? (session.providerUnreachable ?? null)
          : null
        : providerConnectionFailure({
            lastProgressAt: dispatchStream.lastProgressAt,
            providerReconnect: dispatchStream.lastProviderReconnect,
            processAlive,
            ...(dispatchStream.header.stallTimeoutMs === undefined
              ? {}
              : { stallTimeoutMs: dispatchStream.header.stallTimeoutMs }),
          }),
    activityStatus = dispatchActivityStatus({
      status,
      taskStatus: taskRead?.status,
      role: payload.role,
      lastObservedAt: activityProjectionObservedAt,
      lastProgressAt: dispatchStream?.lastProgressAt,
      stallTimeoutMs: dispatchStream?.header.stallTimeoutMs,
      stalledAt: dispatchStream?.stalledAt,
      processAlive,
      providerActivity: dispatchStream?.lastProviderActivity?.kind ?? null,
      providerReconnect: dispatchStream?.lastProviderReconnect ?? null,
      reportedProviderUnreachable: dispatchStream === null ? providerUnreachable : null,
    }),
    activityIdleMinutes = dispatchActivityIdleMinutes(activityProjectionObservedAt),
    fallbackReason = dispatchStream?.records.findLast(
      (record) => record.kind === "fallback_state" && typeof record.reason === "string",
    )?.reason,
    // Only a real question earns the awaiting-ruling classification. A guard refusal is CEO
    // handling work, so it reads as needs_attention even though the action is the same.
    classification =
      ownerEscalation !== null
        ? ownerEscalation.attention === "question"
          ? "awaiting_ruling"
          : "needs_attention"
        : (outcomeEvent?.payload.attempt?.classification ??
          (isClassification(archive?.classification) ? archive.classification : null)),
    providerSessionId =
      session?.providerSessionId ?? (typeof archive?.providerSessionId === "string" ? archive.providerSessionId : null),
    reportPath = packagePath ? `${packagePath}/artifacts/reports/${payload.dispatchId}.md` : null;
  return {
    dispatchId: payload.dispatchId,
    taskId: payload.taskId ?? "",
    ...(taskTitle ? { taskTitle } : {}),
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
    ...(payload.role ? { role: payload.role } : {}),
    lastObservedAt: activityObservedAt,
    activityStatus,
    activityObservedAt: activityProjectionObservedAt,
    activityIdleMinutes,
    ...(providerUnreachable === null ? {} : { providerUnreachable }),
    instanceId: payload.instanceId,
    attemptGroupId: groupId,
    attemptIndex: payload.attemptIndex ?? 0,
    provider: { instance: payload.instanceId, model: payload.definitionSnapshot?.model ?? null },
    classification,
    reason:
      ownerEscalation?.reason ??
      (typeof fallbackReason === "string" ? fallbackReason : null) ??
      outcomeEvent?.payload.attempt?.reason ??
      (typeof archive?.reason === "string" ? archive.reason : null),
    ...(outcomeEvent?.payload.attempt?.faultClass ? { faultClass: outcomeEvent.payload.attempt.faultClass } : {}),
    ...(outcomeEvent?.payload.attempt?.resetAt ? { resetAt: outcomeEvent.payload.attempt.resetAt } : {}),
    ...resumeDispatch(payload, providerSessionId, resumed, classification),
    // The canonical successor proves the handoff even if the local stream still says "scheduled".
    fallbackState: successor
      ? "dispatched"
      : (dispatchStream?.fallbackState ?? outcomeEvent?.payload.attempt?.fallbackState ?? null),
    nextDispatchId: successor?.payload.dispatchId ?? null,
    ...(metrics ? { metrics: { ...metrics, compacted: null } } : {}),
    ...(payload.agentId ? { agentId: payload.agentId, agentName: payload.agentName ?? payload.agentId } : {}),
    ...(payload.squadId ? { squadId: payload.squadId } : {}),
    ...(squadRunId === undefined ? {} : { squadRunId }),
    ...(squadChildTaskIds === undefined ? {} : { squadChildTaskIds }),
    providerSessionId,
    // The running edge publishes its transcript ref with the provider binding; a settled edge
    // dispatch also archives the same ref into its dispatch document. Either one survives the
    // center read, where no local stream exists to answer for it.
    eventStreamRef:
      dispatchStream?.header.eventStreamRef ??
      session?.transcriptRef ??
      (typeof archive?.eventStreamRef === "string" ? archive.eventStreamRef : null),
    startedAt: payload.startedAt ?? event.occurredAt,
    endedAt: outcomeEvent?.payload.endedAt ?? (outcome !== null ? (session?.lastObservedAt ?? event.occurredAt) : null),
    outcome,
    status,
    // The artifact is keyed by dispatch id, so its presence means this dispatch wrote the ask. Read
    // it here rather than gating on the settled classification: the question must stay visible even
    // when the stream cut predates the classification.
    ...awaitingRulingFields(projection, payload, rootDir ?? null, layout),
    resultRef,
    exitCode,
    ...(documentPath && document
      ? { dispatchPath: rootDir ? documentWorkspacePath(rootDir, documentPath, layout ?? undefined) : documentPath }
      : {}),
    ...(reportPath && projection.readDocument(reportPath).document
      ? { reportPath: rootDir ? documentWorkspacePath(rootDir, reportPath, layout ?? undefined) : reportPath }
      : {}),
    ...(annotations.length > 0
      ? {
          advisories: annotations.flatMap((entry) =>
            entry.advisory ? [{ ...entry.advisory, evaluatedAt: entry.updatedAt }] : [],
          ),
        }
      : {}),
    // The executed incident disposition rides the dispatch's own durable stream, so it is visible
    // on this canonical row even when the decision annotation store has since evicted the advisory.
    ...(decisionAction === null ? {} : { decisionAction }),
  };
}

/**
 * Join the executing node's own dispatch stream into rows served by the center. The center keeps
 * the canonical identity, task and outcome fields; only the evidence that can exist solely on the
 * node that ran the provider is replaced: the live activity judgment, the progress clock, the
 * process fact and the transcript ref. A row whose stream is not on this node is returned untouched,
 * so a plain center read behaves exactly as before.
 */
export function withLocalDispatchStreamEvidence(
  rows: readonly TaskDispatchRow[],
  input: { readonly rootDir: string; readonly nowMs?: number },
): readonly TaskDispatchRow[] {
  const nowMs = input.nowMs ?? Date.now();
  return rows.map((row) => {
    const stream = readDispatchStreamSummary(input.rootDir, row.dispatchId);
    if (stream === null) return row;
    const eventStreamRef = stream.header.eventStreamRef;
    // A submitted implementation waits on the PR/CI/review path; that canonical judgment outranks
    // any provider frame still trickling in locally.
    if (row.status !== "running" || row.activityStatus === "waiting") return { ...row, eventStreamRef };
    const processAlive =
        stream.process === null || stream.process === undefined
          ? null
          : stream.process.exited === true
            ? false
            : runtimePidIsAlive(stream.process.pid),
      providerUnreachable = providerConnectionFailure({
        lastProgressAt: stream.lastProgressAt,
        providerReconnect: stream.lastProviderReconnect,
        processAlive,
        ...(stream.header.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: stream.header.stallTimeoutMs }),
      }),
      lastObservedAt = latestRuntimeActivityAt([
        ...(row.lastObservedAt === undefined ? [row.startedAt] : [row.lastObservedAt]),
        stream.lastObservedAt,
      ]),
      activityObservedAt = stream.lastProgressAt,
      { providerUnreachable: _reported, ...rest } = row;
    return {
      ...rest,
      eventStreamRef,
      lastObservedAt,
      activityStatus: dispatchActivityStatus(
        {
          status: row.status,
          taskStatus: undefined,
          role: row.role,
          lastObservedAt: activityObservedAt,
          lastProgressAt: stream.lastProgressAt,
          stallTimeoutMs: stream.header.stallTimeoutMs,
          stalledAt: stream.stalledAt,
          processAlive,
          providerActivity: stream.lastProviderActivity?.kind ?? null,
          providerReconnect: stream.lastProviderReconnect ?? null,
          reportedProviderUnreachable: null,
        },
        nowMs,
      ),
      activityObservedAt,
      activityIdleMinutes: dispatchActivityIdleMinutes(activityObservedAt, nowMs),
      ...(providerUnreachable === null ? {} : { providerUnreachable }),
    };
  });
}

/**
 * The initial leader row is the run's owner: its dispatch context names the run itself, whereas
 * worker and later-turn contexts only point back at the owner dispatch. Reading that one run is
 * how the owner row names the child tasks, bounded by the run's own attempts instead of a scan.
 */
function squadOwnerChildTaskIds(
  projection: DispatchQueries,
  payload: DispatchEvent["payload"],
): readonly string[] | undefined {
  const context = payload.squadRun;
  if (context === undefined || !("subject" in context)) return undefined;
  // The projection stores the run state it wrote and validated; `ha squad status` already reads
  // `workerAttempts` from the same row, so following that shape here adds no new assumption.
  const run = projection.readSquadRun(context.squadRunId)?.state as unknown as CanonicalSquadRun | undefined;
  if (run === undefined) return undefined;
  return [
    ...new Set(run.workerAttempts.flatMap((attempt) => (attempt.taskId === null ? [] : [attempt.taskId]))),
  ].sort();
}

/**
 * An awaiting-ruling row carries the worker's question and options so `ha task dispatches` and the
 * agenda surface them without opening the raw provider stream. The artifact stays the single
 * storage; this is the read-side projection of it.
 */
function awaitingRulingFields(
  projection: DispatchQueries,
  dispatch: { readonly taskId?: string; readonly dispatchId: string },
  rootDir: string | null,
  layout: ReturnType<typeof resolveHarnessLayout> | null,
): Pick<TaskDispatchRow, "ruling"> {
  const taskId = dispatch.taskId;
  if (!taskId) return {};
  const packagePath = projection.readTaskIndex({ taskIds: [taskId] }).rows[0]?.packagePath;
  if (typeof packagePath !== "string") return {};
  if (
    readDispatchRuling(
      (relative) => projection.readDocument(relative).document?.body ?? null,
      packagePath,
      `${dispatch.dispatchId}.resolution`,
    )
  )
    return {};
  const ruling = readDispatchRuling(
    (relative) => projection.readDocument(relative).document?.body ?? null,
    packagePath,
    dispatch.dispatchId,
  );
  return ruling === null
    ? {}
    : {
        ruling: {
          question: ruling.question,
          options: ruling.options,
          path: rootDir ? documentWorkspacePath(rootDir, ruling.path, layout ?? undefined) : ruling.path,
        },
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
  return (
    value === "provider_fault" ||
    value === "provider_quota" ||
    value === "worker_stop" ||
    value === "dispatch_stalled" ||
    value === "awaiting_ruling" ||
    value === "needs_attention" ||
    value === "gate_red" ||
    value === "completed_without_final_text"
  );
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
    for (const row of projection.readTaskRuntimeBatch({
      taskIds: taskIds.slice(offset, offset + 500),
      includeSessions: false,
    }).rows)
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
