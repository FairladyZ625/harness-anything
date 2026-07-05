import { sha256Text } from "../integrity/stable-hash.ts";
import { parseEntityRef } from "./entity-ref.ts";
import type { ParsedEntityRef } from "./entity-ref.ts";

export const relationTypes = [
  "supports",
  "supersedes",
  "refines",
  "narrows",
  "derives",
  "blocks",
  "relates",
  "implements",
  "produces",
  "evidences",
  "evidenced-by",
  "invalidated-by",
  "supersedes-fact"
] as const;

export const relationStrengths = ["strong", "weak"] as const;
export const relationDirections = ["directed", "undirected"] as const;
export const relationOrigins = ["declared", "imported_snapshot", "generated", "inferred"] as const;
export const relationStates = ["active", "retired", "deleted"] as const;

export type RelationType = typeof relationTypes[number];
export type RelationStrength = typeof relationStrengths[number];
export type RelationDirection = typeof relationDirections[number];
export type RelationOrigin = typeof relationOrigins[number];
export type RelationState = typeof relationStates[number];

export interface EntityRelationRecord {
  readonly relation_id: string;
  readonly source: string;
  readonly target: string;
  readonly type: RelationType;
  readonly strength: RelationStrength;
  readonly direction: RelationDirection;
  readonly origin: RelationOrigin;
  readonly rationale: string;
  readonly state: RelationState;
}

export type EntityRelationValidationIssueCode =
  | "invalid_relation_endpoint"
  | "relation_host_source_mismatch"
  | "invalid_relation_type_subset"
  | "relation_id_mismatch"
  | "duplicate_relation_id"
  | "relation_rationale_missing";

export interface EntityRelationValidationIssue {
  readonly code: EntityRelationValidationIssueCode;
  readonly relationId?: string;
  readonly message: string;
}

export function canonicalRelationIdentityInput(record: Pick<EntityRelationRecord, "source" | "target" | "type" | "direction">): string {
  return `${record.source}|${record.target}|${record.type}|${record.direction}`;
}

export function deriveRelationId(record: Pick<EntityRelationRecord, "source" | "target" | "type" | "direction">): string {
  const suffix = sha256Text(canonicalRelationIdentityInput(record)).slice(0, 16);
  return `rel_${suffix}`;
}

export function formatRelationFlowRecord(record: EntityRelationRecord): string {
  return `- {relation_id: ${record.relation_id}, source: ${record.source}, target: ${record.target}, type: ${record.type}, strength: ${record.strength}, direction: ${record.direction}, origin: ${record.origin}, rationale: ${quoteFlowString(record.rationale)}, state: ${record.state}}`;
}

export function validateRelationRecordsForHost(host: string, records: ReadonlyArray<EntityRelationRecord>): ReadonlyArray<EntityRelationValidationIssue> {
  const issues: EntityRelationValidationIssue[] = [];
  const hostRef = parseEntityRef(host);
  if (!hostRef || hostRef.externalHarness) {
    issues.push({
      code: "invalid_relation_endpoint",
      message: `Invalid relation host: ${host}`
    });
    return issues;
  }

  const seenRelationIds = new Set<string>();
  for (const record of records) {
    const source = parseEntityRef(record.source);
    const target = parseEntityRef(record.target);
    if (!source || source.externalHarness || !target) {
      issues.push({
        code: "invalid_relation_endpoint",
        relationId: record.relation_id,
        message: `Invalid relation endpoint for ${record.relation_id}`
      });
      continue;
    }

    // The type-subset whitelist only governs live edges. Retired/deleted records are
    // audit history: a migration retires an illegal edge in place, and re-validating the
    // corpse would permanently block every future write to the host document.
    if (record.state === "active" && !isAllowedRelationKindTriple(source.kind, record.type, target.kind)) {
      issues.push({
        code: "invalid_relation_type_subset",
        relationId: record.relation_id,
        message: `Relation ${record.relation_id} type ${record.type} is not allowed for ${source.kind}->${target.kind}`
      });
    }

    if (!hostOwnsSource(hostRef, source)) {
      issues.push({
        code: "relation_host_source_mismatch",
        relationId: record.relation_id,
        message: `Relation ${record.relation_id} is hosted by ${host}, but source is ${record.source}`
      });
    }

    const expectedRelationId = deriveRelationId(record);
    if (record.relation_id !== expectedRelationId) {
      issues.push({
        code: "relation_id_mismatch",
        relationId: record.relation_id,
        message: `Relation ${record.relation_id} should be ${expectedRelationId}`
      });
    }

    if (seenRelationIds.has(record.relation_id)) {
      issues.push({
        code: "duplicate_relation_id",
        relationId: record.relation_id,
        message: `Duplicate relation_id ${record.relation_id}`
      });
    }
    seenRelationIds.add(record.relation_id);

    if (requiresRationale(record) && record.rationale.trim().length === 0) {
      issues.push({
        code: "relation_rationale_missing",
        relationId: record.relation_id,
        message: `Relation ${record.relation_id} requires a non-blank rationale`
      });
    }
  }

  return issues;
}

export function isAllowedRelationKindTriple(
  sourceKind: ParsedEntityRef["kind"],
  type: RelationType,
  targetKind: ParsedEntityRef["kind"]
): boolean {
  // Ratified convention (dec_mr74sbka, 2026-07-05): every edge reads as one sentence,
  // `source <verb> target`, in the physical (host -> target) direction — no cell whose
  // verb reads backwards. Verbs are chosen so the source is always the grammatical subject.
  if (sourceKind === "decision" && targetKind === "decision") {
    return type === "supersedes" || type === "refines" || type === "narrows" || type === "relates" ||
      type === "blocks" || type === "derives" || type === "supports";
  }
  // derives = "the decision spawns the task"; relates = the task was not born from this
  // decision but was later found to be connected to it.
  if (sourceKind === "decision" && targetKind === "task") return type === "derives" || type === "relates";
  // Evidence relation, authored from the decision side: "the decision is evidenced-by the
  // fact" — a decision-subject verb so the sentence reads in the storage direction.
  // "supports" is a transitional alias for existing edges; it is removed once the ledger
  // migration to evidenced-by completes.
  if (sourceKind === "decision" && targetKind === "fact") {
    return type === "supersedes-fact" || type === "evidenced-by" || type === "supports";
  }
  if (sourceKind === "task" && targetKind === "decision") return type === "implements";
  if (sourceKind === "task" && targetKind === "task") return type === "blocks" || type === "relates";
  if (sourceKind === "task" && targetKind === "fact") return type === "produces" || type === "evidences";
  if (sourceKind === "fact" && targetKind === "decision") return type === "supports" || type === "invalidated-by";
  if (sourceKind === "fact" && targetKind === "fact") return type === "supersedes-fact";
  return false;
}

function requiresRationale(record: EntityRelationRecord): boolean {
  return record.strength === "strong" ||
    record.type === "supports" ||
    record.type === "evidenced-by" ||
    record.type === "blocks" ||
    record.type === "supersedes" ||
    record.type === "refines" ||
    record.type === "narrows" ||
    record.type === "supersedes-fact" ||
    record.type === "invalidated-by";
}

function hostOwnsSource(host: ParsedEntityRef, source: ParsedEntityRef): boolean {
  if (host.kind !== source.kind) return false;
  if (host.kind === "fact" || source.kind === "fact") {
    return host.kind === "fact" &&
      source.kind === "fact" &&
      host.ownerTaskId === source.ownerTaskId &&
      host.id === source.id;
  }
  return host.id === source.id;
}

function quoteFlowString(value: string): string {
  return JSON.stringify(value.replace(/\s+/gu, " ").trim());
}
