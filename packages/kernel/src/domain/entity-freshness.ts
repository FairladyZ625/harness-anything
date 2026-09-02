export const entityFreshnesses = ["current", "orphaned", "unknown"] as const;
export const relationFreshnesses = ["current", "suspect", "orphaned"] as const;

export type EntityFreshness = (typeof entityFreshnesses)[number];
export type RelationFreshness = (typeof relationFreshnesses)[number];
export type EntityVersion = string | number;

export interface EntityVersionWitness {
  readonly entityRef: string;
  readonly freshness: EntityFreshness;
  readonly currentVersion: EntityVersion | null;
}

export function relationFreshnessAtCut(input: {
  readonly target: EntityVersionWitness;
  readonly targetObservedVersion: EntityVersion | null;
}): RelationFreshness {
  if (input.target.freshness === "orphaned") return "orphaned";
  if (
    input.target.freshness !== "current" ||
    input.target.currentVersion === null ||
    input.targetObservedVersion === null
  )
    return "suspect";
  return input.target.currentVersion === input.targetObservedVersion ? "current" : "suspect";
}
