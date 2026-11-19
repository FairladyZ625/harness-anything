import { decisionEventTypes } from "@harness-anything/kernel/internal/domain/decision-event-types.ts";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import {
  currentExecutionCuts,
  type AgentRuntimeEventV1,
  drainCursorPagesSync,
  isTerminalStatus,
  isDomainStatus,
  parseEntityRef,
  type TaskProjection,
  type TaskProjectionListQuery,
} from "@harness-anything/kernel";
import {
  DEFAULT_DECISION_LIST_PAGE_SIZE,
  type DecisionListFilters,
} from "@harness-anything/kernel/internal/ports/decision-projection-model.ts";
import {
  gateResults,
  isRetiredGateRequirement,
  type CloseoutAssessment,
  type CloseoutProjectionAvailability,
  type CloseoutSnapshot,
} from "@harness-anything/kernel/internal/domain/closeout-readiness.ts";
import { canOverrideGate } from "@harness-anything/kernel/internal/domain/completion-gate-policy.ts";
import type { EventListQuery } from "@harness-anything/kernel/internal/domain/event-list.ts";
import {
  effectiveRepositoryMode,
  matchesCollaboratorScope,
  scopedPersonId,
  taskMatchesCollaboratorScope,
  type CollaboratorScope,
} from "@harness-anything/kernel/internal/domain/collaborator-scope.ts";
import { readAgendaAwaitsPage, type AgendaAwaitsProjection } from "./agenda-awaits-read.ts";
import { readViewerTodos } from "./todo-read.ts";
import { runtimeDispatchStartedAt, sourceNodeReader } from "./runtime-attribution.ts";
import { requireSameProjectionCut } from "./projection-cut.ts";

export type { CollaboratorScope };

export interface CollaboratorViewer extends CollaboratorScope {
  readonly viewerPersonId: string;
}

export function readRepositoryCollaboration(input: {
  readonly mode: "local" | "center" | "edge";
  readonly members: readonly { readonly personId: string }[];
  readonly nodes: readonly { readonly kind: string }[];
}): { readonly effectiveMode: "local" | "center" | "edge" } {
  return {
    effectiveMode: effectiveRepositoryMode(
      input.mode,
      new Set(input.members.map(({ personId }) => personId)).size,
      input.nodes,
    ),
  };
}

/** The host authorizes the optional read-only lens before calling Application. */
export function readPersonalPins(
  projection: Pick<TaskProjection, "listPinnedEntities">,
  { viewerPersonId, scopePersonId }: CollaboratorViewer,
) {
  return projection.listPinnedEntities(scopePersonId ?? viewerPersonId);
}

export type DecisionInvolvement = "all" | "mine" | { readonly personId: string };

export interface CollaboratorDecisionQuery extends DecisionListFilters, CollaboratorScope {
  readonly viewerPersonId?: string;
  readonly involvement?: DecisionInvolvement;
}

function involvementPersonId(query: CollaboratorDecisionQuery): string | undefined {
  return (
    scopedPersonId(query) ??
    (query.involvement === "mine"
      ? query.viewerPersonId
      : typeof query.involvement === "object"
        ? query.involvement.personId
        : undefined)
  );
}

export function readCollaboratorDecisions(
  projection: AgendaAwaitsProjection & Pick<TaskProjection, "listDecisions" | "readEventList">,
  query: CollaboratorDecisionQuery = {},
): ReturnType<TaskProjection["listDecisions"]> {
  const {
      viewerPersonId: _viewer,
      involvement,
      filterNodeId,
      filterPersonId: _person,
      scopePersonId: _scope,
      ...filters
    } = query,
    personId = involvementPersonId(query);
  if (personId === undefined && filterNodeId === undefined && involvement !== "mine")
    return projection.listDecisions(filters);
  const cut = projection.readCut(),
    awaits = new Set<string>();
  if (personId !== undefined)
    for (const page of drainCursorPagesSync(
      (facets) => readAgendaAwaitsPage(projection, { viewerPersonId: personId, ...facets }),
      "decision awaits",
    )) {
      requireSameProjectionCut("decision awaits", [cut, page]);
      for (const { sourceRef } of page.awaitingYou) {
        const ref = parseEntityRef(sourceRef);
        if (ref?.kind === "decision") awaits.add(ref.id);
      }
    }
  const matches = ({ decisionId, proposer }: ReturnType<TaskProjection["listDecisions"]>["decisions"][number]) =>
    (personId === undefined
      ? involvement !== "mine"
      : proposer.principal.personId === personId || awaits.has(decisionId)) &&
    (filterNodeId === undefined ||
      projection.readEventList({
        entity: `decision/${decisionId}`,
        type: decisionEventTypes[0],
        nodeId: filterNodeId,
        limit: storageReadPolicy.defaultValue.pageSizes.one,
      }).rows.length !== 0);
  const decisions: ReturnType<TaskProjection["listDecisions"]>["decisions"][number][] = [];
  const limit = filters.limit ?? (filters.cursor === undefined ? undefined : DEFAULT_DECISION_LIST_PAGE_SIZE);
  let cursor = filters.cursor;
  let result: ReturnType<TaskProjection["listDecisions"]>;
  const visited = new Set(filters.cursor === undefined ? [] : [filters.cursor]);
  do {
    result = projection.listDecisions({
      ...filters,
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit: limit - decisions.length }),
    });
    requireSameProjectionCut("collaborator decisions", [cut, result]);
    decisions.push(...result.decisions.filter(matches));
    cursor = result.page?.nextCursor ?? undefined;
    if (cursor !== undefined) {
      if (visited.has(cursor)) throw new Error("Decision page cursor did not advance.");
      visited.add(cursor);
    }
  } while (cursor !== undefined && limit !== undefined && decisions.length < limit);
  requireSameProjectionCut("collaborator decisions", [cut, projection.readCut()]);
  return {
    ...cut,
    decisions,
    ...(result.page
      ? { page: { ...result.page, limit: limit ?? result.page.limit, cursor: filters.cursor ?? null } }
      : {}),
  };
}

function listScopedTasks(projection: Pick<TaskProjection, "readTaskIndex">, scope: CollaboratorScope) {
  const query: TaskProjectionListQuery = { activePackagesOnly: true, withAttribution: true },
    read = projection.readTaskIndex(query);
  return { ...read, rows: read.rows.filter((task) => taskMatchesCollaboratorScope(scope, task)) };
}

export type CollaboratorTaskScope = Pick<
  CollaboratorDecisionQuery,
  "scopePersonId" | "filterPersonId" | "filterNodeId" | "involvement" | "viewerPersonId"
>;

/** Keep the storage cursor even when the scope excludes every row in this source page. */
export function readCollaboratorTaskPage(
  projection: Pick<TaskProjection, "readTaskIndex">,
  query: TaskProjectionListQuery,
  scope: CollaboratorTaskScope,
) {
  const personId = involvementPersonId(scope),
    read = projection.readTaskIndex({
      ...query,
      limit: query.limit ?? storageReadPolicy.defaultValue.pageSizes.standard,
      withAttribution: true,
    });
  return {
    ...read,
    rows:
      scope.involvement === "mine" && personId === undefined
        ? []
        : read.rows.filter((task) => taskMatchesCollaboratorScope({ ...scope, scopePersonId: personId }, task)),
  };
}

/** A task can still be active while its current execution has an accepted cut and gate receipts. */
export function readAttestationPool<
  Row extends {
    readonly snapshot: CloseoutSnapshot;
    readonly snapshotAvailability: CloseoutProjectionAvailability;
    readonly closeoutAssessment: CloseoutAssessment;
  },
  Page extends { readonly rows: readonly Row[] },
>(page: Page & { readonly rows: readonly Row[] }) {
  return {
    ...page,
    rows: page.rows.flatMap((row) => {
      const { snapshot, snapshotAvailability, closeoutAssessment } = row,
        status = snapshot.task?.status;
      if (status === undefined || !isDomainStatus(status) || isTerminalStatus(status)) return [];
      if (status === "submitted" || status === "in_review" || closeoutAssessment.blocker === "consent") return [row];
      const cuts = currentExecutionCuts(snapshot),
        cut = cuts.length === 1 ? cuts[0] : undefined,
        submission = cut?.submission;
      if (cut === undefined || !submission) return [];
      // The task-level readiness verdict leaves active gates unbound. Evaluate this execution
      // explicitly so the pool displays the actual pass awaiting signoff or recorded failure.
      const gates = gateResults(snapshot, snapshotAvailability, cut.executionId, submission, cut.iteration),
        actionable = gates.some(({ gateId, status }) => {
          const requirement = submission.completionContract?.gates.find((gate) => gate.gateId === gateId),
            manual = requirement?.witness.adapterId === "manual-attest";
          return (
            !isRetiredGateRequirement(gateId, requirement) &&
            (status === "signoff_missing" ||
              (status === "missing" && manual) ||
              canOverrideGate(status, requirement?.allowOverride, manual))
          );
        });
      return actionable ? [{ ...row, closeoutAssessment: { ...closeoutAssessment, gates } }] : [];
    }),
  };
}

export interface SubmittedCloseoutAttentionInput {
  readonly taskId: string;
  readonly title: string;
  readonly completionBlockerCode: string | null;
  readonly completionNextAction: string | null;
  readonly undischargedFactRefs?: readonly string[];
}

export interface SubmittedCloseoutAttention {
  readonly blockerCode: string;
  readonly nextAction: string;
  readonly attentionTitle: string;
  readonly summaryHint: string;
}

export function describeSubmittedCloseoutAttention(input: SubmittedCloseoutAttentionInput): SubmittedCloseoutAttention {
  const uniqueFacts = [...new Set(input.undischargedFactRefs ?? [])],
    blockerCode =
      input.completionBlockerCode ?? (uniqueFacts.length > 0 ? "fact_retirement_undeclared" : "completion_pending"),
    nextAction =
      input.completionBlockerCode !== null && input.completionNextAction !== null
        ? input.completionNextAction
        : uniqueFacts.length > 0
          ? `ha task complete ${input.taskId} ${uniqueFacts.map((factRef) => `--fact-holds "${factRef}:<rationale>"`).join(" ")}`
          : (input.completionNextAction ?? `ha task complete ${input.taskId}`);
  return {
    blockerCode,
    nextAction,
    attentionTitle: `${input.title} — [${blockerCode}] ${nextAction}`,
    summaryHint: `下一步 (${blockerCode}): ${nextAction}`,
  };
}

export function readCollaboratorAgenda(
  projection: Parameters<typeof readCollaboratorDecisions>[0] &
    Pick<TaskProjection, "readTaskIndex" | "listPinnedEntities" | "listEntities">,
  query: Parameters<typeof readAgendaAwaitsPage>[1],
) {
  const personId = query.scopePersonId ?? query.viewerPersonId,
    awaits = readAgendaAwaitsPage(projection, query),
    tasks = listScopedTasks(projection, { ...query, scopePersonId: personId }),
    openTasks = tasks.rows.filter(({ status }) => status !== "done" && status !== "cancelled"),
    decisions = readCollaboratorDecisions(projection, {
      scopePersonId: personId,
      ...(query.filterNodeId === undefined ? {} : { filterNodeId: query.filterNodeId }),
      state: "proposed",
    }),
    pinnedEntities = readPersonalPins(projection, query),
    todos = readViewerTodos(projection, { ...query, viewerPersonId: personId }).filter(({ open }) => open);
  return {
    ...requireSameProjectionCut("collaborator agenda", [awaits, tasks, decisions, projection.readCut()]),
    personId,
    pinnedEntities,
    todos,
    page: awaits.page,
    awaitingYou: awaits.awaitingYou,
    decisions: decisions.decisions,
    tasks: openTasks,
    submittedTasks: openTasks.filter(({ status }) => status === "submitted"),
  };
}

type LiveFloorProjection = Pick<
  TaskProjection,
  "readLatestRuntimeDispatchBySession" | "readRuntimeSessionEventsByType"
>;

export function readCollaboratorLiveFloor(
  projection: LiveFloorProjection & Pick<TaskProjection, "readRuntimeSessions">,
  scope: CollaboratorScope & { readonly startedAtGte?: string } = {},
) {
  return scopedLiveDispatches(projection, projection.readRuntimeSessions({ inFlightOnly: true }), scope);
}

/** Enrich only the sessions from the caller's active overview, with one lookup per ID. */
export function readCollaboratorActiveDispatches(
  projection: LiveFloorProjection & Pick<TaskProjection, "readRuntimeSession">,
  scope: CollaboratorScope,
  runtimeSessionIds: readonly string[],
) {
  const sessions = runtimeSessionIds.flatMap((id) => {
    const session = projection.readRuntimeSession(id);
    return session?.outcome === null ? [session] : [];
  });
  return scopedLiveDispatches(projection, sessions, scope).flatMap(({ session, dispatch }) =>
    dispatch === null ? [] : [{ session, dispatch }],
  );
}

function scopedLiveDispatches(
  projection: LiveFloorProjection,
  sessions: ReturnType<TaskProjection["readRuntimeSessions"]>,
  scope: CollaboratorScope & { readonly startedAtGte?: string },
) {
  const sourceNode = sourceNodeReader(projection);
  return sessions.flatMap((session) => {
    const dispatch = projection.readLatestRuntimeDispatchBySession(session.runtimeSessionId),
      startedAt = dispatch === null ? null : runtimeDispatchStartedAt(dispatch),
      personId = dispatch?.actor.principal.personId ?? null,
      nodeId = sourceNode(dispatch?.source);
    if (scope.startedAtGte !== undefined && (startedAt === null || startedAt < scope.startedAtGte)) return [];
    return matchesCollaboratorScope(scope, [{ personId, nodeId }])
      ? [{ session, dispatch, personId, nodeId, startedAt }]
      : [];
  });
}

/** Start from outcome events, so a dispatch that started before the window can still appear.
 * A bounded newest-first source page avoids reading every task and all of its previous attempts. */
export function readCollaboratorEndedDispatches(
  projection: Pick<
    TaskProjection,
    | "readEventList"
    | "readOperation"
    | "readRuntimeDispatchById"
    | "readLatestRuntimeDispatchBySession"
    | "readRuntimeSessionEventsByType"
  >,
  scope: CollaboratorScope,
  endedSince: string,
  limit: number,
) {
  const page = projection.readEventList({
    type: "runtime_session_outcome_observed",
    after: endedSince,
    limit: storageReadPolicy.defaultValue.pageSizes.standard,
  });
  const sourceNode = sourceNodeReader(projection);
  const matches = new Map<
    string,
    {
      readonly dispatch: NonNullable<ReturnType<TaskProjection["readLatestRuntimeDispatchBySession"]>>;
      readonly endedAt: string;
      readonly outcome: Extract<AgentRuntimeEventV1, { type: "runtime_session_outcome_observed" }>;
    }
  >();
  for (const { opId } of page.rows) {
    const outcome = projection.readOperation(opId)?.event;
    if (outcome?.schema !== "agent-runtime-event/v1" || outcome.type !== "runtime_session_outcome_observed") continue;
    const endedAt = outcome.payload.endedAt ?? outcome.occurredAt;
    if (Date.parse(endedAt) < Date.parse(endedSince)) continue;
    const dispatch =
      outcome.payload.dispatchId === undefined
        ? projection.readLatestRuntimeDispatchBySession(outcome.payload.runtimeSessionId)
        : projection.readRuntimeDispatchById(outcome.payload.dispatchId)?.event;
    if (!dispatch || Date.parse(runtimeDispatchStartedAt(dispatch)) > Date.parse(endedAt)) continue;
    const { dispatchId } = dispatch.payload;
    if (
      matches.has(dispatchId) ||
      !matchesCollaboratorScope(scope, [
        {
          personId: dispatch.actor.principal.personId,
          nodeId: sourceNode(dispatch.source),
        },
      ])
    )
      continue;
    matches.set(dispatchId, { dispatch, endedAt, outcome });
  }
  const rows = [...matches.values()].sort(
    (left, right) =>
      Date.parse(right.endedAt) - Date.parse(left.endedAt) ||
      left.dispatch.payload.dispatchId.localeCompare(right.dispatch.payload.dispatchId),
  );
  return { rows: rows.slice(0, limit), truncated: page.hasMore || rows.length > limit };
}

export function readCollaboratorCadence(
  projection: Pick<TaskProjection, "readEventList">,
  query: EventListQuery & CollaboratorScope,
) {
  const { scopePersonId, filterPersonId, filterNodeId, ...filters } = query,
    personId = scopePersonId ?? filterPersonId;
  return projection.readEventList({
    ...filters,
    ...(personId === undefined ? {} : { actorPersonId: personId }),
    ...(filterNodeId === undefined ? {} : { nodeId: filterNodeId }),
  });
}

export function readCollaboratorEntities(
  projection: Pick<TaskProjection, "listEntities">,
  kind: string,
  scope: CollaboratorScope = {},
) {
  return projection.listEntities(kind, true).filter((row) =>
    matchesCollaboratorScope(scope, [
      {
        personId: row.createdByPersonId ?? null,
        nodeId: row.originNodeId ?? null,
      },
    ]),
  );
}
