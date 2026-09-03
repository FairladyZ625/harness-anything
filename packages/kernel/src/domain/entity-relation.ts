import { sha256Text } from "../integrity/stable-hash.ts";
import { parseEntityRef } from "./entity-ref.ts";
import type { ParsedEntityRef } from "./entity-ref.ts";
import { canonicalRelationDirections, type CanonicalRelationDirection } from "./relation-direction.ts";
import type { RelationFreshness } from "./entity-freshness.ts";
import { isRecord } from "./write-chain.contract.ts";

export const relationTypes = [
  "supports",
  "supersedes",
  "refines",
  "narrows",
  "derives",
  "blocks",
  "relates",
  "implements",
  "depends-on",
  "produces",
  "evidences",
  "evidenced-by",
  "refuted-by",
  "invalidated-by",
  "supersedes-fact",
  "executes",
  "reviews",
  "owns",
  "dispatches",
  "authorizes",
] as const;

export const relationStrengths = ["strong", "weak"] as const;
export const relationDirections = ["directed", "undirected"] as const;
export const relationOrigins = ["declared", "imported_snapshot", "generated", "inferred"] as const;
export const relationStates = ["active", "retired"] as const;

export type RelationType = (typeof relationTypes)[number];
export type RelationStrength = (typeof relationStrengths)[number];
export type RelationDirection = (typeof relationDirections)[number];
export type RelationOrigin = (typeof relationOrigins)[number];
export type RelationState = (typeof relationStates)[number];
export type RelationConsumability = "consumable" | "warn" | "refuse";

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

export interface GovernedRelationRegistryWitness {
  readonly schema: "governed-relation-registry-witness/v1";
  readonly registryRevision: `sha256:${string}`;
  readonly artifactEndpoints: readonly {
    readonly kind: string;
    readonly idPattern: string;
    readonly refTemplate: string;
  }[];
  readonly direction: CanonicalRelationDirection;
}

export function relationStrengthForType(type: RelationType): RelationStrength {
  return type === "relates" ? "weak" : "strong";
}

export function normalizeLegacyRelationState(state: unknown): RelationState {
  if (state === "edge_retired") return "retired";
  if ((relationStates as readonly unknown[]).includes(state)) return state as RelationState;
  throw new Error(`relation migration state is invalid: ${String(state)}`);
}

export function relationConsumability(
  edge: Pick<EntityRelationRecord, "strength"> & { readonly freshness: RelationFreshness },
): RelationConsumability {
  if (edge.freshness === "current") return "consumable";
  return edge.strength === "weak" ? "warn" : "refuse";
}

/** Whether an edge currently carries domain semantics at this projection cut. */
export function relationIsCurrent(
  edge: Pick<EntityRelationRecord, "strength"> & {
    readonly state: string;
    readonly freshness: RelationFreshness;
  },
): boolean {
  return edge.state === "active" && relationConsumability(edge) !== "refuse";
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

export function canonicalRelationIdentityInput(
  record: Pick<EntityRelationRecord, "source" | "target" | "type" | "direction">,
): string {
  return `${record.source}|${record.target}|${record.type}|${record.direction}`;
}

export function deriveRelationId(
  record: Pick<EntityRelationRecord, "source" | "target" | "type" | "direction">,
): string {
  const suffix = sha256Text(canonicalRelationIdentityInput(record)).slice(0, 16);
  return `rel_${suffix}`;
}

export function formatRelationFlowRecord(record: EntityRelationRecord): string {
  return `- {relation_id: ${record.relation_id}, source: ${record.source}, target: ${record.target}, type: ${record.type}, strength: ${record.strength}, direction: ${record.direction}, origin: ${record.origin}, rationale: ${quoteFlowString(record.rationale)}, state: ${record.state}}`;
}

export function validateRelationRecordsForHost(
  host: string,
  records: ReadonlyArray<EntityRelationRecord>,
  registry: readonly CanonicalRelationDirection[] = canonicalRelationDirections,
): ReadonlyArray<EntityRelationValidationIssue> {
  const issues: EntityRelationValidationIssue[] = [];
  const hostRef = parseEntityRef(host);
  if (!hostRef || hostRef.externalHarness) {
    issues.push({
      code: "invalid_relation_endpoint",
      message: `Invalid relation host: ${host}`,
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
        message: `Invalid relation endpoint for ${record.relation_id}`,
      });
      continue;
    }

    // The type-subset whitelist only governs live edges. Retired records are
    // audit history: a migration retires an illegal edge in place, and re-validating the
    // corpse would permanently block every future write to the host document.
    if (record.state === "active" && !isAllowedRelationRecord(record, source.kind, target.kind, registry)) {
      issues.push({
        code: "invalid_relation_type_subset",
        relationId: record.relation_id,
        message: `Relation ${record.relation_id} type ${record.type} is not allowed for ${source.kind}->${target.kind}`,
      });
    }

    if (!hostOwnsSource(hostRef, source)) {
      issues.push({
        code: "relation_host_source_mismatch",
        relationId: record.relation_id,
        message: `Relation ${record.relation_id} is hosted by ${host}, but source is ${record.source}`,
      });
    }

    const expectedRelationId = deriveRelationId(record);
    if (record.relation_id !== expectedRelationId) {
      issues.push({
        code: "relation_id_mismatch",
        relationId: record.relation_id,
        message: `Relation ${record.relation_id} should be ${expectedRelationId}`,
      });
    }

    if (seenRelationIds.has(record.relation_id)) {
      issues.push({
        code: "duplicate_relation_id",
        relationId: record.relation_id,
        message: `Duplicate relation_id ${record.relation_id}`,
      });
    }
    seenRelationIds.add(record.relation_id);

    if (requiresRationale(record) && record.rationale.trim().length === 0) {
      issues.push({
        code: "relation_rationale_missing",
        relationId: record.relation_id,
        message: `Relation ${record.relation_id} requires a non-blank rationale`,
      });
    }
  }

  return issues;
}

export function relationOwnerRef(sourceRef: string): string {
  const source = parseEntityRef(sourceRef);
  return source?.kind === "decision" ? `decision/${source.id}` : sourceRef;
}

export function isAllowedRelationKindTriple(
  sourceKind: string,
  type: RelationType,
  targetKind: string,
  registry: readonly CanonicalRelationDirection[] = canonicalRelationDirections,
): boolean {
  // Ratified convention (dec_mr74sbka, 2026-07-05): every edge reads as one sentence,
  // `source <verb> target`, in the physical (host -> target) direction — no cell whose
  // verb reads backwards. The canonical direction registry is the single authority:
  // a triple is writable exactly when it has a registry row (one canonical direction
  // per semantic relation, blueprint 铁律三). Every reversed-direction pair keeps only
  // its canonical side writable — fact→decision supports/invalidated-by and task→task
  // blocks were retired with zero stored active edges (2026-08-17 census); the retired
  // aliases remain parse-only vocabulary and reverse questions go through
  // `incomingRelations` in relation-direction.ts.
  return registry.some(
    (direction) =>
      direction.registration !== "derived" &&
      direction.sourceKind === sourceKind &&
      direction.type === type &&
      direction.targetKind === targetKind,
  );
}

export function isAllowedRelationRecord(
  record: Pick<EntityRelationRecord, "type" | "strength">,
  sourceKind: string,
  targetKind: string,
  registry: readonly CanonicalRelationDirection[] = canonicalRelationDirections,
): boolean {
  return registry.some(
    (direction) =>
      direction.registration !== "derived" &&
      direction.sourceKind === sourceKind &&
      direction.type === record.type &&
      direction.targetKind === targetKind &&
      (direction.strength === undefined || direction.strength === record.strength),
  );
}

export function assertGovernedRelationRecord(
  record: EntityRelationRecord,
  witness: GovernedRelationRegistryWitness,
  allowUnknownFields = false,
): void {
  assertGovernedRelationRegistryWitness(witness, allowUnknownFields);
  const sourceKind = governedRelationEndpointKind(record.source, witness),
    targetKind = governedRelationEndpointKind(record.target, witness);
  if (!sourceKind || !targetKind)
    throw new Error("Governed Relation endpoints must match the witnessed registry revision");
  if (!isAllowedRelationRecord(record, sourceKind, targetKind, [witness.direction]))
    throw new Error(`Governed Relation ${sourceKind} --${record.type}--> ${targetKind} is not witnessed`);
}

export function assertGovernedRelationRegistryWitness(
  value: unknown,
  allowUnknownFields = false,
): asserts value is GovernedRelationRegistryWitness {
  if (!isRecord(value)) throw new Error("Governed Relation registry witness is invalid");
  const witness = value as unknown as GovernedRelationRegistryWitness,
    direction = witness.direction;
  if (
    (!allowUnknownFields &&
      Object.keys(witness).some(
        (field) => !["schema", "registryRevision", "artifactEndpoints", "direction"].includes(field),
      )) ||
    witness.schema !== "governed-relation-registry-witness/v1" ||
    !/^sha256:[0-9a-f]{64}$/u.test(witness.registryRevision) ||
    !Array.isArray(witness.artifactEndpoints) ||
    witness.artifactEndpoints.some((endpoint) => !validGovernedArtifactEndpoint(endpoint, allowUnknownFields)) ||
    new Set(witness.artifactEndpoints.map(({ kind }) => kind)).size !== witness.artifactEndpoints.length ||
    !isRecord(direction) ||
    typeof direction.sourceKind !== "string" ||
    !direction.sourceKind ||
    typeof direction.targetKind !== "string" ||
    !direction.targetKind ||
    !relationTypes.includes(direction.type) ||
    typeof direction.reads !== "string" ||
    !direction.reads.trim() ||
    direction.registration !== "ratified" ||
    direction.strength === undefined ||
    !relationStrengths.includes(direction.strength) ||
    !validGovernedRelationApproval(direction.governance)
  )
    throw new Error("Governed Relation registry witness is invalid");
}

function validGovernedRelationApproval(value: unknown): boolean {
  return (
    isRecord(value) &&
    /^decision\/dec_[A-Za-z0-9_-]+\/(?:CH|C)[1-9][0-9]*$/u.test(String(value.decisionClaimRef)) &&
    /^sha256:[0-9a-f]{64}$/u.test(String(value.decisionContentPin))
  );
}

function governedRelationEndpointKind(ref: string, witness: GovernedRelationRegistryWitness): string | null {
  const builtin = parseEntityRef(ref);
  if (builtin && !builtin.externalHarness) return builtin.kind;
  for (const endpoint of witness.artifactEndpoints) {
    const [prefix, suffix] = endpoint.refTemplate.split("{id}"),
      trailing = suffix ?? "";
    if (
      prefix === undefined ||
      !ref.startsWith(prefix) ||
      !ref.endsWith(trailing) ||
      ref.length <= prefix.length + trailing.length
    )
      continue;
    const id = ref.slice(prefix.length, trailing ? -trailing.length : undefined);
    if (new RegExp(endpoint.idPattern, "u").test(id)) return endpoint.kind;
  }
  return null;
}

function validGovernedArtifactEndpoint(
  value: unknown,
  allowUnknownFields: boolean,
): value is GovernedRelationRegistryWitness["artifactEndpoints"][number] {
  if (
    !isRecord(value) ||
    (!allowUnknownFields &&
      Object.keys(value).some((field) => !["kind", "idPattern", "refTemplate"].includes(field))) ||
    typeof value.kind !== "string" ||
    !value.kind ||
    typeof value.idPattern !== "string" ||
    !value.idPattern ||
    typeof value.refTemplate !== "string" ||
    value.refTemplate.split("{id}").length !== 2
  )
    return false;
  try {
    new RegExp(value.idPattern, "u");
    return true;
  } catch {
    return false;
  }
}

function requiresRationale(record: EntityRelationRecord): boolean {
  return (
    record.strength === "strong" ||
    record.type === "supports" ||
    record.type === "evidenced-by" ||
    record.type === "refuted-by" ||
    record.type === "blocks" ||
    record.type === "depends-on" ||
    record.type === "supersedes" ||
    record.type === "refines" ||
    record.type === "narrows" ||
    record.type === "supersedes-fact"
  );
}

function hostOwnsSource(host: ParsedEntityRef, source: ParsedEntityRef): boolean {
  if (host.kind !== source.kind) return false;
  return host.id === source.id;
}

function quoteFlowString(value: string): string {
  return JSON.stringify(value.replace(/\s+/gu, " ").trim());
}
