import { decisionEventTypes } from "@harness-anything/kernel/internal/domain/decision-event-types.ts";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import {
  drainCursorPagesSync,
  parseEntityRef,
  type TaskProjection,
  type TaskProjectionListQuery,
} from "@harness-anything/kernel";
import {
  DEFAULT_DECISION_LIST_PAGE_SIZE,
  type DecisionListFilters,
} from "@harness-anything/kernel/internal/ports/decision-projection-model.ts";
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

export function readAttestationPool(
  projection: Parameters<typeof readCollaboratorDecisions>[0] & Pick<TaskProjection, "readTaskIndex">,
  query: CollaboratorDecisionQuery = {},
) {
  const personId = involvementPersonId(query),
    decisions = readCollaboratorDecisions(projection, { ...query, state: "proposed" }),
    tasks = listScopedTasks(projection, {
      ...query,
      ...(personId === undefined ? {} : { scopePersonId: personId }),
    });
  return {
    ...requireSameProjectionCut("attestation pool", [decisions, tasks]),
    decisions: decisions.decisions,
    decisionPage: decisions.page ?? null,
    tasks:
      query.involvement === "mine" && personId === undefined
        ? []
        : tasks.rows.filter(({ status }) => status === "submitted" || status === "in_review"),
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
    tasks: tasks.rows.filter(({ status }) => status !== "done" && status !== "cancelled"),
  };
}

export function readCollaboratorLiveFloor(
  projection: Pick<
    TaskProjection,
    "readRuntimeSessions" | "readLatestRuntimeDispatchBySession" | "readRuntimeSessionEventsByType"
  >,
  scope: CollaboratorScope & { readonly startedAtGte?: string } = {},
) {
  const sourceNode = sourceNodeReader(projection);
  return projection.readRuntimeSessions({ inFlightOnly: true }).flatMap((session) => {
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
