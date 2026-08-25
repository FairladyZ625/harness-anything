import { validateActorIdentity } from "./actor-identity.ts";
import { isNonEmptyString } from "./contract-validation.ts";
import { parseEntityRef } from "./entity-ref.ts";
import type { AuthorizationDecision } from "./receipt-frame.ts";
export type { AuthorizationDecision, ReceiptJsonValue } from "./receipt-frame.ts";

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
  readonly nextAction: string;
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
export interface WriteReceipt {
  readonly outcome: "applied" | "pending" | "no_changes" | "indeterminate" | "op_rejected";
  readonly opId: string;
  readonly revision?: number;
  readonly code?: string;
  readonly origin?: string;
  readonly nextAction?: string;
  readonly evidence?: string;
  readonly visibility?: ReceiptVisibility;
  readonly proof?: ReceiptProof;
  readonly detail?: WriteReceiptDetail;
  readonly commitSha?: string | null;
  readonly authorizationDecision?: AuthorizationDecision | null;
  readonly cut?: {
    readonly repoId: string;
    readonly revision: number;
    readonly opId: string;
    readonly headDigest: string;
  };
}
export const WRITE_RECEIPT_SCHEMA = Object.freeze({
  id: "write-receipt/v1",
  outcomes: Object.freeze(["applied", "pending", "no_changes", "indeterminate", "op_rejected"] as const),
  required: Object.freeze(["outcome", "opId"]),
  optional: Object.freeze([
    "revision",
    "code",
    "origin",
    "nextAction",
    "evidence",
    "visibility",
    "proof",
    "detail",
    "commitSha",
    "authorizationDecision",
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
  for (const field of ["code", "origin", "nextAction", "evidence"] as const)
    if (field in value && !isNonEmptyString(value[field])) errors.push(`${field} must be a non-empty string`);
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
  if (
    "authorizationDecision" in value &&
    value.authorizationDecision !== null &&
    !validAuthorizationDecision(value.authorizationDecision)
  )
    errors.push("authorizationDecision must match AuthorizationDecision or be null before authorization wiring");
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
  if (
    value.outcome === "no_changes" &&
    (value.code !== "no_changes" || !isNonEmptyString(value.origin) || !isNonEmptyString(value.nextAction))
  )
    errors.push("no_changes requires code, origin, and nextAction");
  if (
    value.outcome === "pending" &&
    (!cut(value.revision) || !isNonEmptyString(value.evidence) || !isNonEmptyString(value.nextAction))
  )
    errors.push("pending requires committed evidence, revision, and nextAction");
  if (value.outcome === "indeterminate" || value.outcome === "op_rejected")
    for (const field of ["code", "origin", "nextAction"] as const)
      if (!isNonEmptyString(value[field])) errors.push(`${field} is required for ${value.outcome}`);
  if (!isNonEmptyString(value.evidence) && (value.outcome !== "indeterminate" || value.origin !== "N/A"))
    errors.push("evidence-free receipt must be N/A indeterminate");
  return errors;
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
  return (
    exact(value, [
      "kind",
      "code",
      "baseLedgerSha",
      "currentLedgerSha",
      "paths",
      "holder",
      "differences",
      "unresolvedTouches",
      "deletions",
      "nextAction",
    ]) &&
    value.kind === "doc_sync" &&
    isNonEmptyString(value.code) &&
    receiptLedgerIdentity(value.baseLedgerSha) &&
    ledgerCut(value.currentLedgerSha) &&
    isNonEmptyString(value.nextAction) &&
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
