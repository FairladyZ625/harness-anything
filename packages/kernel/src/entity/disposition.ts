/** @slice-activation M5 F5 entity CRUD framework exposes disposition evaluation for application services and W7 cascade graph consumers. */
import type { HarnessLayoutOverrides } from "../layout/index.ts";
import { parseEntityRef } from "../domain/entity-ref.ts";
import type { RelationGraphEdgeRow } from "../projection/relation-graph-projection.ts";
import { readRelationGraphProjection } from "../projection/sqlite-task-projection.ts";
import { entityRegistry, type DispositionAction, type DispositionLevel, type KernelEntityKind } from "./registry.ts";

export interface EntityDispositionOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly projectionPath?: string;
}

export interface EntityDispositionRequest extends EntityDispositionOptions {
  readonly entityRef: string;
  readonly action: DispositionAction;
}

export interface EntityCascadeImpact {
  readonly entityRef: string;
  readonly incoming: ReadonlyArray<RelationGraphEdgeRow>;
  readonly outgoing: ReadonlyArray<RelationGraphEdgeRow>;
  readonly impactedRefs: ReadonlyArray<string>;
}

export interface EntityDispositionEvaluation {
  readonly entityRef: string;
  readonly entityKind: KernelEntityKind;
  readonly action: DispositionAction;
  readonly level: DispositionLevel;
  readonly allowed: boolean;
  readonly reason: string;
  readonly writeOpKinds: ReadonlyArray<string>;
  readonly lowerBound: {
    readonly activeIncomingCount: number;
    readonly blocksDestructiveDisposition: boolean;
  };
  readonly cascade: EntityCascadeImpact;
}

export interface ImplicitDispositionRecommendation {
  readonly entityRef: string;
  readonly entityKind: KernelEntityKind;
  readonly reason: string;
  readonly recommendedActions: ReadonlyArray<DispositionAction>;
}

export interface ImplicitDispositionEvaluation extends EntityDispositionOptions {
  readonly affectedEntityRefs: ReadonlyArray<string>;
}

export function evaluateEntityDisposition(request: EntityDispositionRequest): EntityDispositionEvaluation {
  const entityKind = entityKindFromRef(request.entityRef);
  const registration = entityRegistry[entityKind];
  const matrixEntry = registration.dispositionMatrix.entries[request.action];
  const graph = readRelationGraphProjection(request);
  const cascade = cascadeImpactFromEdges(request.entityRef, graph.edges);
  const destructive = matrixEntry.level === "D3" || matrixEntry.level === "D4";
  const blockedByIncoming = destructive && cascade.incoming.length > 0;
  if (!matrixEntry.supported) {
    return evaluation(request.entityRef, entityKind, request.action, matrixEntry.level, false, matrixEntry.reason, matrixEntry.writeOpKinds, cascade);
  }
  if (blockedByIncoming) {
    return evaluation(
      request.entityRef,
      entityKind,
      request.action,
      matrixEntry.level,
      false,
      `${request.entityRef} has ${cascade.incoming.length} active incoming relation(s); D3/D4 disposition is blocked by the lower-bound rule`,
      matrixEntry.writeOpKinds,
      cascade
    );
  }
  return evaluation(request.entityRef, entityKind, request.action, matrixEntry.level, true, matrixEntry.reason, matrixEntry.writeOpKinds, cascade);
}

export function readEntityCascadeImpact(options: EntityDispositionOptions & { readonly entityRef: string }): EntityCascadeImpact {
  const projection = readRelationGraphProjection(options);
  return cascadeImpactFromEdges(options.entityRef, projection.edges);
}

export function evaluateImplicitDispositionRecommendations(
  options: ImplicitDispositionEvaluation
): ReadonlyArray<ImplicitDispositionRecommendation> {
  const projection = readRelationGraphProjection(options);
  const activeEdges = projection.edges.filter((edge) => edge.state === "active");
  const recommendations: ImplicitDispositionRecommendation[] = [];
  for (const entityRef of uniqueSorted(options.affectedEntityRefs)) {
    const entityKind = entityKindFromRef(entityRef);
    const incidentCount = activeEdges.filter((edge) => refMatchesEntity(edge.sourceRef, entityRef) || refMatchesEntity(edge.targetRef, entityRef)).length;
    if (incidentCount > 0) continue;
    recommendations.push({
      entityRef,
      entityKind,
      reason: `${entityRef} has no active relation after a relation graph change; disposition review is recommended, not automatic`,
      recommendedActions: nonDestructiveSupportedActions(entityKind)
    });
  }
  return recommendations;
}

function evaluation(
  entityRef: string,
  entityKind: KernelEntityKind,
  action: DispositionAction,
  level: DispositionLevel,
  allowed: boolean,
  reason: string,
  writeOpKinds: ReadonlyArray<string>,
  cascade: EntityCascadeImpact
): EntityDispositionEvaluation {
  return {
    entityRef,
    entityKind,
    action,
    level,
    allowed,
    reason,
    writeOpKinds,
    lowerBound: {
      activeIncomingCount: cascade.incoming.length,
      blocksDestructiveDisposition: cascade.incoming.length > 0
    },
    cascade
  };
}

function cascadeImpactFromEdges(entityRef: string, edges: ReadonlyArray<RelationGraphEdgeRow>): EntityCascadeImpact {
  const incoming = activeSorted(edges.filter((edge) => edgeHasIncomingToEntity(edge, entityRef)));
  const outgoing = activeSorted(edges.filter((edge) => edgeHasOutgoingFromEntity(edge, entityRef)));
  return {
    entityRef,
    incoming,
    outgoing,
    impactedRefs: uniqueSorted([...incoming, ...outgoing].flatMap((edge) => otherEndpointRefs(edge, entityRef)))
  };
}

function activeSorted(edges: ReadonlyArray<RelationGraphEdgeRow>): ReadonlyArray<RelationGraphEdgeRow> {
  return edges
    .filter((edge) => edge.state === "active")
    .sort((left, right) => left.relationId.localeCompare(right.relationId));
}

function refMatchesEntity(candidateRef: string, entityRef: string): boolean {
  if (candidateRef === entityRef) return true;
  const entity = parseEntityRef(entityRef);
  if (!entity || entity.kind === "fact") return false;
  return candidateRef.startsWith(`${entityRef}/`);
}

function edgeHasIncomingToEntity(edge: RelationGraphEdgeRow, entityRef: string): boolean {
  if (edge.direction === "undirected") return edgeTouchesEntity(edge, entityRef);
  return refMatchesEntity(edge.targetRef, entityRef);
}

function edgeHasOutgoingFromEntity(edge: RelationGraphEdgeRow, entityRef: string): boolean {
  if (edge.direction === "undirected") return edgeTouchesEntity(edge, entityRef);
  return refMatchesEntity(edge.sourceRef, entityRef);
}

function edgeTouchesEntity(edge: RelationGraphEdgeRow, entityRef: string): boolean {
  return refMatchesEntity(edge.sourceRef, entityRef) || refMatchesEntity(edge.targetRef, entityRef);
}

function otherEndpointRefs(edge: RelationGraphEdgeRow, entityRef: string): ReadonlyArray<string> {
  const refs: string[] = [];
  if (refMatchesEntity(edge.targetRef, entityRef)) refs.push(edge.sourceRef);
  if (refMatchesEntity(edge.sourceRef, entityRef)) refs.push(edge.targetRef);
  return refs;
}

function entityKindFromRef(entityRef: string): KernelEntityKind {
  const parsed = parseEntityRef(entityRef);
  if (!parsed || parsed.externalHarness) {
    throw new Error(`Unsupported entity ref for disposition: ${entityRef}`);
  }
  return parsed.kind;
}

function nonDestructiveSupportedActions(entityKind: KernelEntityKind): ReadonlyArray<DispositionAction> {
  return Object.values(entityRegistry[entityKind].dispositionMatrix.entries)
    .filter((entry) => entry.supported && (entry.level === "D1" || entry.level === "D2"))
    .map((entry) => entry.action)
    .sort();
}

function uniqueSorted(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)].sort();
}
