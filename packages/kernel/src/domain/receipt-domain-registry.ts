import { validateActorIdentity } from "./actor-identity.ts";
import { isNonEmptyString } from "./contract-validation.ts";
import { parseEntityRef } from "./entity-ref.ts";
import type { AuthorizationDecision } from "./receipt-frame.ts";
import { RECEIPT_GUIDANCE_KINDS, type ReceiptGuidanceContractEntry } from "./entity-action-descriptor.ts";
export type { AuthorizationDecision, ReceiptJsonValue } from "./receipt-frame.ts";

export interface EntityActionUnmetCriterionV1 {
  readonly ref: string;
  readonly failureCode: string;
  readonly explain: string;
}

export type ReceiptDiagnostic =
  | {
      readonly kind: "missing-sections";
      readonly documentPath: string;
      readonly diskDiffers: boolean;
      readonly missingSections: readonly {
        readonly section: string;
        readonly reason: "empty" | "scaffold";
        readonly retainedScaffold?: string;
      }[];
    }
  | {
      readonly kind: "validation";
      readonly entity: string;
      readonly field: string;
      readonly actual: string;
      readonly expectation: string;
    }
  | {
      readonly kind: "workspace-boundary";
      readonly field: string;
      readonly workspaceRoot: string;
    }
  | {
      readonly kind: "materialization-failed";
      readonly lastCheckpointRevision: number;
      readonly lastCheckpointAt: string | null;
      readonly pendingWalEvents: number;
      readonly reason: "git_diverged" | "deterministic_failure" | "retry_budget_exhausted";
      readonly lastError: string;
    }
  | {
      readonly kind: "materialization-retrying";
      readonly state: "retrying";
      readonly lastCheckpointRevision: number;
      readonly lastCheckpointAt: string | null;
      readonly pendingWalEvents: number;
      readonly retryElapsedMs: number;
      readonly lastError: string;
    }
  | {
      readonly kind: "invalid-enum";
      readonly field: string;
      readonly actual: string;
      readonly allowedValues: readonly string[];
    }
  | {
      readonly kind: "failure";
      readonly code: string;
    };

export type ReceiptVisibility = "center" | { readonly kind: "replica"; readonly viewId: string };
export interface ReceiptProof {
  readonly committedRevision: number;
  readonly appliedCut: number;
  readonly ackCut?: number;
  readonly durable: boolean;
  readonly canonicalVisible: boolean;
  readonly worktreeVisible: boolean | null;
}
export interface DocSyncPathDetail {
  readonly path: string;
  readonly baseBlobSha256: string | null;
  readonly currentBlobSha256: string | null;
  readonly candidateBlobSha256: string | null;
}
export interface DocSyncDifference {
  readonly path: string;
  readonly regionId: string;
  readonly insertBytes: number;
  readonly deleteBytes: number;
  readonly replaceBytes: number;
  readonly firstChange: { readonly baseOffset: number; readonly candidateOffset: number } | null;
}
export interface DocSyncUnresolvedTouch {
  readonly path: string;
  readonly regionId: string | null;
  readonly anchor: string | null;
  readonly reason: string;
  readonly requiredRoute: string;
  readonly policy: string;
}
export interface DocSyncDeletion {
  readonly path: string;
  readonly baseBlobSha256: string;
  readonly source: "intent";
}
export interface DocSyncHolder {
  readonly taskId: string;
  readonly executionId: string;
  readonly personId: string;
  readonly executorId: string | null;
  readonly source: unknown;
  readonly expiresAt: string;
  readonly version: number;
}
export interface LedgerCutIdentity {
  readonly repoId: string;
  readonly revision: number;
  readonly headDigest: string;
}
export interface LedgerCommitIdentity {
  readonly repoId: string;
  readonly sha: string;
}
export type LedgerIdentity = LedgerCutIdentity | LedgerCommitIdentity;
export interface DocSyncReceiptDetail {
  readonly kind: "doc_sync";
  readonly code: string;
  readonly baseLedgerSha: LedgerIdentity;
  readonly currentLedgerSha: LedgerCutIdentity;
  readonly paths: readonly DocSyncPathDetail[];
  readonly holder: DocSyncHolder | null;
  readonly differences: readonly DocSyncDifference[];
  readonly unresolvedTouches: readonly DocSyncUnresolvedTouch[];
  readonly deletions: readonly DocSyncDeletion[];
  /** Legacy read compatibility only. New writers emit structured guidance on the receipt. */
  readonly nextAction?: string;
}
export interface EntityUpsertReceiptDetail {
  readonly kind: "entity_upsert";
  readonly entityKind: string;
  readonly entityId: string;
  readonly schemaId: string;
  readonly path: string;
}
export const receiptDetailRegistry = Object.freeze([
  { kind: "doc_sync", validate: validateDocSyncDetail },
  { kind: "entity_upsert", validate: validateEntityUpsertDetail },
] as const);
export type WriteReceiptDetail = DocSyncReceiptDetail | EntityUpsertReceiptDetail;
/** Internal mutation result before the center attaches its authorization decision. */
export interface WriteReceiptDraft {
  readonly outcome: "applied" | "pending" | "no_changes" | "indeterminate" | "op_rejected";
  readonly opId: string;
  readonly revision?: number;
  readonly code?: string;
  readonly origin?: string;
  readonly evidence?: string;
  readonly visibility?: ReceiptVisibility;
  readonly proof?: ReceiptProof;
  readonly detail?: WriteReceiptDetail;
  readonly commitSha?: string | null;
  readonly authorizationDecision?: AuthorizationDecision;
  readonly unmetCriteria?: readonly EntityActionUnmetCriterionV1[];
  readonly effects?: readonly string[];
  readonly updatedProjection?: {
    readonly kind: string;
    readonly ref: string;
    readonly revision: number | null;
  } | null;
  readonly rejectionExplanation?: string | null;
  /** Legacy read compatibility only. New writers emit guidance or diagnostic. */
  readonly nextAction?: string;
  readonly nextActions?: readonly string[];
  readonly guidance?: readonly ReceiptGuidanceContractEntry[];
  readonly diagnostic?: ReceiptDiagnostic;
  readonly cut?: {
    readonly repoId: string;
    readonly revision: number;
    readonly opId: string;
    readonly headDigest: string;
  };
}
/** Public durable-write receipt framed at the center's canonical cut. */
export interface WriteReceipt extends WriteReceiptDraft {
  readonly authorizationDecision: AuthorizationDecision;
}
export const WRITE_RECEIPT_SCHEMA = Object.freeze({
  id: "write-receipt/v1",
  outcomes: Object.freeze(["applied", "pending", "no_changes", "indeterminate", "op_rejected"] as const),
  required: Object.freeze(["outcome", "opId", "authorizationDecision"]),
  optional: Object.freeze([
    "revision",
    "code",
    "origin",
    "evidence",
    "visibility",
    "proof",
    "detail",
    "commitSha",
    "unmetCriteria",
    "effects",
    "updatedProjection",
    "rejectionExplanation",
    "nextAction",
    "nextActions",
    "guidance",
    "diagnostic",
    "cut",
  ]),
});
export function validateWriteReceipt(value: unknown): readonly string[] {
  if (!isReceiptDomainRecord(value)) return ["receipt must be an object"];
  const errors = Object.keys(value)
    .filter((key) => ![...WRITE_RECEIPT_SCHEMA.required, ...WRITE_RECEIPT_SCHEMA.optional].includes(key))
    .map((key) => `unexpected field: ${key}`);
  if (!(WRITE_RECEIPT_SCHEMA.outcomes as readonly unknown[]).includes(value.outcome))
    errors.push("receipt outcome is invalid");
  if (!isNonEmptyString(value.opId)) errors.push("opId is required");
  if ("revision" in value && !cut(value.revision)) errors.push("revision must be a non-negative integer");
  for (const field of ["code", "origin", "evidence"] as const)
    if (field in value && !isNonEmptyString(value[field])) errors.push(`${field} must be a non-empty string`);
  if ("nextAction" in value && !isNonEmptyString(value.nextAction))
    errors.push("nextAction must be a non-empty string");
  if (
    "unmetCriteria" in value &&
    (!Array.isArray(value.unmetCriteria) || value.unmetCriteria.some((entry) => !isEntityActionUnmetCriterion(entry)))
  )
    errors.push("unmetCriteria must be an array of structured criterion explanations");
  if (
    "nextActions" in value &&
    (!Array.isArray(value.nextActions) || value.nextActions.some((entry) => !isNonEmptyString(entry)))
  )
    errors.push("nextActions must be an array of commands or remediation steps");
  if (
    "guidance" in value &&
    (!Array.isArray(value.guidance) || value.guidance.some((entry) => !isReceiptGuidance(entry)))
  )
    errors.push("guidance must be an array of structured guidance entries");
  if ("diagnostic" in value && !isReceiptDiagnostic(value.diagnostic))
    errors.push("diagnostic must be a structured receipt diagnostic");
  if ("effects" in value && (!Array.isArray(value.effects) || value.effects.some((entry) => !isNonEmptyString(entry))))
    errors.push("effects must be an array of effect references");
  if (
    "rejectionExplanation" in value &&
    value.rejectionExplanation !== null &&
    !isNonEmptyString(value.rejectionExplanation)
  )
    errors.push("rejectionExplanation must be non-empty or null");
  if (
    "updatedProjection" in value &&
    value.updatedProjection !== null &&
    (!isReceiptDomainRecord(value.updatedProjection) ||
      !exact(value.updatedProjection, ["kind", "ref", "revision"]) ||
      !isNonEmptyString(value.updatedProjection.kind) ||
      !isNonEmptyString(value.updatedProjection.ref) ||
      (value.updatedProjection.revision !== null && !cut(value.updatedProjection.revision)))
  )
    errors.push("updatedProjection must identify a kind, ref, and revision");
  const visibility = value.visibility,
    replica =
      isReceiptDomainRecord(visibility) &&
      exact(visibility, ["kind", "viewId"]) &&
      visibility.kind === "replica" &&
      isNonEmptyString(visibility.viewId);
  if ("visibility" in value && visibility !== "center" && !replica)
    errors.push("visibility must be center or replica(viewId)");
  const proof = value.proof,
    proofFields =
      isReceiptDomainRecord(proof) && "ackCut" in proof
        ? ["committedRevision", "appliedCut", "ackCut", "durable", "canonicalVisible", "worktreeVisible"]
        : ["committedRevision", "appliedCut", "durable", "canonicalVisible", "worktreeVisible"];
  const validProof =
    isReceiptDomainRecord(proof) &&
    exact(proof, proofFields) &&
    cut(proof.committedRevision) &&
    cut(proof.appliedCut) &&
    (!("ackCut" in proof) || cut(proof.ackCut)) &&
    typeof proof.durable === "boolean" &&
    typeof proof.canonicalVisible === "boolean" &&
    (typeof proof.worktreeVisible === "boolean" || proof.worktreeVisible === null);
  if ("proof" in value && !validProof)
    errors.push("proof must carry durable, canonical-visible, worktree-visible, and non-negative revision cuts");
  if (
    "detail" in value &&
    !receiptDetailRegistry.some(
      (entry) =>
        isReceiptDomainRecord(value.detail) && value.detail.kind === entry.kind && entry.validate(value.detail),
    )
  )
    errors.push("detail must match a registered receipt domain");
  const publicationCut = value.cut,
    validPublicationCut =
      isReceiptDomainRecord(publicationCut) &&
      exact(publicationCut, ["repoId", "revision", "opId", "headDigest"]) &&
      isNonEmptyString(publicationCut.repoId) &&
      cut(publicationCut.revision) &&
      isNonEmptyString(publicationCut.opId) &&
      typeof publicationCut.headDigest === "string" &&
      /^sha256:[0-9a-f]{64}$/u.test(publicationCut.headDigest);
  if ("commitSha" in value && value.commitSha !== null && !sha(value.commitSha))
    errors.push("commitSha must be a Git SHA or null while materialization is pending");
  if (!validAuthorizationDecision(value.authorizationDecision))
    errors.push("authorizationDecision must match AuthorizationDecision");
  if ("cut" in value && !validPublicationCut) errors.push("cut must identify repoId, revision, opId, and headDigest");
  if (
    ("cut" in value && !("commitSha" in value)) ||
    ("commitSha" in value && value.commitSha !== null && !("cut" in value))
  )
    errors.push("materialized commitSha and cut must be reported together");
  if (
    (value.outcome === "applied" || value.outcome === "pending" || value.outcome === "no_changes") &&
    (visibility === undefined || !validProof)
  )
    errors.push(`${String(value.outcome)} requires visibility and proof`);
  if (
    value.outcome === "applied" &&
    validProof &&
    (!proof.durable || !proof.canonicalVisible || proof.committedRevision !== proof.appliedCut)
  )
    errors.push("applied proof must prove durable and canonical-visible at the committed cut");
  if (
    value.outcome === "applied" &&
    replica &&
    validProof &&
    (proof.ackCut !== proof.appliedCut || proof.worktreeVisible !== true)
  )
    errors.push("replica applied requires worktree visibility and ackCut at the same cut");
  if (
    (value.outcome === "applied" || value.outcome === "no_changes") &&
    (!cut(value.revision) || !isNonEmptyString(value.evidence))
  )
    errors.push(`${String(value.outcome)} requires revision and evidence`);
  if (value.outcome === "no_changes" && (value.code !== "no_changes" || !isNonEmptyString(value.origin)))
    errors.push("no_changes requires code and origin");
  const hasStructuredRemediation =
      (Array.isArray(value.guidance) && value.guidance.length > 0) || isReceiptDiagnostic(value.diagnostic),
    hasLegacyRemediation = isNonEmptyString(value.nextAction);
  if (
    value.outcome === "pending" &&
    (!cut(value.revision) || !isNonEmptyString(value.evidence) || (!hasStructuredRemediation && !hasLegacyRemediation))
  )
    errors.push("pending requires committed evidence, revision, and remediation guidance");
  if (value.outcome === "indeterminate" || value.outcome === "op_rejected")
    for (const field of ["code", "origin"] as const)
      if (!isNonEmptyString(value[field])) errors.push(`${field} is required for ${value.outcome}`);
  if (
    (value.outcome === "indeterminate" || value.outcome === "op_rejected") &&
    !hasStructuredRemediation &&
    !hasLegacyRemediation
  )
    errors.push("nextAction is required when structured guidance and diagnostic are absent");
  if (!isNonEmptyString(value.evidence) && (value.outcome !== "indeterminate" || value.origin !== "N/A"))
    errors.push("evidence-free receipt must be N/A indeterminate");
  return errors;
}

export function isEntityActionUnmetCriterion(value: unknown): value is EntityActionUnmetCriterionV1 {
  return (
    isReceiptDomainRecord(value) &&
    exact(value, ["ref", "failureCode", "explain"]) &&
    isNonEmptyString(value.ref) &&
    isNonEmptyString(value.failureCode) &&
    isNonEmptyString(value.explain)
  );
}
export function isReceiptGuidance(value: unknown): value is ReceiptGuidanceContractEntry {
  if (!isReceiptDomainRecord(value)) return false;
  const fields = "when" in value ? ["kind", "args", "when"] : ["kind", "args"];
  return (
    exact(value, fields) &&
    (RECEIPT_GUIDANCE_KINDS as readonly string[]).includes(String(value.kind)) &&
    isReceiptDomainRecord(value.args) &&
    Object.values(value.args).every(
      (argument) =>
        typeof argument === "string" ||
        typeof argument === "number" ||
        typeof argument === "boolean" ||
        (Array.isArray(argument) && argument.every((item) => typeof item === "string")),
    ) &&
    (!("when" in value) ||
      (isReceiptDomainRecord(value.when) &&
        Object.values(value.when).every((entry) => ["string", "number", "boolean"].includes(typeof entry))))
  );
}
export function isReceiptDiagnostic(value: unknown): value is ReceiptDiagnostic {
  if (!isReceiptDomainRecord(value) || !isNonEmptyString(value.kind)) return false;
  if (value.kind === "validation")
    return (
      exact(value, ["kind", "entity", "field", "actual", "expectation"]) &&
      [value.entity, value.field, value.actual, value.expectation].every((field) => typeof field === "string")
    );
  if (value.kind === "workspace-boundary")
    return (
      exact(value, ["kind", "field", "workspaceRoot"]) &&
      isNonEmptyString(value.field) &&
      isNonEmptyString(value.workspaceRoot)
    );
  if (value.kind === "materialization-failed")
    return (
      exact(value, ["kind", "lastCheckpointRevision", "lastCheckpointAt", "pendingWalEvents", "reason", "lastError"]) &&
      cut(value.lastCheckpointRevision) &&
      (value.lastCheckpointAt === null || isNonEmptyString(value.lastCheckpointAt)) &&
      cut(value.pendingWalEvents) &&
      (value.reason === "git_diverged" ||
        value.reason === "deterministic_failure" ||
        value.reason === "retry_budget_exhausted") &&
      isNonEmptyString(value.lastError)
    );
  if (value.kind === "materialization-retrying")
    return (
      exact(value, [
        "kind",
        "state",
        "lastCheckpointRevision",
        "lastCheckpointAt",
        "pendingWalEvents",
        "retryElapsedMs",
        "lastError",
      ]) &&
      value.state === "retrying" &&
      cut(value.lastCheckpointRevision) &&
      (value.lastCheckpointAt === null || isNonEmptyString(value.lastCheckpointAt)) &&
      cut(value.pendingWalEvents) &&
      cut(value.retryElapsedMs) &&
      isNonEmptyString(value.lastError)
    );
  if (value.kind === "invalid-enum")
    return (
      exact(value, ["kind", "field", "actual", "allowedValues"]) &&
      isNonEmptyString(value.field) &&
      typeof value.actual === "string" &&
      Array.isArray(value.allowedValues) &&
      value.allowedValues.length > 0 &&
      value.allowedValues.every(isNonEmptyString)
    );
  if (value.kind === "failure") return exact(value, ["kind", "code"]) && isNonEmptyString(value.code);
  return (
    value.kind === "missing-sections" &&
    exact(value, ["kind", "documentPath", "diskDiffers", "missingSections"]) &&
    isNonEmptyString(value.documentPath) &&
    typeof value.diskDiffers === "boolean" &&
    Array.isArray(value.missingSections) &&
    value.missingSections.every(
      (entry) =>
        isReceiptDomainRecord(entry) &&
        exact(entry, entry.reason === "scaffold" ? ["section", "reason", "retainedScaffold"] : ["section", "reason"]) &&
        isNonEmptyString(entry.section) &&
        (entry.reason === "empty" || (entry.reason === "scaffold" && isNonEmptyString(entry.retainedScaffold))),
    )
  );
}
function validAuthorizationDecision(value: unknown): value is AuthorizationDecision {
  if (
    !isReceiptDomainRecord(value) ||
    !exact(value, [
      "policyRef",
      "actor",
      "subject",
      "bindingsUsed",
      "outcome",
      "reasonCodes",
      "nextActions",
      "evaluatedAtCut",
    ])
  )
    return false;
  const denied = value.outcome === "denied";
  return (
    /^\S+@[1-9][0-9]*$/u.test(String(value.policyRef)) &&
    validateActorIdentity(value.actor).length === 0 &&
    typeof value.subject === "string" &&
    parseEntityRef(value.subject) !== null &&
    Array.isArray(value.bindingsUsed) &&
    value.bindingsUsed.every((binding) => isReceiptDomainRecord(binding) && jsonValue(binding)) &&
    (value.outcome === "allowed" || denied) &&
    Array.isArray(value.reasonCodes) &&
    value.reasonCodes.every(isNonEmptyString) &&
    Array.isArray(value.nextActions) &&
    value.nextActions.every(isNonEmptyString) &&
    (!denied || (value.reasonCodes.length > 0 && value.nextActions.length > 0)) &&
    isNonEmptyString(value.evaluatedAtCut)
  );
}
function validateDocSyncDetail(value: Readonly<Record<string, unknown>>): boolean {
  const fields = [
    "kind",
    "code",
    "baseLedgerSha",
    "currentLedgerSha",
    "paths",
    "holder",
    "differences",
    "unresolvedTouches",
    "deletions",
    ...(value.nextAction === undefined ? [] : ["nextAction"]),
  ];
  return (
    exact(value, fields) &&
    value.kind === "doc_sync" &&
    isNonEmptyString(value.code) &&
    (value.nextAction === undefined || isNonEmptyString(value.nextAction)) &&
    receiptLedgerIdentity(value.baseLedgerSha) &&
    ledgerCut(value.currentLedgerSha) &&
    Array.isArray(value.paths) &&
    value.paths.every(
      (row) =>
        isReceiptDomainRecord(row) &&
        exact(row, ["path", "baseBlobSha256", "currentBlobSha256", "candidateBlobSha256"]) &&
        isNonEmptyString(row.path) &&
        [row.baseBlobSha256, row.currentBlobSha256, row.candidateBlobSha256].every(nullableSha),
    ) &&
    (value.holder === null ||
      (isReceiptDomainRecord(value.holder) &&
        exact(value.holder, ["taskId", "executionId", "personId", "executorId", "source", "expiresAt", "version"]) &&
        [value.holder.taskId, value.holder.executionId, value.holder.personId, value.holder.expiresAt].every(
          isNonEmptyString,
        ) &&
        (value.holder.executorId === null || isNonEmptyString(value.holder.executorId)) &&
        cut(value.holder.version))) &&
    Array.isArray(value.differences) &&
    value.differences.every(
      (row) =>
        isReceiptDomainRecord(row) &&
        exact(row, ["path", "regionId", "insertBytes", "deleteBytes", "replaceBytes", "firstChange"]) &&
        isNonEmptyString(row.path) &&
        isNonEmptyString(row.regionId) &&
        [row.insertBytes, row.deleteBytes, row.replaceBytes].every(cut) &&
        (row.firstChange === null ||
          (isReceiptDomainRecord(row.firstChange) &&
            exact(row.firstChange, ["baseOffset", "candidateOffset"]) &&
            cut(row.firstChange.baseOffset) &&
            cut(row.firstChange.candidateOffset))),
    ) &&
    Array.isArray(value.unresolvedTouches) &&
    value.unresolvedTouches.every(
      (row) =>
        isReceiptDomainRecord(row) &&
        exact(row, ["path", "regionId", "anchor", "reason", "requiredRoute", "policy"]) &&
        [row.path, row.reason, row.requiredRoute, row.policy].every(isNonEmptyString) &&
        (row.regionId === null || isNonEmptyString(row.regionId)) &&
        (row.anchor === null || isNonEmptyString(row.anchor)),
    ) &&
    Array.isArray(value.deletions) &&
    value.deletions.every(
      (row) =>
        isReceiptDomainRecord(row) &&
        exact(row, ["path", "baseBlobSha256", "source"]) &&
        isNonEmptyString(row.path) &&
        nullableSha(row.baseBlobSha256) &&
        row.baseBlobSha256 !== null &&
        row.source === "intent",
    )
  );
}

function validateEntityUpsertDetail(value: Readonly<Record<string, unknown>>): boolean {
  return (
    exact(value, ["kind", "entityKind", "entityId", "schemaId", "path"]) &&
    value.kind === "entity_upsert" &&
    isNonEmptyString(value.entityKind) &&
    isNonEmptyString(value.entityId) &&
    isNonEmptyString(value.schemaId) &&
    isNonEmptyString(value.path)
  );
}
function isReceiptDomainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => field in value);
}
function jsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return isReceiptDomainRecord(value) && Object.values(value).every(jsonValue);
}
function cut(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}
function sha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}
function nullableSha(value: unknown): boolean {
  return value === null || (typeof value === "string" && /^[0-9a-f]{64}$/u.test(value));
}
function receiptLedgerIdentity(value: unknown): value is LedgerIdentity {
  return (
    ledgerCut(value) ||
    (isReceiptDomainRecord(value) &&
      exact(value, ["repoId", "sha"]) &&
      isNonEmptyString(value.repoId) &&
      sha(value.sha))
  );
}
function ledgerCut(value: unknown): value is LedgerCutIdentity {
  return (
    isReceiptDomainRecord(value) &&
    exact(value, ["repoId", "revision", "headDigest"]) &&
    isNonEmptyString(value.repoId) &&
    cut(value.revision) &&
    typeof value.headDigest === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(value.headDigest)
  );
}
