import type { RelationEdge, RelationKind } from "./types";

/**
 * Bridge-bounded mirror of the kernel reverse query
 * (packages/kernel/src/domain/relation-direction.ts#incomingRelations).
 *
 * The renderer must not import kernel runtime values (window.harness bridge only),
 * so the one reverse-direction query is mirrored here for the renderer's model
 * layer. Both implementations must answer identically; the canonical-direction
 * ratchet gate (tools/check-relation-canonical-direction.mjs) asserts their
 * agreement against every registry row, so the mirror cannot drift.
 */
export function incomingRelations(
  targetRef: string,
  kind: RelationKind,
  relations: ReadonlyArray<RelationEdge>,
): ReadonlyArray<RelationEdge> {
  return relations.filter((relation) => relation.to === targetRef && relation.kind === kind);
}

/**
 * Kernel parity query for incoming relations
 * (packages/kernel/src/domain/relation-direction.ts#incomingRelations).
 *
 * Edge currency is settled once at the pipeline's collection point
 * (triadic-data adaptRelationRows filters on the projected `current` flag), so
 * callers here treat every incoming edge as a current relation; retired or
 * consumability-refused edges never reach this query.
 */
