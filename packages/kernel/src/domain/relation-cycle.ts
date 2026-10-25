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

export interface RelationCycleAdjacencyReader {
  /** Return active and retired outgoing rows for one source; the algorithm applies the typed filters. */
  readonly readOutgoing: (relationType: RelationType, sourceRef: string) => readonly RelationCycleEdge[];
}

/**
 * The canonical typed-cycle algorithm for both write admission and projection audit.
 * With a candidate, it looks for target → source reachability in the existing graph;
 * without one, it returns one deterministic cycle witness for each cyclic relation type.
 */
export function findRelationCycleWitnesses(edges: readonly RelationCycleEdge[]): readonly RelationCycleWitness[];
export function findRelationCycleWitnesses(
  adjacency: RelationCycleAdjacencyReader,
  candidate: RelationCycleEdge,
): readonly RelationCycleWitness[];
export function findRelationCycleWitnesses(
  edgesOrAdjacency: readonly RelationCycleEdge[] | RelationCycleAdjacencyReader,
  candidate?: RelationCycleEdge,
): readonly RelationCycleWitness[] {
  if (candidate) {
    if (
      !isAcyclicRelationType(candidate.relationType) ||
      candidate.state !== "active" ||
      candidate.direction !== "directed"
    )
      return [];
    if (candidate.sourceRef === candidate.targetRef)
      return [witness(candidate.relationType, [candidate.sourceRef, candidate.sourceRef], [candidate.relationId])];
    const readOutgoing =
      "readOutgoing" in edgesOrAdjacency
        ? edgesOrAdjacency.readOutgoing
        : (() => {
            const bySource = new Map<string, RelationCycleEdge[]>();
            for (const edge of edgesOrAdjacency) {
              if (
                edge.relationType !== candidate.relationType ||
                edge.state !== "active" ||
                edge.direction !== "directed"
              )
                continue;
              const outgoing = bySource.get(edge.sourceRef) ?? [];
              outgoing.push(edge);
              bySource.set(edge.sourceRef, outgoing);
            }
            return (_relationType: RelationType, sourceRef: string) => bySource.get(sourceRef) ?? [];
          })();
    const path = walkReachable(readOutgoing, candidate.relationType, candidate.targetRef, candidate.sourceRef);
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

  if ("readOutgoing" in edgesOrAdjacency) return [];
  const edges = edgesOrAdjacency;

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

function walkReachable(
  readOutgoing: RelationCycleAdjacencyReader["readOutgoing"],
  relationType: RelationType,
  startRef: string,
  goalRef: string,
): { readonly nodeRefs: readonly string[]; readonly relationIds: readonly string[] } | null {
  const visited = new Set<string>([startRef]),
    previous = new Map<string, { readonly sourceRef: string; readonly edge: RelationCycleEdge }>(),
    frontier = [startRef];
  for (let index = 0; index < frontier.length; index += 1) {
    const sourceRef = frontier[index]!;
    for (const edge of orderedEdges(
      readOutgoing(relationType, sourceRef).filter(
        (row) =>
          row.sourceRef === sourceRef &&
          row.relationType === relationType &&
          row.state === "active" &&
          row.direction === "directed",
      ),
    )) {
      if (visited.has(edge.targetRef)) continue;
      visited.add(edge.targetRef);
      previous.set(edge.targetRef, { sourceRef, edge });
      if (edge.targetRef === goalRef) {
        const nodeRefs = [goalRef],
          relationIds: string[] = [];
        let currentRef = goalRef;
        while (currentRef !== startRef) {
          const step = previous.get(currentRef)!;
          relationIds.push(step.edge.relationId);
          currentRef = step.sourceRef;
          nodeRefs.push(currentRef);
        }
        return { nodeRefs: nodeRefs.reverse(), relationIds: relationIds.reverse() };
      }
      frontier.push(edge.targetRef);
    }
  }
  return null;
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
