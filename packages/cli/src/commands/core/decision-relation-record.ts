import { deriveRelationId, type EntityRelationRecord } from "../../../../kernel/src/index.ts";

export interface DecisionRelationInput {
  readonly decisionId: string;
  readonly anchor: string;
  readonly target: string;
  readonly relationType: EntityRelationRecord["type"];
  readonly rationale: string;
}

// Single source of truth for how a decision anchor relation is materialized.
// The CLI application layer and the daemon attempt compiler must build the
// exact same record from the same action, or admission rejects the wire
// payload (RELATION_PAYLOAD_INVALID) — the wire-parity invariant.
export function decisionRelationRecord(input: DecisionRelationInput): EntityRelationRecord {
  const base = {
    source: `decision/${input.decisionId}/${input.anchor}`,
    target: input.target,
    type: input.relationType,
    strength: "strong",
    direction: "directed",
    origin: "declared",
    rationale: input.rationale,
    state: "active"
  } satisfies Omit<EntityRelationRecord, "relation_id">;
  return { relation_id: deriveRelationId(base), ...base };
}
