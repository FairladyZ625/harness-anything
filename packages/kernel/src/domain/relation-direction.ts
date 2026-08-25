import type { RelationType } from "./entity-relation.ts";

/** Endpoint kinds that can host a canonical relation edge. Parsed refs may also be
 * "relation" or external-harness aliases; neither can host an edge. */
export type RelationEndpointKind =
  | "task"
  | "decision"
  | "fact"
  | "execution"
  | "review"
  | "agent"
  | "runtime-session"
  | "policy";

/** Whether the reading of an allowed triple has a registered semantics. */
export type RelationDirectionRegistration = "ratified" | "unregistered" | "derived";

/**
 * The canonical direction registry (blueprint 铁律三): one row per writable
 * (source kind, type, target kind) triple. It is the single authority behind
 * `isAllowedRelationKindTriple` — the allowlist and the direction column cannot
 * drift apart because the allowlist is derived from this table.
 */
export interface CanonicalRelationDirection {
  readonly type: RelationType;
  readonly sourceKind: RelationEndpointKind;
  readonly targetKind: RelationEndpointKind;
  /** dec_mr74sbka: an active edge reads as `source <reads> target` in the storage direction. */
  readonly reads: string;
  /** The retired reverse alias this direction replaced, if the pair had one. The alias
   * stays parse-only vocabulary; reverse questions go through `incomingRelations`. */
  readonly replacedReverseAlias?: RelationType;
  /** "ratified" = registered reading. "unregistered" = the grammar allows the triple but
   * its semantics await an owner decision; new data should avoid leaning on it. */
  readonly registration: RelationDirectionRegistration;
}

/** decision → decision: policy lineage among decisions. */
export const canonicalRelationDirections: readonly CanonicalRelationDirection[] = [
  {
    type: "supersedes",
    sourceKind: "decision",
    targetKind: "decision",
    reads: "the decision supersedes the target decision",
    registration: "ratified",
  },
  {
    type: "refines",
    sourceKind: "decision",
    targetKind: "decision",
    reads: "the decision refines the target decision",
    registration: "ratified",
  },
  {
    type: "narrows",
    sourceKind: "decision",
    targetKind: "decision",
    reads: "the decision narrows the target decision",
    registration: "ratified",
  },
  {
    type: "relates",
    sourceKind: "decision",
    targetKind: "decision",
    reads: "the decision relates to the target decision",
    registration: "ratified",
  },
  {
    type: "derives",
    sourceKind: "decision",
    targetKind: "decision",
    reads: "the decision spawns the target decision",
    registration: "ratified",
  },
  {
    type: "supports",
    sourceKind: "decision",
    targetKind: "decision",
    reads: "the decision supports the target decision",
    registration: "ratified",
  },
  // Allowed by the ratified sentence grammar; zero stored edges and no registered semantics.
  {
    type: "blocks",
    sourceKind: "decision",
    targetKind: "decision",
    reads: "the decision blocks the target decision",
    registration: "unregistered",
  },
  // decision → task
  {
    type: "derives",
    sourceKind: "decision",
    targetKind: "task",
    reads: "the decision spawns the target task",
    registration: "ratified",
  },
  {
    type: "relates",
    sourceKind: "decision",
    targetKind: "task",
    reads: "the decision was later found to relate to the target task",
    registration: "ratified",
  },
  // decision → fact: evidence verbs are authored from the decision side so the sentence
  // reads in the storage direction (dec_mr74sbka; the 2026-07-05 migration moved every
  // evidence edge off the retired "supports" alias).
  {
    type: "evidenced-by",
    sourceKind: "decision",
    targetKind: "fact",
    reads: "the decision is evidenced-by the target fact",
    replacedReverseAlias: "supports",
    registration: "ratified",
  },
  {
    type: "refuted-by",
    sourceKind: "decision",
    targetKind: "fact",
    reads: "the decision is refuted-by the target fact",
    replacedReverseAlias: "invalidated-by",
    registration: "ratified",
  },
  // task → decision
  {
    type: "implements",
    sourceKind: "task",
    targetKind: "decision",
    reads: "the task implements the target decision",
    registration: "ratified",
  },
  // task → task: the source task is the blocked party; the mirrored "blocks" verb
  // (target blocked) is retired vocabulary, never a writable triple.
  {
    type: "depends-on",
    sourceKind: "task",
    targetKind: "task",
    reads: "the source task depends on the target task",
    replacedReverseAlias: "blocks",
    registration: "ratified",
  },
  {
    type: "relates",
    sourceKind: "task",
    targetKind: "task",
    reads: "the task relates to the target task",
    registration: "ratified",
  },
  // task → fact
  {
    type: "produces",
    sourceKind: "task",
    targetKind: "fact",
    reads: "the task produces the target fact",
    registration: "ratified",
  },
  {
    type: "evidences",
    sourceKind: "task",
    targetKind: "fact",
    reads: "the task evidences the target fact",
    registration: "ratified",
  },
  // fact → fact: only the target is stale; the source is the replacement.
  {
    type: "supersedes-fact",
    sourceKind: "fact",
    targetKind: "fact",
    reads: "the fact supersedes the target fact",
    registration: "ratified",
  },
  // Phase 1 execution/review/runtime relations. `owns` is a read-only semantic
  // projection of task.createdBy.principal, so it is registered for direction
  // and reverse-query purposes but is not a writable relation edge.
  {
    type: "executes",
    sourceKind: "execution",
    targetKind: "task",
    reads: "the execution executes the target task",
    registration: "ratified",
  },
  {
    type: "executes",
    sourceKind: "runtime-session",
    targetKind: "task",
    reads: "the runtime session executes the target task",
    registration: "ratified",
  },
  {
    type: "reviews",
    sourceKind: "review",
    targetKind: "execution",
    reads: "the review reviews the target execution",
    registration: "ratified",
  },
  {
    type: "owns",
    sourceKind: "task",
    targetKind: "agent",
    reads: "the task is owned by the agent derived from createdBy.principal",
    registration: "derived",
  },
  {
    type: "dispatches",
    sourceKind: "agent",
    targetKind: "runtime-session",
    reads: "the agent dispatches the target runtime session",
    registration: "ratified",
  },
  {
    type: "authorizes",
    sourceKind: "policy",
    targetKind: "execution",
    reads: "the policy authorizes the target execution",
    registration: "ratified",
  },
];

/** Minimal structural shape the reverse query needs; callers keep their own richer rows. */
export interface DirectedRelationEdge {
  readonly source: string;
  readonly target: string;
  readonly type: RelationType;
}

/**
 * The one reverse-direction query (blueprint 铁律三). Canonical edges read
 * `source <verb> target`, so the reverse question at an endpoint — "which decisions
 * cite this fact", "which tasks does this task block", "what supersedes this fact" —
 * is always "the edges of that type whose target it is". Consumers must call this
 * instead of re-deriving direction from endpoint shapes.
 */
export function incomingRelations<E extends DirectedRelationEdge>(
  targetRef: string,
  type: RelationType,
  edges: readonly E[],
): readonly E[] {
  return edges.filter((edge) => edge.target === targetRef && edge.type === type);
}
