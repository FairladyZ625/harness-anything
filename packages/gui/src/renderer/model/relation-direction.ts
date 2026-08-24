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
 * Kernel parity filter for current incoming relation semantics
 * (packages/kernel/src/domain/decision-coverage.ts): only an incoming edge with
 * state "active" carries its relation semantics forward; retired/deleted edges
 * are audit history. Every renderer derivation that treats an incoming edge as
 * current (e.g. "this fact is superseded" or contradicted) must compose this
 * predicate instead of re-deriving the criterion, so the two layers cannot drift.
 */
export function activeIncomingRelations(
  targetRef: string,
  kind: RelationKind,
  relations: ReadonlyArray<RelationEdge>,
): ReadonlyArray<RelationEdge> {
  return incomingRelations(targetRef, kind, relations).filter(
    (edge) =>
      /* @gate-identity check-gui-status-judgments/gui-status-032 */
      edge.state === "active",
  );
}
