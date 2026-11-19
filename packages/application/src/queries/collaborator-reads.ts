import { decisionEventTypes } from "@harness-anything/kernel/internal/domain/decision-event-types.ts";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import type { TaskProjection, TaskProjectionListQuery } from "@harness-anything/kernel";
import type { DecisionListFilters } from "@harness-anything/kernel/internal/ports/decision-projection-model.ts";
import type { EventListQuery } from "@harness-anything/kernel/internal/domain/event-list.ts";
import {
  effectiveRepositoryMode,
  matchesCollaboratorScope,
  scopedPersonId,
  taskMatchesCollaboratorScope,
  type CollaboratorScope,
} from "@harness-anything/kernel/internal/domain/collaborator-scope.ts";
import { writeSourceNodeId } from "@harness-anything/kernel/internal/domain/write-source.ts";
import { readViewerTodos, todoRelations } from "./todo-read.ts";
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
  projection: Pick<TaskProjection, "listDecisions" | "readRelationQuery" | "readEventList">,
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
  const awaits = new Set(
    personId === undefined
      ? []
      : todoRelations(projection, {
          target: `person/${personId}`,
          relationType: "awaits",
        }).map(({ sourceRef }) => sourceRef.split("/").slice(0, 2).join("/")),
  );
  const matches = ({ decisionId, proposer }: ReturnType<TaskProjection["listDecisions"]>["decisions"][number]) =>
    (personId === undefined
      ? involvement !== "mine"
      : proposer.principal.personId === personId || awaits.has(`decision/${decisionId}`)) &&
    (filterNodeId === undefined ||
      projection.readEventList({
        entity: `decision/${decisionId}`,
        type: decisionEventTypes[0],
        nodeId: filterNodeId,
        limit: storageReadPolicy.defaultValue.pageSizes.one,
      }).rows.length !== 0);
  const decisions: ReturnType<TaskProjection["listDecisions"]>["decisions"][number][] = [];
  let cursor = filters.cursor;
  let result: ReturnType<TaskProjection["listDecisions"]>;
  const visited = new Set<string>();
  do {
    result = projection.listDecisions({
      ...filters,
      ...(cursor === undefined ? {} : { cursor }),
      ...(filters.limit === undefined ? {} : { limit: filters.limit - decisions.length }),
    });
    decisions.push(...result.decisions.filter(matches));
    cursor = result.page?.nextCursor ?? undefined;
    if (cursor !== undefined) {
      if (visited.has(cursor) || cursor === filters.cursor) throw new Error("Decision page cursor did not advance.");
      visited.add(cursor);
    }
  } while (cursor !== undefined && filters.limit !== undefined && decisions.length < filters.limit);
  return {
    ...result,
    decisions,
    ...(result.page
      ? { page: { ...result.page, limit: filters.limit ?? result.page.limit, cursor: filters.cursor ?? null } }
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

export function readCollaboratorAgenda(projection: TaskProjection, query: CollaboratorViewer) {
  const personId = query.scopePersonId ?? query.viewerPersonId,
    tasks = listScopedTasks(projection, { ...query, scopePersonId: personId }),
    decisions = readCollaboratorDecisions(projection, { ...query, scopePersonId: personId, state: "proposed" }),
    awaitingYou = todoRelations(projection, { target: `person/${personId}`, relationType: "awaits" });
  return {
    ...requireSameProjectionCut("collaborator agenda", [tasks, decisions]),
    personId,
    pinnedEntities: readPersonalPins(projection, query),
    todos: readViewerTodos(projection, { ...query, viewerPersonId: personId }).filter(({ open }) => open),
    awaitingYou:
      query.filterNodeId === undefined
        ? awaitingYou
        : awaitingYou.filter(
            ({ workspaceRevision }) =>
              workspaceRevision !== null &&
              writeSourceNodeId(projection.readEventWitness(workspaceRevision)?.source) === query.filterNodeId,
          ),
    decisions: decisions.decisions,
    tasks: tasks.rows.filter(({ status }) => status !== "done" && status !== "cancelled"),
  };
}

export function readCollaboratorLiveFloor(
  projection: Pick<TaskProjection, "readRuntimeSessions" | "readLatestRuntimeDispatchBySession">,
  scope: CollaboratorScope = {},
) {
  return projection.readRuntimeSessions({ inFlightOnly: true }).flatMap((session) => {
    const dispatch = projection.readLatestRuntimeDispatchBySession(session.runtimeSessionId);
    return matchesCollaboratorScope(scope, [
      {
        personId: dispatch?.actor.principal.personId ?? null,
        nodeId: writeSourceNodeId(dispatch?.source),
      },
    ])
      ? [{ session, dispatch }]
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
