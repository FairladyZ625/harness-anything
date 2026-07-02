import { sha256Text } from "../integrity/stable-hash.ts";
import { parseEntityRef } from "./entity-ref.ts";
import type { ParsedEntityRef } from "./entity-ref.ts";

export const relationTypes = [
  "supports",
  "supersedes",
  "derives",
  "blocks",
  "relates",
  "implements",
  "invalidated-by",
  "supersedes-fact"
] as const;

export const relationStrengths = ["strong", "weak"] as const;
export const relationDirections = ["directed", "undirected"] as const;
export const relationOrigins = ["declared", "imported_snapshot", "generated", "inferred"] as const;
export const relationStates = ["active", "deprecated", "deleted"] as const;

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

function requiresRationale(record: EntityRelationRecord): boolean {
  return record.strength === "strong" ||
    record.type === "supports" ||
    record.type === "blocks" ||
    record.type === "supersedes" ||
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
