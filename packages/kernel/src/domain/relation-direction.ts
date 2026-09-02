import type { RelationStrength, RelationType } from "./entity-relation.ts";
import { entityTypeContracts, type EntityKind } from "./base-entity.ts";

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
  readonly sourceKind: string;
  readonly targetKind: string;
  /** dec_mr74sbka: an active edge reads as `source <reads> target` in the storage direction. */
  readonly reads: string;
  /** The retired reverse alias this direction replaced, if the pair had one. The alias
   * stays parse-only vocabulary; reverse questions go through `incomingRelations`. */
  readonly replacedReverseAlias?: RelationType;
  /** "ratified" = registered reading. "unregistered" = the grammar allows the triple but
   * its semantics await an owner decision; new data should avoid leaning on it. */
  readonly registration: RelationDirectionRegistration;
  /** Code rows leave strength unconstrained. Governed vertical rows pin the only
   * strength that may be written through that compiled registry revision. */
  readonly strength?: RelationStrength;
  /** Present only on governed vertical rows. This is an approval witness, not a
   * second relation allowlist; writability still derives from this registry row. */
  readonly governance?: {
    readonly decisionClaimRef: string;
    readonly decisionContentPin: `sha256:${string}`;
    readonly rationale?: string;
  };
}

/** Canonical Relation endpoint kinds derive from the BaseEntity contracts. */
export const relationEndpointKinds = Object.freeze(
  entityTypeContracts.filter(({ relationEndpoint }) => relationEndpoint.eligible).map(({ kind }) => kind),
);

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
  ...entityTypeContracts.flatMap(({ kind }) => {
    const outgoing: CanonicalRelationDirection = {
        type: "relates",
        sourceKind: "relation",
        targetKind: kind,
        reads: `the relation relates to the target ${kind}`,
        registration: "ratified",
      },
      incoming: CanonicalRelationDirection = {
        type: "relates",
        sourceKind: kind,
        targetKind: "relation",
        reads: `the ${kind} relates to the target relation`,
        registration: "ratified",
      };
    return kind === "relation" ? [outgoing] : [outgoing, incoming];
  }),
];

/**
 * Build the one runtime registry consumed by relation admission. Kernel rows stay
 * authoritative and governed rows can only add new, already-compiled cells.
 */
export function composeCanonicalRelationDirections(
  compiledRows: readonly CanonicalRelationDirection[],
): readonly CanonicalRelationDirection[] {
  const rows = new Map<string, CanonicalRelationDirection>();
  for (const row of [...canonicalRelationDirections, ...compiledRows]) {
    const key = relationDirectionKey(row),
      previous = rows.get(key);
    if (!previous) {
      rows.set(key, row);
      continue;
    }
    if (!sameDirectionGovernance(previous, row)) {
      throw new Error(
        `Conflicting relation direction governance for ${row.sourceKind} --${row.type}--> ${row.targetKind}.`,
      );
    }
  }
  return Object.freeze([...rows.values()].map((row) => Object.freeze(row)));
}

export function relationDirectionKey(
  row: Pick<CanonicalRelationDirection, "sourceKind" | "type" | "targetKind">,
): string {
  return `${row.sourceKind}|${row.type}|${row.targetKind}`;
}

function sameDirectionGovernance(left: CanonicalRelationDirection, right: CanonicalRelationDirection): boolean {
  return (
    left.reads === right.reads &&
    left.registration === right.registration &&
    left.strength === right.strength &&
    JSON.stringify(left.governance ?? null) === JSON.stringify(right.governance ?? null)
  );
}

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
