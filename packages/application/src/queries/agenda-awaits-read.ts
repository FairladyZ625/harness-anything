import {
  cursorStep,
  isTerminalDecisionState,
  isTerminalStatus,
  parseAwaitsRequest,
  parseEntityRef,
  relationIsCurrent,
  type TaskProjection,
} from "@harness-anything/kernel";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import type { CollaboratorViewer } from "./collaborator-reads.ts";
import { requireSameProjectionCut, type ProjectionCut } from "./projection-cut.ts";
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

/** The projection is already authorized. A host must authorize any selected member lens. */
export function readAgendaAwaitsPage(
  projection: AgendaAwaitsProjection,
  query: CollaboratorViewer & { readonly limit?: number; readonly cursor?: string },
): WorkBriefAgendaPage & ProjectionCut {
  const personId = query.scopePersonId ?? query.viewerPersonId,
    limit = query.limit ?? storageReadPolicy.defaultValue.pageSizes.standard,
    cut = projection.readCut(),
    sourceNode = sourceNodeReader(projection),
    awaitingYou: WorkBriefAwaitsRow[] = [],
    cursors = new Set(query.cursor === undefined ? [] : [query.cursor]);
  let cursor = query.cursor;
  do {
    const read = projection.readRelationQuery({
      target: `person/${personId}`,
      relationType: "awaits",
      state: "active",
      limit: limit - awaitingYou.length,
      ...(cursor === undefined ? {} : { cursor }),
    });
    requireSameProjectionCut("agenda awaits", [cut, read]);
    for (const edge of read.rows) {
      if (!relationIsCurrent(edge)) continue;
      const request = parseAwaitsRequest(edge.rationale);
      if (request === null) continue;
      const relation = projection.readRelationEdge(edge.relationId);
      if (relation === null || !relationIsCurrent(relation)) continue;
      if (
        query.filterNodeId !== undefined &&
        sourceNode(projection.readEventWitness(relation.workspaceRevision)?.source) !== query.filterNodeId
      )
        continue;
      const source = currentSource(projection, cut, edge.sourceRef);
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
  requireSameProjectionCut("agenda awaits", [cut, projection.readCut()]);
  return { ...cut, page: { ...cut, limit, cursor: query.cursor ?? null, nextCursor: cursor ?? null }, awaitingYou };
}

function currentSource(
  projection: AgendaAwaitsProjection,
  cut: ProjectionCut,
  ref: string,
): { readonly title: string; readonly status: string } | null {
  const parsed = parseEntityRef(ref);
  if (!parsed || parsed.externalHarness) return null;
  const { kind, id } = parsed;
  if (kind === "task") {
    const read = projection.read(id);
    requireSameProjectionCut("agenda task source", [cut, read]);
    const { task } = read.snapshot;
    return task === null || isTerminalStatus(task.status) ? null : { title: task.title, status: task.status };
  }
  if (kind === "decision") {
    const read = projection.readDecision(id, false);
    requireSameProjectionCut("agenda decision source", [cut, read]);
    const { decision } = read;
    return decision === null || isTerminalDecisionState(decision.state)
      ? null
      : { title: decision.title, status: decision.state };
  }
  const entity = projection.getEntity(kind, id);
  return entity === null || entity.freshness === "orphaned"
    ? null
    : {
        title: typeof entity.value.title === "string" ? entity.value.title : id,
        status: typeof entity.value.state === "string" ? entity.value.state : entity.freshness,
      };
}
