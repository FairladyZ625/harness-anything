import { serializeCanonicalEventUnchecked } from "../domain/doc-sync-canonical-events.ts";
import type { PersistedCanonicalEventV1 } from "../domain/doc-sync-types.ts";
import type { SubmissionV1 } from "../domain/execution.ts";
import type { ReviewConsentV1, ReviewV1 } from "../domain/review.ts";
import type { ActorIdentity } from "../domain/write-chain.contract.ts";
import { isRecord } from "../domain/contract-validation.ts";
import { digestText, stableDigest, type AuditDigest, type AuditHashAlgorithm } from "./stable-hash.ts";

export const AUDIT_EXPORT_ENTRY_SCHEMA = "audit-export-entry/v1" as const;
export const AUDIT_EXPORT_MANIFEST_SCHEMA = "audit-export-manifest/v1" as const;
export const DELIVERY_CERTIFICATE_SCHEMA = "delivery-certificate/v1" as const;
export const DEFAULT_AUDIT_ENTRIES_FILE = "audit-events.jsonl" as const;

export type AuditAttributionCompleteness = "complete" | "incomplete";
export type DeliveryCertificateCompletionKind =
  | "native"
  | "external-resolution"
  | "sibling-resolution"
  | "imported-migration";
export type AuditCertificateChainCoverage = "complete" | "partial";
export type AuditTrustAnchorMode = "pinned" | "partially-pinned" | "self-consistent-only";

export interface AuditExportWindowV1 {
  readonly fromRevision: number | null;
  readonly toRevision: number | null;
  readonly utcDate: string | null;
  readonly after: string | null;
  readonly before: string | null;
}

export interface AuditPersonAttributionSummaryV1 {
  readonly totalEvents: number;
  readonly attributedEvents: number;
  readonly unattributedEvents: number;
  readonly traceableRatio: number;
  readonly complete: boolean;
  readonly attributionChainDigest: AuditDigest;
}

export interface AuditExportEntryV1 {
  readonly schema: typeof AUDIT_EXPORT_ENTRY_SCHEMA;
  readonly algorithm: AuditHashAlgorithm;
  readonly workspaceRevision: number;
  readonly opId: string;
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly personId: string | null;
  readonly executorId: string | null;
  readonly eventDigest: AuditDigest;
  readonly prevChainHash: AuditDigest;
  readonly chainHash: AuditDigest;
  readonly event: PersistedCanonicalEventV1;
}

export interface AuditExportManifestV1 {
  readonly schema: typeof AUDIT_EXPORT_MANIFEST_SCHEMA;
  readonly repoId: string;
  readonly algorithm: AuditHashAlgorithm;
  readonly window: AuditExportWindowV1;
  readonly prevRootHash: AuditDigest;
  readonly firstRevision: number | null;
  readonly lastRevision: number | null;
  readonly eventCount: number;
  readonly entriesFile: string;
  readonly entriesDigest: AuditDigest;
  readonly tipChainHash: AuditDigest;
  readonly attributionStatus: AuditAttributionCompleteness;
  readonly personAttribution: AuditPersonAttributionSummaryV1;
  readonly rootHash: AuditDigest;
}

export interface DeliveryCertificateExternalResolutionV1 {
  readonly kind: "external-resolution";
  readonly commitSha: string;
  readonly rationale: string;
  readonly factRef: string;
}

export interface DeliveryCertificateSiblingResolutionV1 {
  readonly kind: "sibling-resolution";
  readonly sourceTaskId: string;
  readonly rationale: string;
  readonly factRef: string;
}

export interface DeliveryCertificateImportedMigrationV1 {
  readonly kind: "imported-migration";
  readonly migratedFrom: string;
  readonly generation: "v0";
  readonly originalStatus: string;
  readonly packagePath: string;
}

export type DeliveryCertificateResolutionV1 =
  | DeliveryCertificateExternalResolutionV1
  | DeliveryCertificateSiblingResolutionV1
  | DeliveryCertificateImportedMigrationV1;

export interface DeliveryCertificateCompletionV1 {
  readonly opId: string;
  readonly eventId: string;
  readonly workspaceRevision: number;
  readonly occurredAt: string;
  readonly actor: ActorIdentity;
  readonly eventDigest: AuditDigest;
}

export interface DeliveryCertificateV1 {
  readonly schema: typeof DELIVERY_CERTIFICATE_SCHEMA;
  readonly algorithm: AuditHashAlgorithm;
  readonly repoId: string;
  readonly taskId: string;
  readonly title: string;
  readonly status: "done";
  readonly completionKind: DeliveryCertificateCompletionKind;
  readonly executionId: string | null;
  readonly iteration: number | null;
  readonly commitSha: string | null;
  readonly submissionDigest: `sha256:${string}` | null;
  readonly submission: SubmissionV1 | null;
  readonly resolution: DeliveryCertificateResolutionV1 | null;
  readonly reviews: readonly ReviewV1[];
  readonly reviewConsent: ReviewConsentV1 | null;
  readonly completion: DeliveryCertificateCompletionV1;
  readonly certificateHash: AuditDigest;
}

export type AuditVerifyErrorCode =
  | "audit_algorithm_unsupported"
  | "audit_algorithm_mismatch"
  | "audit_entries_unreadable"
  | "audit_entry_parse_failed"
  | "audit_entry_digest_mismatch"
  | "audit_chain_prev_hash_mismatch"
  | "audit_chain_hash_mismatch"
  | "audit_revision_order_invalid"
  | "audit_revision_gap"
  | "audit_window_mismatch"
  | "audit_slice_sequence_invalid"
  | "audit_person_attribution_missing"
  | "audit_manifest_invalid"
  | "audit_manifest_entries_digest_mismatch"
  | "audit_manifest_count_mismatch"
  | "audit_manifest_tip_mismatch"
  | "audit_manifest_attribution_mismatch"
  | "audit_manifest_root_hash_mismatch"
  | "audit_manifest_chain_link_mismatch"
  | "audit_expected_root_hash_mismatch"
  | "audit_certificate_invalid"
  | "audit_certificate_submission_digest_mismatch"
  | "audit_certificate_consent_mismatch"
  | "audit_certificate_hash_mismatch"
  | "audit_expected_certificate_hash_mismatch"
  | "audit_certificate_event_mismatch";

export interface AuditVerifyFailure {
  readonly ok: false;
  readonly diagnostic?: false;
  readonly code: AuditVerifyErrorCode;
  readonly message: string;
  readonly line?: number;
  readonly workspaceRevision?: number;
  readonly opId?: string;
  readonly field?: string;
  readonly expected?: string;
  readonly actual?: string;
}

export interface AuditSliceVerifySuccess {
  readonly ok: true;
  readonly verificationStatus: "verified";
  readonly verificationMode: "strict" | "self-consistent-only";
  readonly selfConsistent: true;
  readonly strictVerified: boolean;
  readonly anchorPinned: boolean;
  readonly repoId: string;
  readonly algorithm: AuditHashAlgorithm;
  readonly window: AuditExportWindowV1;
  readonly eventCount: number;
  readonly firstRevision: number | null;
  readonly lastRevision: number | null;
  readonly prevRootHash: AuditDigest;
  readonly rootHash: AuditDigest;
  readonly tipChainHash: AuditDigest;
  readonly attributionStatus: "complete";
  readonly personAttribution: AuditPersonAttributionSummaryV1;
}

export interface AuditSliceVerifyDiagnostic {
  readonly ok: false;
  readonly diagnostic: true;
  readonly verificationStatus: "diagnostic_incomplete_attribution";
  readonly selfConsistent: false;
  readonly strictVerified: false;
  readonly chainIntegrityOk: true;
  readonly attributionVerified: false;
  readonly anchorPinned: boolean;
  readonly code: "audit_person_attribution_missing";
  readonly message: string;
  readonly line: number;
  readonly workspaceRevision: number;
  readonly opId: string;
  readonly field: "actor.principal.personId";
  readonly repoId: string;
  readonly algorithm: AuditHashAlgorithm;
  readonly window: AuditExportWindowV1;
  readonly eventCount: number;
  readonly firstRevision: number | null;
  readonly lastRevision: number | null;
  readonly prevRootHash: AuditDigest;
  readonly rootHash: AuditDigest;
  readonly tipChainHash: AuditDigest;
  readonly attributionStatus: "incomplete";
  readonly personAttribution: AuditPersonAttributionSummaryV1;
}

export type AuditSliceVerifyResult = AuditSliceVerifySuccess | AuditSliceVerifyDiagnostic | AuditVerifyFailure;

export interface AuditCertificateChainSummary {
  readonly completionVerified: true;
  readonly coverage: AuditCertificateChainCoverage;
  readonly reviewsTotalCount: number;
  readonly reviewsVerifiedCount: number;
  readonly uncoveredReviewIds: readonly string[];
  readonly consentVerified: boolean | "not_applicable" | "not_in_slice_window";
  readonly uncoveredConsentId: string | null;
}

export interface AuditCertificateVerifySuccess {
  readonly ok: true;
  readonly verificationStatus: "verified";
  readonly verificationMode: "strict" | "self-consistent-only";
  readonly selfConsistent: true;
  readonly strictVerified: boolean;
  readonly anchorPinned: boolean;
  readonly repoId: string;
  readonly taskId: string;
  readonly completionKind: DeliveryCertificateCompletionKind;
  readonly executionId: string | null;
  readonly algorithm: AuditHashAlgorithm;
  readonly commitSha: string | null;
  readonly submissionDigest: `sha256:${string}` | null;
  readonly resolution: DeliveryCertificateResolutionV1 | null;
  readonly reviewCount: number;
  readonly consentId: string | null;
  readonly completionOpId: string;
  readonly completionRevision: number;
  readonly certificateHash: AuditDigest;
  readonly chainEvidence?: AuditCertificateChainSummary;
}

export type AuditCertificateVerifyResult = AuditCertificateVerifySuccess | AuditVerifyFailure;

export class AuditChainGapError extends Error {
  readonly code = "audit_revision_gap" as const;
  constructor(message: string) {
    super(message);
    this.name = "AuditChainGapError";
  }
}

export interface AuditCertificateChainTarget {
  readonly taskId: string;
  readonly completionOpId: string;
  readonly executionId: string | null;
}

export interface AuditCertificateChainEvidence {
  readonly repoIds: ReadonlySet<string>;
  readonly firstObservedRevision: number | null;
  readonly lastObservedRevision: number | null;
  readonly firstObservedOccurredAt: string | null;
  readonly lastObservedOccurredAt: string | null;
  readonly sawTaskStartOrCreate: boolean;
  readonly completionEvent: { readonly repoId: string; readonly event: PersistedCanonicalEventV1 } | null;
  readonly reviewEvents: ReadonlyMap<string, ReviewV1>;
  readonly consentEvents: ReadonlyMap<
    string,
    { readonly review: ReviewV1; readonly consent: ReviewConsentV1; readonly executionId: string }
  >;
  readonly consentsByExecution: ReadonlyMap<string, readonly ReviewConsentV1[]>;
}

export interface AuditCertificateChainCollector {
  readonly observe: (repoId: string, event: PersistedCanonicalEventV1) => void;
  readonly evidence: () => AuditCertificateChainEvidence;
}

export function createAuditVerifyFailure(
  code: AuditVerifyErrorCode,
  message: string,
  detail?: Omit<AuditVerifyFailure, "ok" | "diagnostic" | "code" | "message">,
): AuditVerifyFailure {
  return { ok: false, code, message, ...detail };
}

export function auditGenesisChainHash(algorithm: AuditHashAlgorithm): AuditDigest {
  return `${algorithm}:${"0".repeat(64)}`;
}

const AUDIT_DIGEST_PATTERNS: Readonly<Record<AuditHashAlgorithm | "any", RegExp>> = {
  sha256: /^sha256:[0-9a-f]{64}$/u,
  sm3: /^sm3:[0-9a-f]{64}$/u,
  any: /^(?:sha256|sm3):[0-9a-f]{64}$/u,
};

export function isAuditDigest(value: unknown, algorithm?: AuditHashAlgorithm): value is AuditDigest {
  return typeof value === "string" && AUDIT_DIGEST_PATTERNS[algorithm ?? "any"].test(value);
}

export function isPureRevisionWindow(window: AuditExportWindowV1): boolean {
  return window.utcDate === null && window.after === null && window.before === null;
}

export function formatAuditEntriesFileName(entriesDigest: AuditDigest): string {
  const colon = entriesDigest.indexOf(":");
  const prefix = colon >= 0 ? entriesDigest.slice(colon + 1, colon + 17) : entriesDigest.slice(0, 16);
  return `audit-events-${prefix}.jsonl`;
}

export function extractEventPersonId(event: { readonly actor?: unknown }): string | null {
  if (!isRecord(event.actor) || !isRecord(event.actor.principal)) return null;
  const personId = event.actor.principal.personId;
  return typeof personId === "string" && personId.trim().length > 0 ? personId.trim() : null;
}

export function extractEventExecutorId(event: { readonly actor?: unknown }): string | null {
  if (!isRecord(event.actor) || !isRecord(event.actor.executor)) return null;
  const id = event.actor.executor.id;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

export function computeCanonicalEventDigest(
  algorithm: AuditHashAlgorithm,
  event: PersistedCanonicalEventV1,
): AuditDigest {
  return `${algorithm}:${digestText(algorithm, serializeCanonicalEventUnchecked(event))}`;
}

export function computeAuditChainHash(input: {
  readonly algorithm: AuditHashAlgorithm;
  readonly prevChainHash: AuditDigest;
  readonly workspaceRevision: number;
  readonly opId: string;
  readonly eventDigest: AuditDigest;
}): AuditDigest {
  return stableDigest(input.algorithm, {
    algorithm: input.algorithm,
    prevChainHash: input.prevChainHash,
    workspaceRevision: input.workspaceRevision,
    opId: input.opId,
    eventDigest: input.eventDigest,
  });
}

export function computeAuditManifestRootHash(manifest: Omit<AuditExportManifestV1, "rootHash">): AuditDigest {
  return stableDigest(manifest.algorithm, manifest);
}

export function computeDeliveryCertificateHash(cert: Omit<DeliveryCertificateV1, "certificateHash">): AuditDigest {
  return stableDigest(cert.algorithm, cert);
}
