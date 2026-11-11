export const factLivenessStates = ["standing", "superseded_fact"] as const;
export type FactLiveness = (typeof factLivenessStates)[number];
export interface FactLivenessInput {
  readonly ref: string;
}
export interface FactLivenessRelation {
  readonly targetRef: string;
  readonly relationType: string;
  readonly state: string;
}

/** A fact is retired only by the canonical active `supersedes-fact` incoming edge. */
export function factLiveness(fact: FactLivenessInput, relations: readonly FactLivenessRelation[]): FactLiveness {
  return supersededFactRefs(relations).has(fact.ref) ? "superseded_fact" : "standing";
}

/**
 * The projected `invalidated` field: the one place the liveness verdict becomes the
 * boolean read surfaces consume, so no projection or renderer compares the word itself.
 */
export function factInvalidated(liveness: FactLiveness): boolean {
  return liveness === "superseded_fact";
}

/** Bulk consumers build this once; the incoming active edge remains the sole retirement criterion. */
export function supersededFactRefs(relations: readonly FactLivenessRelation[]): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const edge of relations)
    if (edge.state === "active" && edge.relationType === "supersedes-fact") refs.add(edge.targetRef);
  return refs;
}
