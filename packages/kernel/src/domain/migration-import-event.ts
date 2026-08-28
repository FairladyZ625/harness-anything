import {
  deriveRelationId,
  relationDirections,
  relationOrigins,
  relationStates,
  relationStrengths,
  relationTypes,
  type EntityRelationRecord,
} from "./entity-relation.ts";
import { decisionStates, type DecisionDocumentState } from "./decision-event.ts";
import {
  factConfidenceLevels,
  factMemoryClasses,
  factMemoryTags,
  factProvenanceRuntimes,
  type FactConfidence,
  type FactMemoryClass,
  type FactMemoryTag,
  type FactProvenanceRuntime,
} from "./fact-event.ts";
import { validateTaskV1, type TaskV1 } from "./task.ts";
import {
  freezeDeclaredWritePlan,
  hasOnlyFields,
  hasRequiredFields,
  isFrozenWritePlan,
  isNonEmptyString,
  isRecord,
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
  type FrozenWritePlan,
  type WriteTarget,
} from "./write-chain.contract.ts";
import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import { stableStringify } from "../integrity/stable-hash.ts";
import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import { validateArchivedExecutionV0, type ArchivedExecutionV0 } from "./execution.ts";
import { timestamp } from "./timestamp.ts";

export const MIGRATION_IMPORT_SOURCE = "migration-import/v1" as const;
export const MIGRATION_DOCUMENT_POLICY_ID = "typed-migration-import/v1" as const;
export interface MigrationDocumentClaim {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly policyId: typeof MIGRATION_DOCUMENT_POLICY_ID;
}
export interface MigrationReferencedContentClaim {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}
export interface MigrationDestinationPreimage {
  readonly nodeKind: "file" | "symbolic-link";
  readonly sha256: string;
  readonly size: number;
}
export interface MigrationFact {
  readonly taskId?: string;
  readonly factId: string;
  readonly statement: string;
  readonly evidenceSource: string;
  readonly observedAt: string;
  readonly confidence: FactConfidence;
  readonly memoryClass: FactMemoryClass;
  readonly memoryTags: readonly FactMemoryTag[];
  readonly provenance: readonly {
    readonly runtime: FactProvenanceRuntime;
    readonly sessionId: string;
    readonly boundAt: string;
  }[];
}
export type MigrationEntity =
  | {
      readonly kind: "task";
      readonly task: TaskV1;
      readonly originalStatus: string;
      readonly packagePath: string;
      readonly documentClaim: MigrationDocumentClaim;
    }
  | {
      readonly kind: "decision";
      readonly decision: DecisionDocumentState;
      readonly documentClaim: MigrationDocumentClaim;
    }
  | { readonly kind: "fact"; readonly fact: MigrationFact; readonly documentClaim: MigrationDocumentClaim }
  | {
      readonly kind: "execution";
      readonly execution: ArchivedExecutionV0;
      readonly documentClaim: MigrationDocumentClaim;
    }
  | { readonly kind: "task-document"; readonly taskId: string; readonly documentClaim: MigrationDocumentClaim }
  | {
      readonly kind: "repo-document";
      readonly nodeKind: "file" | "symbolic-link";
      readonly documentClaim: MigrationDocumentClaim;
      readonly referencedContentClaims: readonly MigrationReferencedContentClaim[];
      readonly destinationPreimage?: MigrationDestinationPreimage;
    }
  | { readonly kind: "relation"; readonly relation: EntityRelationRecord; readonly ownerRef: string }
  | { readonly kind: "id-map"; readonly importId: string; readonly documentClaim: MigrationDocumentClaim };
export type MigrationImportEventV1 = EventEnvelope<
  "migration-import-event/v1",
  "entity_migrated",
  ActorIdentity,
  { readonly migratedFrom: string; readonly generation: "v0"; readonly entity: MigrationEntity }
> & { readonly source: typeof MIGRATION_IMPORT_SOURCE };

export function isMigrationImportEvent(event: { readonly schema: string }): event is MigrationImportEventV1 {
  return event.schema === "migration-import-event/v1";
}
export function migrationImportClaims(event: MigrationImportEventV1): readonly MigrationDocumentClaim[] {
  return "documentClaim" in event.payload.entity ? [event.payload.entity.documentClaim] : [];
}
export function migrationImportContentClaims(
  event: MigrationImportEventV1,
): readonly (MigrationDocumentClaim | MigrationReferencedContentClaim)[] {
  const entity = event.payload.entity;
  return [...migrationImportClaims(event), ...(entity.kind === "repo-document" ? entity.referencedContentClaims : [])];
}
export function validateMigrationImportEvent(value: unknown): readonly string[] {
  return validateMigrationImportEventFields(value, true);
}
export function validateCurrentMigrationImportEvent(value: unknown): readonly string[] {
  return validateMigrationImportEventFields(value, false);
}
function validateMigrationImportEventFields(value: unknown, allowUnknownFields: boolean): readonly string[] {
  if (
    !isRecord(value) ||
    !matchesMigrationFields(
      value,
      ["schema", "eventId", "workspaceRevision", "opId", "type", "actor", "source", "occurredAt", "payload"],
      allowUnknownFields,
    ) ||
    value.schema !== "migration-import-event/v1" ||
    value.type !== "entity_migrated" ||
    value.source !== MIGRATION_IMPORT_SOURCE ||
    !isRecord(value.payload) ||
    !matchesMigrationFields(value.payload, ["migratedFrom", "generation", "entity"], allowUnknownFields) ||
    !isNonEmptyString(value.payload.migratedFrom) ||
    value.payload.generation !== "v0" ||
    !isRecord(value.payload.entity)
  )
    return ["migration import event envelope or provenance is invalid"];
  if (validateEventEnvelopeIdentity(value, allowUnknownFields).length)
    return ["migration import event identity is invalid"];
  const entity = value.payload.entity;
  if (entity.kind === "task")
    return validTaskEntity(entity, allowUnknownFields) ? [] : ["migration task entity is invalid"];
  if (entity.kind === "decision")
    return validDecisionEntity(entity, allowUnknownFields) ? [] : ["migration decision entity is invalid"];
  if (entity.kind === "fact")
    return validFactEntity(entity, allowUnknownFields) ? [] : ["migration fact entity is invalid"];
  if (entity.kind === "execution")
    return validExecutionEntity(entity, allowUnknownFields) ? [] : ["migration execution entity is invalid"];
  if (entity.kind === "task-document")
    return validTaskDocumentEntity(entity, allowUnknownFields) ? [] : ["migration task document entity is invalid"];
  if (entity.kind === "repo-document")
    return validRepoDocumentEntity(entity, allowUnknownFields) ? [] : ["migration repo document entity is invalid"];
  if (entity.kind === "relation")
    return validRelationEntity(entity, allowUnknownFields) ? [] : ["migration relation entity is invalid"];
  return entity.kind === "id-map" &&
    matchesMigrationFields(entity, ["kind", "importId", "documentClaim"], allowUnknownFields) &&
    isNonEmptyString(entity.importId) &&
    validMigrationClaim(entity.documentClaim, "application/json", allowUnknownFields)
    ? []
    : ["migration id-map entity is invalid"];
}
export function migrationImportWritePlan(event: MigrationImportEventV1): FrozenWritePlan<"MigrationImport"> {
  const entity = event.payload.entity,
    key = event.payload.migratedFrom,
    targets: WriteTarget[] = [
      { kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" },
      { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
      { kind: "projection_invalidation", projection: `migration-${entity.kind}/v1`, key },
    ];
  for (const claim of migrationImportClaims(event))
    targets.push(
      {
        kind: "authored_file",
        path: claim.path,
        operation: "replace",
        sha256: claim.sha256,
        size: claim.size,
        mediaType: claim.mediaType,
      },
      { kind: "content_blob", sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType },
      { kind: "projection_invalidation", projection: "document/v1", key: claim.path },
    );
  if (entity.kind === "repo-document")
    for (const claim of entity.referencedContentClaims)
      targets.push({ kind: "content_blob", sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType });
  return freezeDeclaredWritePlan({ commandType: "MigrationImport", targets }, ["MigrationImport"]);
}
export function assertMigrationImportWritePlan(event: MigrationImportEventV1, plan: FrozenWritePlan | undefined): void {
  const shape = (value: FrozenWritePlan) =>
    stableStringify({ commandType: value.commandType, targets: value.targets.map(stableStringify).sort() });
  if (!plan || !isFrozenWritePlan(plan) || shape(plan) !== shape(migrationImportWritePlan(event)))
    throw new Error("migration import plan must exactly declare event, entity, document, and blob targets");
}

function matchesMigrationFields(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  allowUnknownFields: boolean,
): boolean {
  return (allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, fields);
}
function validTaskEntity(value: Readonly<Record<string, unknown>>, allowUnknownFields: boolean): boolean {
  return (
    matchesMigrationFields(
      value,
      ["kind", "task", "originalStatus", "packagePath", "documentClaim"],
      allowUnknownFields,
    ) &&
    validateTaskV1(value.task, allowUnknownFields).length === 0 &&
    isNonEmptyString(value.originalStatus) &&
    typeof value.packagePath === "string" &&
    value.packagePath.startsWith(`tasks/${(value.task as TaskV1).taskId}-`) &&
    validMigrationClaim(value.documentClaim, "text/markdown", allowUnknownFields) &&
    (value.documentClaim as MigrationDocumentClaim).path === `${value.packagePath}/INDEX.md`
  );
}
function validDecisionEntity(value: Readonly<Record<string, unknown>>, allowUnknownFields: boolean): boolean {
  if (
    !matchesMigrationFields(value, ["kind", "decision", "documentClaim"], allowUnknownFields) ||
    !isRecord(value.decision) ||
    !validMigrationClaim(value.documentClaim, "text/markdown", allowUnknownFields)
  )
    return false;
  const decision = value.decision,
    claim = value.documentClaim as MigrationDocumentClaim;
  return (
    /^dec_[A-Za-z0-9_-]+$/u.test(String(decision.decisionId)) &&
    (decisionStates as readonly unknown[]).includes(decision.state) &&
    isNonEmptyString(decision.title) &&
    timestamp(decision.proposedAt) &&
    (decision.decidedAt === null || timestamp(decision.decidedAt)) &&
    claim.path === `decisions/decision-${String(decision.decisionId)}/decision.md` &&
    Array.isArray(decision.chosen) &&
    Array.isArray(decision.rejected) &&
    Array.isArray(decision.claims) &&
    Array.isArray(decision.relations) &&
    Array.isArray(decision.judgmentConsents)
  );
}
function validFactEntity(value: Readonly<Record<string, unknown>>, allowUnknownFields: boolean): boolean {
  if (
    !matchesMigrationFields(value, ["kind", "fact", "documentClaim"], allowUnknownFields) ||
    !isRecord(value.fact) ||
    !validMigrationClaim(value.documentClaim, "text/markdown", allowUnknownFields)
  )
    return false;
  const fact = value.fact;
  return (
    (fact.taskId === undefined || isNonEmptyString(fact.taskId)) &&
    /^F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(String(fact.factId)) &&
    isNonEmptyString(fact.statement) &&
    isNonEmptyString(fact.evidenceSource) &&
    timestamp(fact.observedAt) &&
    (factConfidenceLevels as readonly unknown[]).includes(fact.confidence) &&
    (factMemoryClasses as readonly unknown[]).includes(fact.memoryClass) &&
    Array.isArray(fact.memoryTags) &&
    fact.memoryTags.every((tag) => (factMemoryTags as readonly unknown[]).includes(tag)) &&
    Array.isArray(fact.provenance) &&
    fact.provenance.length > 0 &&
    fact.provenance.every(
      (entry) =>
        isRecord(entry) &&
        matchesMigrationFields(entry, ["runtime", "sessionId", "boundAt"], allowUnknownFields) &&
        (factProvenanceRuntimes as readonly unknown[]).includes(entry.runtime) &&
        isNonEmptyString(entry.sessionId) &&
        timestamp(entry.boundAt),
    )
  );
}
function validExecutionEntity(value: Readonly<Record<string, unknown>>, allowUnknownFields: boolean): boolean {
  if (
    !matchesMigrationFields(value, ["kind", "execution", "documentClaim"], allowUnknownFields) ||
    validateArchivedExecutionV0(value.execution, allowUnknownFields).length ||
    !validMigrationClaim(value.documentClaim, "application/json", allowUnknownFields)
  )
    return false;
  const execution = value.execution as ArchivedExecutionV0,
    claim = value.documentClaim as MigrationDocumentClaim;
  return (
    claim.path.startsWith(`tasks/${execution.taskId}-`) &&
    claim.path.endsWith(`/executions/${execution.executionId}.md`)
  );
}
function validTaskDocumentEntity(value: Readonly<Record<string, unknown>>, allowUnknownFields: boolean): boolean {
  if (
    !matchesMigrationFields(value, ["kind", "taskId", "documentClaim"], allowUnknownFields) ||
    !isNonEmptyString(value.taskId) ||
    !validMigrationClaim(value.documentClaim, undefined, allowUnknownFields)
  )
    return false;
  const claim = value.documentClaim as MigrationDocumentClaim;
  return (
    claim.path.startsWith(`tasks/${value.taskId}-`) &&
    !/^tasks\/[^/]+\/INDEX\.md$/u.test(claim.path) &&
    !/^tasks\/[^/]+\/executions\/[^/]+\.md$/u.test(claim.path)
  );
}
function validRepoDocumentEntity(value: Readonly<Record<string, unknown>>, allowUnknownFields: boolean): boolean {
  const fields = [
    "kind",
    "nodeKind",
    "documentClaim",
    "referencedContentClaims",
    ...(value.destinationPreimage === undefined ? [] : ["destinationPreimage"]),
  ];
  if (
    !matchesMigrationFields(value, fields, allowUnknownFields) ||
    !["file", "symbolic-link"].includes(String(value.nodeKind)) ||
    !validMigrationClaim(value.documentClaim, undefined, allowUnknownFields) ||
    (value.destinationPreimage !== undefined &&
      !validDestinationPreimage(value.destinationPreimage, allowUnknownFields)) ||
    !Array.isArray(value.referencedContentClaims) ||
    !value.referencedContentClaims.every((claim) => validReferencedContentClaim(claim, allowUnknownFields))
  )
    return false;
  const claim = value.documentClaim as MigrationDocumentClaim,
    references = value.referencedContentClaims as readonly MigrationReferencedContentClaim[],
    hashes = references.map(({ sha256 }) => sha256),
    reserved = /^(?:presets(?:\/|$)|objects(?:\/|$)|events(?:\/|$))/u.test(claim.path) || claim.path === "harness.yaml",
    packageDocument = /^(?:tasks|decisions)\/[^/]+\//u.test(claim.path);
  return (
    new Set(hashes).size === hashes.length &&
    !hashes.includes(claim.sha256) &&
    !reserved &&
    (value.nodeKind === "symbolic-link" || !packageDocument)
  );
}
function validRelationEntity(value: Readonly<Record<string, unknown>>, allowUnknownFields: boolean): boolean {
  if (
    !matchesMigrationFields(value, ["kind", "relation", "ownerRef"], allowUnknownFields) ||
    !isRecord(value.relation) ||
    !isNonEmptyString(value.ownerRef)
  )
    return false;
  const relation = value.relation;
  return (
    matchesMigrationFields(
      relation,
      ["relation_id", "source", "target", "type", "strength", "direction", "origin", "rationale", "state"],
      allowUnknownFields,
    ) &&
    relation.relation_id === deriveRelationId(relation as unknown as EntityRelationRecord) &&
    isNonEmptyString(relation.source) &&
    isNonEmptyString(relation.target) &&
    (relationTypes as readonly unknown[]).includes(relation.type) &&
    (relationStrengths as readonly unknown[]).includes(relation.strength) &&
    (relationDirections as readonly unknown[]).includes(relation.direction) &&
    (relationOrigins as readonly unknown[]).includes(relation.origin) &&
    (relationStates as readonly unknown[]).includes(relation.state) &&
    isNonEmptyString(relation.rationale)
  );
}
function validMigrationClaim(
  value: unknown,
  mediaType: MigrationDocumentClaim["mediaType"] | undefined,
  allowUnknownFields: boolean,
): value is MigrationDocumentClaim {
  if (
    !isRecord(value) ||
    !matchesMigrationFields(value, ["path", "sha256", "size", "mediaType", "policyId"], allowUnknownFields) ||
    !isNonEmptyString(value.mediaType) ||
    (mediaType !== undefined && value.mediaType !== mediaType) ||
    value.policyId !== MIGRATION_DOCUMENT_POLICY_ID ||
    !/^[0-9a-f]{64}$/u.test(String(value.sha256)) ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0
  )
    return false;
  try {
    return normalizeRelativeDocumentPath(String(value.path)) === value.path;
  } catch {
    return false;
  }
}
function validReferencedContentClaim(
  value: unknown,
  allowUnknownFields: boolean,
): value is MigrationReferencedContentClaim {
  return (
    isRecord(value) &&
    matchesMigrationFields(value, ["sha256", "size", "mediaType"], allowUnknownFields) &&
    /^[0-9a-f]{64}$/u.test(String(value.sha256)) &&
    Number.isSafeInteger(value.size) &&
    (value.size as number) >= 0 &&
    isNonEmptyString(value.mediaType)
  );
}
function validDestinationPreimage(value: unknown, allowUnknownFields: boolean): value is MigrationDestinationPreimage {
  return (
    isRecord(value) &&
    matchesMigrationFields(value, ["nodeKind", "sha256", "size"], allowUnknownFields) &&
    ["file", "symbolic-link"].includes(String(value.nodeKind)) &&
    /^[0-9a-f]{64}$/u.test(String(value.sha256)) &&
    Number.isSafeInteger(value.size) &&
    (value.size as number) >= 0
  );
}
