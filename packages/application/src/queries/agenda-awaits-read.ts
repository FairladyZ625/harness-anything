import type { TaskProjection } from "@harness-anything/kernel";
import { isTerminalDecisionState } from "@harness-anything/kernel/internal/domain/decision-board-projection.ts";
import { parseEntityRef } from "@harness-anything/kernel/internal/domain/entity-ref.ts";
import { parseAwaitsRequest, relationIsCurrent } from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import { isTerminalStatus } from "@harness-anything/kernel/internal/domain/lifecycle-status.ts";
import { cursorStep } from "@harness-anything/kernel/internal/ports/projection-reads.ts";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import type { CollaboratorViewer } from "./collaborator-reads.ts";
import { requireSameProjectionCut, type ProjectionCut } from "./projection-cut.ts";
import {
  projectionRead,
  runAsyncProjectionRead,
  runProjectionRead,
  type AsyncProjection,
  type ProjectionReadPlan,
} from "./projection-read-plan.ts";
import { sourceNodeReader } from "./runtime-attribution.ts";
import type { WorkBriefAgendaPage, WorkBriefAwaitsRow } from "./work-briefs-read.ts";

export type AgendaAwaitsProjection = Pick<
  TaskProjection,
  | "readCut"
  | "readRelationQuery"
  | "readRelationEdge"
  | "readEventWitness"
  | "readRuntimeSessionEventsByType"
  | "read"
  | "readDecision"
  | "getEntity"
>;
type AgendaProjection = Omit<AgendaAwaitsProjection, "readEventWitness" | "readRuntimeSessionEventsByType">;
type AgendaPageQuery = CollaboratorViewer & { readonly limit?: number; readonly cursor?: string };
type AgendaPage = WorkBriefAgendaPage & ProjectionCut;
const readAgenda = <Result>(
  step: (projection: AgendaProjection | AsyncProjection<AgendaProjection>) => Result | Promise<Result>,
) => projectionRead<AgendaProjection, Result>(step);

/** The projection is already authorized. A host must authorize any selected member lens. */
export function readAgendaAwaitsPage(projection: AgendaAwaitsProjection, query: AgendaPageQuery): AgendaPage {
  const sourceNode = sourceNodeReader(projection);
  return runProjectionRead(
    agendaAwaitsPage(
      query,
      (revision) =>
        query.filterNodeId === undefined ||
        sourceNode(projection.readEventWitness(revision)?.source) === query.filterNodeId,
    ),
    projection,
  );
}

export function readPersonalAgendaAwaitsFromAsyncProjection(
  projection: AsyncProjection<AgendaProjection>,
  query: Pick<AgendaPageQuery, "viewerPersonId" | "limit" | "cursor">,
): Promise<AgendaPage> {
  return runAsyncProjectionRead(
    agendaAwaitsPage(query, () => true),
    projection,
  );
}

function* agendaAwaitsPage(
  query: AgendaPageQuery,
  matchesNode: (revision: number) => boolean,
): ProjectionReadPlan<AgendaProjection, AgendaPage> {
  const personId = query.scopePersonId ?? query.viewerPersonId,
    limit = query.limit ?? storageReadPolicy.defaultValue.pageSizes.standard,
    cut = yield* readAgenda((projection) => projection.readCut()),
    awaitingYou: WorkBriefAwaitsRow[] = [],
    cursors = new Set(query.cursor === undefined ? [] : [query.cursor]);
  let cursor = query.cursor;
  do {
    const read = yield* readAgenda((projection) =>
      projection.readRelationQuery({
        target: `person/${personId}`,
        relationType: "awaits",
        state: "active",
        limit: limit - awaitingYou.length,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    requireSameProjectionCut("agenda awaits", [cut, read]);
    for (const edge of read.rows) {
      if (!relationIsCurrent(edge)) continue;
      const request = parseAwaitsRequest(edge.rationale);
      if (request === null) continue;
      const relation = yield* readAgenda((projection) => projection.readRelationEdge(edge.relationId));
      if (relation === null || !relationIsCurrent(relation)) continue;
      if (!matchesNode(relation.workspaceRevision)) continue;
      const source = yield* currentSource(cut, edge.sourceRef);
      if (source === null) continue;
      const { actor } = relation.entity.provenance;
      awaitingYou.push({
        relationId: edge.relationId,
        relationRevision: relation.workspaceRevision,
        sourceRef: edge.sourceRef,
        ...source,
        personId,
        ...request,
        askedAt: relation.entity.createdAt,
        askedBy: actor.executor?.id ?? actor.principal.personId,
      });
    }
    cursor = cursorStep({ ...cut, nextCursor: read.page?.nextCursor ?? null }, cursors, "agenda awaits");
  } while (cursor !== undefined && awaitingYou.length < limit);
  requireSameProjectionCut("agenda awaits", [cut, yield* readAgenda((projection) => projection.readCut())]);
  return { ...cut, page: { ...cut, limit, cursor: query.cursor ?? null, nextCursor: cursor ?? null }, awaitingYou };
}

function* currentSource(
  cut: ProjectionCut,
  ref: string,
): ProjectionReadPlan<AgendaProjection, { readonly title: string; readonly status: string } | null> {
  const parsed = parseEntityRef(ref);
  if (!parsed || parsed.externalHarness) return null;
  const { kind, id } = parsed;
  if (kind === "task") {
    const read = yield* readAgenda((projection) => projection.read(id));
    requireSameProjectionCut("agenda task source", [cut, read]);
    const { task } = read.snapshot;
    return task === null || isTerminalStatus(task.status) ? null : { title: task.title, status: task.status };
  }
  if (kind === "decision") {
    const read = yield* readAgenda((projection) => projection.readDecision(id, false));
    requireSameProjectionCut("agenda decision source", [cut, read]);
    const { decision } = read;
    return decision === null || isTerminalDecisionState(decision.state)
      ? null
      : { title: decision.title, status: decision.state };
  }
  const entity = yield* readAgenda((projection) => projection.getEntity(kind, id));
  return entity === null || entity.freshness === "orphaned"
    ? null
    : {
        title: typeof entity.value.title === "string" ? entity.value.title : id,
        status: typeof entity.value.state === "string" ? entity.value.state : entity.freshness,
      };
}
