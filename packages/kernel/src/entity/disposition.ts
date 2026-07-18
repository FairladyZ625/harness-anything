/** @slice-activation M5 F5 entity CRUD framework exposes disposition evaluation for application services and W7 cascade graph consumers. */
import type { HarnessLayoutOverrides } from "../layout/index.ts";
import { parseEntityRef } from "../domain/entity-ref.ts";
import type { FactAnchorRow, RelationGraphEdgeRow } from "../projection/relation-graph-projection.ts";
import { queryTaskChildren, readRelationGraphProjection } from "../projection/sqlite-task-projection.ts";
import type { TaskProjectionRow } from "../projection/types.ts";
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
  readonly anchoredFacts: ReadonlyArray<FactAnchorRow>;
  readonly childTasks: ReadonlyArray<TaskProjectionRow>;
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
    readonly activeAnchoredFactCount: number;
    readonly childTaskCount: number;
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
  const childTasks = childTasksForEntity(request, request.entityRef);
  const cascade = cascadeImpactFromProjection(request.entityRef, graph.edges, graph.factAnchors, childTasks);
  const destructive = matrixEntry.level === "D3" || matrixEntry.level === "D4";
  const blockedByLowerBound = destructive && (cascade.incoming.length > 0 || cascade.anchoredFacts.length > 0 || cascade.childTasks.length > 0);
  if (!matrixEntry.supported) {
    return evaluation(request.entityRef, entityKind, request.action, matrixEntry.level, false, matrixEntry.reason, matrixEntry.writeOpKinds, cascade);
  }
  if (blockedByLowerBound) {
    return evaluation(
      request.entityRef,
      entityKind,
      request.action,
      matrixEntry.level,
      false,
      [
        `${request.entityRef} has ${cascade.anchoredFacts.length} anchored fact(s), ${cascade.incoming.length} active incoming relation(s), and ${cascade.childTasks.length} child task(s); D3/D4 disposition is blocked by the lower-bound rule.`,
        "Production does not offer hard delete. E79 defines delete as stage containment: distill evidence into an anchor task, reconnect facts/decisions to that anchor, then run ha task archive <id> --reason <reason> or ha task supersede <id> --by <replacement-id> --reason <reason>; archive/delete/supersede child tasks before local compatibility hard delete; hard delete has no --cascade escape hatch."
      ].join(" "),
      matrixEntry.writeOpKinds,
      cascade
    );
  }
  return evaluation(request.entityRef, entityKind, request.action, matrixEntry.level, true, matrixEntry.reason, matrixEntry.writeOpKinds, cascade);
}

export function readEntityCascadeImpact(options: EntityDispositionOptions & { readonly entityRef: string }): EntityCascadeImpact {
  const projection = readRelationGraphProjection(options);
  return cascadeImpactFromProjection(options.entityRef, projection.edges, projection.factAnchors, childTasksForEntity(options, options.entityRef));
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
      activeAnchoredFactCount: cascade.anchoredFacts.length,
      childTaskCount: cascade.childTasks.length,
      blocksDestructiveDisposition: cascade.incoming.length > 0 || cascade.anchoredFacts.length > 0 || cascade.childTasks.length > 0
    },
    cascade
  };
}

function cascadeImpactFromProjection(
  entityRef: string,
  edges: ReadonlyArray<RelationGraphEdgeRow>,
  factAnchors: ReadonlyArray<FactAnchorRow>,
  childTasks: ReadonlyArray<TaskProjectionRow>
): EntityCascadeImpact {
  const incoming = activeSorted(edges.filter((edge) => edgeHasIncomingToEntity(edge, entityRef)));
  const outgoing = activeSorted(edges.filter((edge) => edgeHasOutgoingFromEntity(edge, entityRef)));
  const anchoredFacts = activeAnchoredFacts(entityRef, factAnchors);
  return {
    entityRef,
    incoming,
    outgoing,
    anchoredFacts,
    childTasks,
    impactedRefs: uniqueSorted([
      ...anchoredFacts.map((fact) => fact.factRef),
      ...childTasks.map((child) => `task/${child.taskId}`),
      ...[...incoming, ...outgoing].flatMap((edge) => otherEndpointRefs(edge, entityRef))
    ])
  };
}

function childTasksForEntity(options: EntityDispositionOptions, entityRef: string): ReadonlyArray<TaskProjectionRow> {
  const entity = parseEntityRef(entityRef);
  if (!entity || entity.externalHarness || entity.kind !== "task") return [];
  return queryTaskChildren({ ...options, parentTaskId: entity.id }).rows;
}

function activeAnchoredFacts(entityRef: string, factAnchors: ReadonlyArray<FactAnchorRow>): ReadonlyArray<FactAnchorRow> {
  const entity = parseEntityRef(entityRef);
  if (!entity || entity.externalHarness || entity.kind !== "task") return [];
  return factAnchors
    .filter((fact) => fact.taskId === entity.id)
    .sort((left, right) => left.factRef.localeCompare(right.factRef));
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
