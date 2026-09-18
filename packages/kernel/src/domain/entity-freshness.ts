export const entityFreshnesses = ["current", "orphaned", "unknown"] as const;
export const relationFreshnesses = ["current", "suspect", "orphaned"] as const;
/** Which endpoint's cut verdict a relation freshness judgment follows; each relation
 * type declares its anchor through `relationFreshnessAnchorForType` (entity-relation.ts). */
export const relationFreshnessAnchors = ["source", "target", "target-presence"] as const;

export type EntityFreshness = (typeof entityFreshnesses)[number];
export type RelationFreshness = (typeof relationFreshnesses)[number];
export type RelationFreshnessAnchor = (typeof relationFreshnessAnchors)[number];
export type EntityVersion = string | number;

export interface EntityVersionWitness {
  readonly entityRef: string;
  readonly freshness: EntityFreshness;
  readonly currentVersion: EntityVersion | null;
  /** The entity's own lifecycle state word at this cut, when the projection records one
   * (a decision's state today). Kinds without a lifecycle column leave it undefined. */
  readonly state?: string;
}

export function relationFreshnessAtCut(input: {
  readonly anchor: RelationFreshnessAnchor;
  readonly target: EntityVersionWitness;
  readonly targetObservedVersion: EntityVersion | null;
  readonly source?: EntityVersionWitness;
}): RelationFreshness {
  if (input.anchor === "source") return sourceAnchoredFreshnessAtCut(input.source);
  const target = input.target;
  if (target.freshness === "orphaned") return "orphaned";
  if (input.anchor === "target-presence") return target.freshness === "current" ? "current" : "suspect";
  if (target.freshness !== "current" || target.currentVersion === null || input.targetObservedVersion === null)
    return "suspect";
  return target.currentVersion === input.targetObservedVersion ? "current" : "suspect";
}

/**
 * dec_D6970DC1303EF90E8B4855FC80/CH1: a source-anchored edge is fresh while its source
 * stays in force — `in_effect` for a decision, the only canonical `derives` source. A
 * kind with no lifecycle state at the cut counts on presence alone.
 */
function sourceAnchoredFreshnessAtCut(source: EntityVersionWitness | undefined): RelationFreshness {
  if (source === undefined) throw new Error("source-anchored relation freshness requires the source witness");
  if (source.freshness === "orphaned") return "orphaned";
  if (source.freshness !== "current") return "suspect";
  return source.state === undefined || source.state === "in_effect" ? "current" : "suspect";
}
