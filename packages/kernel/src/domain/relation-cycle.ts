import { isAcyclicRelationType, type RelationType } from "./relation-type-registry.ts";
import type { RelationDirection, RelationState } from "./entity-relation.ts";

export interface RelationCycleEdge {
  readonly relationId: string;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly relationType: RelationType;
  readonly direction: RelationDirection;
  readonly state: RelationState;
}

export interface RelationCycleWitness {
  readonly relationType: RelationType;
  /** Closed path: the first and last refs are equal. */
  readonly nodeRefs: readonly string[];
  readonly relationIds: readonly string[];
}

/**
 * The canonical typed-cycle algorithm for both write admission and projection audit.
 * With a candidate, it looks for target → source reachability in the existing graph;
 * without one, it returns one deterministic cycle witness for each cyclic relation type.
 */
export function findRelationCycleWitnesses(
  edges: readonly RelationCycleEdge[],
  candidate?: RelationCycleEdge,
): readonly RelationCycleWitness[] {
  if (candidate) {
    if (
      !isAcyclicRelationType(candidate.relationType) ||
      candidate.state !== "active" ||
      candidate.direction !== "directed"
    )
      return [];
    const typedEdges = orderedEdges(
      edges.filter(
        (edge) =>
          edge.relationType === candidate.relationType && edge.state === "active" && edge.direction === "directed",
      ),
    );
    if (candidate.sourceRef === candidate.targetRef)
      return [witness(candidate.relationType, [candidate.sourceRef, candidate.sourceRef], [candidate.relationId])];
    const path = walk(typedEdges, candidate.targetRef, candidate.sourceRef);
    return path
      ? [
          witness(
            candidate.relationType,
            [candidate.sourceRef, ...path.nodeRefs],
            [candidate.relationId, ...path.relationIds],
          ),
        ]
      : [];
  }

  const relationTypes = [...new Set(edges.map(({ relationType }) => relationType))]
    .filter(isAcyclicRelationType)
    .sort();
  return relationTypes.flatMap((relationType) => {
    const typedEdges = orderedEdges(
      edges.filter(
        (edge) => edge.relationType === relationType && edge.state === "active" && edge.direction === "directed",
      ),
    );
    const visited = new Set<string>(),
      active = new Map<string, number>(),
      nodePath: string[] = [],
      edgePath: RelationCycleEdge[] = [];
    const visit = (sourceRef: string): RelationCycleWitness | null => {
      const activeIndex = active.get(sourceRef);
      if (activeIndex !== undefined) {
        const cycleEdges = edgePath.slice(activeIndex);
        return witness(
          relationType,
          [...nodePath.slice(activeIndex), sourceRef],
          cycleEdges.map(({ relationId }) => relationId),
        );
      }
      if (visited.has(sourceRef)) return null;
      visited.add(sourceRef);
      active.set(sourceRef, nodePath.length);
      nodePath.push(sourceRef);
      for (const edge of typedEdges) {
        if (edge.sourceRef !== sourceRef) continue;
        edgePath.push(edge);
        const cycle = visit(edge.targetRef);
        if (cycle) return cycle;
        edgePath.pop();
      }
      nodePath.pop();
      active.delete(sourceRef);
      return null;
    };

    for (const edge of typedEdges) {
      const cycle = visit(edge.sourceRef);
      if (cycle) return [cycle];
    }
    return [];
  });
}

function walk(
  edges: readonly RelationCycleEdge[],
  startRef: string,
  goalRef: string,
): { readonly nodeRefs: readonly string[]; readonly relationIds: readonly string[] } | null {
  const visited = new Set<string>(),
    active = new Set<string>(),
    nodePath: string[] = [],
    edgePath: RelationCycleEdge[] = [];
  const visit = (
    sourceRef: string,
  ): { readonly nodeRefs: readonly string[]; readonly relationIds: readonly string[] } | null => {
    if (sourceRef === goalRef)
      return { nodeRefs: [...nodePath, sourceRef], relationIds: edgePath.map(({ relationId }) => relationId) };
    if (active.has(sourceRef)) return null;
    if (visited.has(sourceRef)) return null;
    visited.add(sourceRef);
    active.add(sourceRef);
    nodePath.push(sourceRef);
    for (const edge of edges) {
      if (edge.sourceRef !== sourceRef) continue;
      edgePath.push(edge);
      const path = visit(edge.targetRef);
      if (path) return path;
      edgePath.pop();
    }
    nodePath.pop();
    active.delete(sourceRef);
    return null;
  };
  return visit(startRef);
}

function orderedEdges(edges: readonly RelationCycleEdge[]): RelationCycleEdge[] {
  return [...edges].sort(
    (left, right) =>
      left.sourceRef.localeCompare(right.sourceRef) ||
      left.targetRef.localeCompare(right.targetRef) ||
      left.relationId.localeCompare(right.relationId),
  );
}

function witness(
  relationType: RelationType,
  nodeRefs: readonly string[],
  relationIds: readonly string[],
): RelationCycleWitness {
  return { relationType, nodeRefs, relationIds };
}
