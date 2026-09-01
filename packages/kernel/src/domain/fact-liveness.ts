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
  return relations.some(
    (edge) => edge.state === "active" && edge.relationType === "supersedes-fact" && edge.targetRef === fact.ref,
  )
    ? "superseded_fact"
    : "standing";
}
