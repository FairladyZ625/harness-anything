import { serializeCanonicalEventUnchecked } from "../domain/doc-sync-canonical-events.ts";
import type { PersistedCanonicalEventV1 } from "../domain/doc-sync-types.ts";
import { submissionDigest, type ExecutionV1, type SubmissionV1 } from "../domain/execution.ts";
import { reviewDigest, type ReviewConsentV1, type ReviewV1 } from "../domain/review.ts";
import type { TaskCompletedEvent } from "../domain/task-lifecycle-event.ts";
import type { TaskV2 } from "../domain/task.ts";
import type { ActorIdentity } from "../domain/write-chain.contract.ts";
import { isNonEmptyString, isRecord } from "../domain/contract-validation.ts";
import {
  createBytesDigestAccumulator,
  createTextDigestAccumulator,
  digestText,
  isAuditHashAlgorithm,
  stableDigest,
  stableStringify,
  type AuditDigest,
  type AuditHashAlgorithm,
} from "./stable-hash.ts";

export const AUDIT_EXPORT_ENTRY_SCHEMA = "audit-export-entry/v1" as const;
export const AUDIT_EXPORT_MANIFEST_SCHEMA = "audit-export-manifest/v1" as const;
export const DELIVERY_CERTIFICATE_SCHEMA = "delivery-certificate/v1" as const;
export const DEFAULT_AUDIT_ENTRIES_FILE = "audit-events.jsonl" as const;

export type AuditAttributionCompleteness = "complete" | "incomplete";
export type DeliveryCertificateCompletionKind = "native" | "external-resolution" | "sibling-resolution";

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

export type DeliveryCertificateResolutionV1 =
  | DeliveryCertificateExternalResolutionV1
  | DeliveryCertificateSiblingResolutionV1;

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
  readonly strictVerified: true;
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

export interface AuditCertificateVerifySuccess {
  readonly ok: true;
  readonly verificationStatus: "verified";
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
  readonly chainEvidence?: {
    readonly completionVerified: true;
    readonly reviewsVerifiedCount: number;
    readonly consentVerified: boolean | "not_applicable" | "not_in_slice_window";
  };
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

export function createAuditCertificateChainCollector(
  target: AuditCertificateChainTarget,
): AuditCertificateChainCollector {
  const repoIds = new Set<string>();
  const reviewEvents = new Map<string, ReviewV1>();
  const consentEvents = new Map<
    string,
    { readonly review: ReviewV1; readonly consent: ReviewConsentV1; readonly executionId: string }
  >();
  const consentsByExecution = new Map<string, ReviewConsentV1[]>();
  let firstObservedRevision: number | null = null;
  let lastObservedRevision: number | null = null;
  let firstObservedOccurredAt: string | null = null;
  let lastObservedOccurredAt: string | null = null;
  let sawTaskStartOrCreate = false;
  let completionEvent: { readonly repoId: string; readonly event: PersistedCanonicalEventV1 } | null = null;

  return {
    observe(repoId, event) {
      repoIds.add(repoId);
      if (firstObservedRevision === null || event.workspaceRevision < firstObservedRevision) {
        firstObservedRevision = event.workspaceRevision;
      }
      if (lastObservedRevision === null || event.workspaceRevision > lastObservedRevision) {
        lastObservedRevision = event.workspaceRevision;
      }
      if (firstObservedOccurredAt === null || Date.parse(event.occurredAt) < Date.parse(firstObservedOccurredAt)) {
        firstObservedOccurredAt = event.occurredAt;
      }
      if (lastObservedOccurredAt === null || Date.parse(event.occurredAt) > Date.parse(lastObservedOccurredAt)) {
        lastObservedOccurredAt = event.occurredAt;
      }
      if (event.opId === target.completionOpId) {
        completionEvent = { repoId, event };
      }
      const record = event as unknown as Record<string, unknown>;
      const eventTaskId = typeof record.taskId === "string" ? record.taskId : null;
      if (eventTaskId !== target.taskId) return;
      if (event.type === "task_created" || event.type === "task_bootstrapped" || event.type === "execution_started") {
        sawTaskStartOrCreate = true;
      }
      const payload = isRecord(record.payload) ? record.payload : null;
      if (event.type === "review_recorded" && payload && isRecord(payload.review)) {
        const review = payload.review as unknown as ReviewV1;
        if (isNonEmptyString(review.reviewId)) {
          reviewEvents.set(review.reviewId, review);
        }
      } else if (
        (event.type === "review_consent_recorded" || event.type === "review_consent_overridden") &&
        payload &&
        isRecord(payload.consent) &&
        isRecord(payload.review)
      ) {
        const consent = payload.consent as unknown as ReviewConsentV1;
        const review = payload.review as unknown as ReviewV1;
        if (isNonEmptyString(consent.consentId)) {
          consentEvents.set(consent.consentId, { review, consent, executionId: consent.executionId });
          const existing = consentsByExecution.get(consent.executionId) ?? [];
          existing.push(consent);
          consentsByExecution.set(consent.executionId, existing);
        }
      }
    },
    evidence(): AuditCertificateChainEvidence {
      return {
        repoIds,
        firstObservedRevision,
        lastObservedRevision,
        firstObservedOccurredAt,
        lastObservedOccurredAt,
        sawTaskStartOrCreate,
        completionEvent,
        reviewEvents,
        consentEvents,
        consentsByExecution,
      };
    },
  };
}

export function createAuditVerifyFailure(
  code: AuditVerifyErrorCode,
  message: string,
  detail?: Omit<AuditVerifyFailure, "ok" | "diagnostic" | "code" | "message">,
): AuditVerifyFailure {
  return {
    ok: false,
    code,
    message,
    ...detail,
  };
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

export interface AuditChainAccumulatorInput {
  readonly repoId: string;
  readonly algorithm: AuditHashAlgorithm;
  readonly prevRootHash?: AuditDigest;
  readonly window: AuditExportWindowV1;
  readonly entriesFile?: string;
}

export interface AuditChainAccumulator {
  readonly addEvent: (event: PersistedCanonicalEventV1) => {
    readonly entry: AuditExportEntryV1;
    readonly line: string;
  };
  readonly finalize: () => AuditExportManifestV1;
}

export function createAuditChainAccumulator(input: AuditChainAccumulatorInput): AuditChainAccumulator {
  const prevRootHash = input.prevRootHash ?? auditGenesisChainHash(input.algorithm);
  if (!isAuditDigest(prevRootHash, input.algorithm)) {
    throw new Error(`prevRootHash must be a valid ${input.algorithm} digest`);
  }
  const entriesFile = input.entriesFile ?? DEFAULT_AUDIT_ENTRIES_FILE;
  const entriesHasher = createBytesDigestAccumulator(input.algorithm);
  const attributionHasher = createTextDigestAccumulator(input.algorithm);
  const pureRevision = isPureRevisionWindow(input.window);
  const expectedStart = input.window.fromRevision ?? 1;
  const afterMs = input.window.after === null ? null : Date.parse(input.window.after);
  const beforeMs = input.window.before === null ? null : Date.parse(input.window.before);
  let firstRevision: number | null = null;
  let lastRevision: number | null = null;
  let eventCount = 0;
  let attributedEvents = 0;
  let unattributedEvents = 0;
  let tipChainHash: AuditDigest = prevRootHash;

  return {
    addEvent(event) {
      if (!Number.isSafeInteger(event.workspaceRevision) || event.workspaceRevision < 1) {
        throw new Error(`Invalid canonical event workspaceRevision: ${String(event.workspaceRevision)}`);
      }
      if (input.window.fromRevision !== null && event.workspaceRevision < input.window.fromRevision) {
        throw new Error(
          `Event revision ${event.workspaceRevision} precedes declared window fromRevision ${input.window.fromRevision}`,
        );
      }
      if (input.window.toRevision !== null && event.workspaceRevision > input.window.toRevision) {
        throw new Error(
          `Event revision ${event.workspaceRevision} exceeds declared window toRevision ${input.window.toRevision}`,
        );
      }
      if (lastRevision !== null && event.workspaceRevision <= lastRevision) {
        throw new Error(
          `Audit export requires strictly increasing workspaceRevision (${event.workspaceRevision} <= ${lastRevision})`,
        );
      }
      if (pureRevision) {
        const expectedRevision = lastRevision === null ? expectedStart : lastRevision + 1;
        if (event.workspaceRevision !== expectedRevision) {
          throw new AuditChainGapError(
            `Contiguous revision gap detected during audit export: expected rev ${expectedRevision}, got rev ${event.workspaceRevision}.`,
          );
        }
      } else if (afterMs !== null || beforeMs !== null) {
        const occurredMs = Date.parse(event.occurredAt);
        if (
          Number.isNaN(occurredMs) ||
          (afterMs !== null && occurredMs < afterMs) ||
          (beforeMs !== null && occurredMs > beforeMs)
        ) {
          throw new Error(`Event revision ${event.workspaceRevision} occurredAt ${event.occurredAt} is outside window`);
        }
      }
      const eventDigest = computeCanonicalEventDigest(input.algorithm, event);
      const prevChainHash = tipChainHash;
      const chainHash = computeAuditChainHash({
        algorithm: input.algorithm,
        prevChainHash,
        workspaceRevision: event.workspaceRevision,
        opId: event.opId,
        eventDigest,
      });
      const personId = extractEventPersonId(event);
      const executorId = extractEventExecutorId(event);
      if (personId !== null) {
        attributedEvents += 1;
      } else {
        unattributedEvents += 1;
      }
      attributionHasher.feed(`${event.workspaceRevision}:${personId ?? ""}\n`);
      if (firstRevision === null) firstRevision = event.workspaceRevision;
      lastRevision = event.workspaceRevision;
      eventCount += 1;
      tipChainHash = chainHash;
      const entry: AuditExportEntryV1 = {
        schema: AUDIT_EXPORT_ENTRY_SCHEMA,
        algorithm: input.algorithm,
        workspaceRevision: event.workspaceRevision,
        opId: event.opId,
        eventId: event.eventId,
        type: event.type,
        occurredAt: event.occurredAt,
        personId,
        executorId,
        eventDigest,
        prevChainHash,
        chainHash,
        event,
      };
      const line = `${stableStringify(entry)}\n`;
      entriesHasher.feed(Buffer.from(line, "utf8"));
      return { entry, line };
    },
    finalize() {
      if (pureRevision && input.window.toRevision !== null && input.window.toRevision >= expectedStart) {
        const expectedCount = input.window.toRevision - expectedStart + 1;
        if (
          eventCount !== expectedCount ||
          firstRevision !== expectedStart ||
          lastRevision !== input.window.toRevision
        ) {
          throw new AuditChainGapError(
            `Pure revision window ${expectedStart}..${input.window.toRevision} is incomplete: exported ${eventCount} event(s) (${String(firstRevision)}..${String(lastRevision)}).`,
          );
        }
      }
      const complete = unattributedEvents === 0;
      const attributionStatus: AuditAttributionCompleteness = complete ? "complete" : "incomplete";
      const personAttribution: AuditPersonAttributionSummaryV1 = {
        totalEvents: eventCount,
        attributedEvents,
        unattributedEvents,
        traceableRatio: eventCount === 0 ? 1 : attributedEvents / eventCount,
        complete,
        attributionChainDigest: attributionHasher.digest(),
      };
      const body: Omit<AuditExportManifestV1, "rootHash"> = {
        schema: AUDIT_EXPORT_MANIFEST_SCHEMA,
        repoId: input.repoId,
        algorithm: input.algorithm,
        window: input.window,
        prevRootHash,
        firstRevision,
        lastRevision,
        eventCount,
        entriesFile,
        entriesDigest: entriesHasher.digest(),
        tipChainHash,
        attributionStatus,
        personAttribution,
      };
      return {
        ...body,
        rootHash: computeAuditManifestRootHash(body),
      };
    },
  };
}

export function buildDeliveryCertificate(input: {
  readonly algorithm?: AuditHashAlgorithm;
  readonly repoId: string;
  readonly task: TaskV2;
  readonly execution: ExecutionV1 | null;
  readonly reviews: readonly ReviewV1[];
  readonly reviewConsent: ReviewConsentV1 | null;
  readonly completionEvent: TaskCompletedEvent;
}): DeliveryCertificateV1 {
  const algorithm = input.algorithm ?? "sha256";
  if (input.task.status !== "done") {
    throw new Error(`Delivery certificate requires a done task; got status ${input.task.status}`);
  }
  if (input.completionEvent.type !== "task_completed" || input.completionEvent.taskId !== input.task.taskId) {
    throw new Error(`Completion event does not match task ${input.task.taskId}`);
  }
  const sortedReviews = [...input.reviews].sort((left, right) =>
    left.reviewedAt === right.reviewedAt
      ? left.reviewId.localeCompare(right.reviewId)
      : left.reviewedAt.localeCompare(right.reviewedAt),
  );
  const completionPayload = input.completionEvent.payload;
  let completionKind: DeliveryCertificateCompletionKind;
  let executionId: string | null = null;
  let iteration: number | null = null;
  let commitSha: string | null = null;
  let computedSubmissionDigest: `sha256:${string}` | null = null;
  let submission: SubmissionV1 | null = null;
  let resolution: DeliveryCertificateResolutionV1 | null = null;
  let reviewConsent: ReviewConsentV1 | null = null;

  if (completionPayload.externalResolution !== undefined) {
    completionKind = "external-resolution";
    commitSha = completionPayload.externalResolution.commitSha;
    resolution = {
      kind: "external-resolution",
      commitSha: completionPayload.externalResolution.commitSha,
      rationale: completionPayload.externalResolution.rationale,
      factRef: completionPayload.externalResolution.factRef,
    };
  } else if (completionPayload.siblingResolution !== undefined) {
    completionKind = "sibling-resolution";
    resolution = {
      kind: "sibling-resolution",
      sourceTaskId: completionPayload.siblingResolution.sourceTaskId,
      rationale: completionPayload.siblingResolution.rationale,
      factRef: completionPayload.siblingResolution.factRef,
    };
  } else {
    const effectiveExecution =
      completionPayload.execution && completionPayload.execution.schema === "execution/v1"
        ? completionPayload.execution
        : input.execution;
    if (effectiveExecution === null || effectiveExecution.submission === null) {
      throw new Error(
        `Delivery certificate requires an accepted execution with a frozen submission (${input.task.taskId})`,
      );
    }
    completionKind = "native";
    executionId = effectiveExecution.executionId;
    iteration = effectiveExecution.iteration;
    commitSha = effectiveExecution.submission.commitSha;
    submission = effectiveExecution.submission;
    computedSubmissionDigest = submissionDigest(effectiveExecution.submission);
    reviewConsent = input.reviewConsent;
  }

  const body: Omit<DeliveryCertificateV1, "certificateHash"> = {
    schema: DELIVERY_CERTIFICATE_SCHEMA,
    algorithm,
    repoId: input.repoId,
    taskId: input.task.taskId,
    title: input.task.title,
    status: "done",
    completionKind,
    executionId,
    iteration,
    commitSha,
    submissionDigest: computedSubmissionDigest,
    submission,
    resolution,
    reviews: sortedReviews,
    reviewConsent,
    completion: {
      opId: input.completionEvent.opId,
      eventId: input.completionEvent.eventId,
      workspaceRevision: input.completionEvent.workspaceRevision,
      occurredAt: input.completionEvent.occurredAt,
      actor: input.completionEvent.actor,
      eventDigest: computeCanonicalEventDigest(algorithm, input.completionEvent),
    },
  };
  return {
    ...body,
    certificateHash: computeDeliveryCertificateHash(body),
  };
}

export interface AuditSliceVerifier {
  readonly feedRawBytes: (chunk: Uint8Array) => void;
  readonly verifyLine: (rawLine: string, lineNumber: number) => AuditVerifyFailure | null;
  readonly finalize: () => AuditSliceVerifyResult;
}

export function createAuditSliceVerifier(input: {
  readonly manifest: unknown;
  readonly expectedAlgorithm?: AuditHashAlgorithm;
  readonly expectedPrevRootHash?: AuditDigest;
  readonly expectedRootHash?: AuditDigest;
  readonly requirePersonAttribution?: boolean;
  readonly certificateCollector?: AuditCertificateChainCollector;
}): { readonly ok: true; readonly verifier: AuditSliceVerifier } | AuditVerifyFailure {
  const parsed = parseManifestShape(input.manifest);
  if (!parsed.ok) return parsed;
  const manifest = parsed.manifest;
  if (input.expectedAlgorithm !== undefined && manifest.algorithm !== input.expectedAlgorithm) {
    return {
      ok: false,
      code: "audit_algorithm_mismatch",
      field: "algorithm",
      expected: input.expectedAlgorithm,
      actual: manifest.algorithm,
      message: `Manifest algorithm ${manifest.algorithm} does not match expected ${input.expectedAlgorithm}.`,
    };
  }
  if (input.expectedPrevRootHash !== undefined && manifest.prevRootHash !== input.expectedPrevRootHash) {
    return {
      ok: false,
      code: "audit_manifest_chain_link_mismatch",
      field: "prevRootHash",
      expected: input.expectedPrevRootHash,
      actual: manifest.prevRootHash,
      message: `Manifest prevRootHash ${manifest.prevRootHash} does not link to expected ${input.expectedPrevRootHash}.`,
    };
  }
  const requirePersonAttribution = input.requirePersonAttribution ?? true;
  const entriesHasher = createBytesDigestAccumulator(manifest.algorithm);
  const attributionHasher = createTextDigestAccumulator(manifest.algorithm);
  const pureRevision = isPureRevisionWindow(manifest.window);
  const expectedStart = manifest.window.fromRevision ?? 1;
  const afterMs = manifest.window.after === null ? null : Date.parse(manifest.window.after);
  const beforeMs = manifest.window.before === null ? null : Date.parse(manifest.window.before);
  let expectedPrevChainHash: AuditDigest = manifest.prevRootHash;
  let firstRevision: number | null = null;
  let lastRevision: number | null = null;
  let eventCount = 0;
  let attributedEvents = 0;
  let unattributedEvents = 0;
  let firstUnattributed: { readonly line: number; readonly workspaceRevision: number; readonly opId: string } | null =
    null;

  return {
    ok: true,
    verifier: {
      feedRawBytes(chunk: Uint8Array): void {
        entriesHasher.feed(chunk);
      },
      verifyLine(rawLine: string, lineNumber: number): AuditVerifyFailure | null {
        if (rawLine.includes("\r")) {
          return {
            ok: false,
            code: "audit_manifest_entries_digest_mismatch",
            line: lineNumber,
            field: "entriesDigest",
            message: `Line ${lineNumber}: non-canonical CR/CRLF line terminator detected in audit entries stream.`,
          };
        }
        let parsedEntry: unknown;
        try {
          parsedEntry = JSON.parse(rawLine);
        } catch {
          return {
            ok: false,
            code: "audit_entry_parse_failed",
            line: lineNumber,
            message: `Line ${lineNumber}: malformed JSON in audit entries stream.`,
          };
        }
        const entryCheck = entryShapeError(parsedEntry, manifest.algorithm, lineNumber);
        if (!entryCheck.ok) return entryCheck;
        const entry = entryCheck.entry;
        if (lastRevision !== null && entry.workspaceRevision <= lastRevision) {
          return {
            ok: false,
            code: "audit_revision_order_invalid",
            line: lineNumber,
            workspaceRevision: entry.workspaceRevision,
            opId: entry.opId,
            field: "workspaceRevision",
            expected: `> ${lastRevision}`,
            actual: String(entry.workspaceRevision),
            message: `Line ${lineNumber}: workspaceRevision ${entry.workspaceRevision} is not strictly greater than previous ${lastRevision}.`,
          };
        }
        if (
          (manifest.window.fromRevision !== null && entry.workspaceRevision < manifest.window.fromRevision) ||
          (manifest.window.toRevision !== null && entry.workspaceRevision > manifest.window.toRevision)
        ) {
          return {
            ok: false,
            code: "audit_window_mismatch",
            line: lineNumber,
            workspaceRevision: entry.workspaceRevision,
            opId: entry.opId,
            field: "workspaceRevision",
            expected: `${String(manifest.window.fromRevision ?? 1)}..${String(manifest.window.toRevision ?? "*")}`,
            actual: String(entry.workspaceRevision),
            message: `Line ${lineNumber} (rev ${entry.workspaceRevision}): event falls outside manifest revision window.`,
          };
        }
        if (pureRevision) {
          const expectedRevision = lastRevision === null ? expectedStart : lastRevision + 1;
          if (entry.workspaceRevision !== expectedRevision) {
            return {
              ok: false,
              code: "audit_revision_gap",
              line: lineNumber,
              workspaceRevision: entry.workspaceRevision,
              opId: entry.opId,
              field: "workspaceRevision",
              expected: String(expectedRevision),
              actual: String(entry.workspaceRevision),
              message: `Line ${lineNumber}: revision gap detected in pure revision window (expected rev ${expectedRevision}, got rev ${entry.workspaceRevision}).`,
            };
          }
        } else if (afterMs !== null || beforeMs !== null) {
          const occurredMs = Date.parse(entry.occurredAt);
          if (
            Number.isNaN(occurredMs) ||
            (afterMs !== null && occurredMs < afterMs) ||
            (beforeMs !== null && occurredMs > beforeMs)
          ) {
            return {
              ok: false,
              code: "audit_window_mismatch",
              line: lineNumber,
              workspaceRevision: entry.workspaceRevision,
              opId: entry.opId,
              field: "occurredAt",
              expected: `${String(manifest.window.after ?? "*")}..${String(manifest.window.before ?? "*")}`,
              actual: entry.occurredAt,
              message: `Line ${lineNumber} (rev ${entry.workspaceRevision}): event occurredAt ${entry.occurredAt} falls outside manifest time window.`,
            };
          }
        }
        const event = entry.event;
        if (
          event.workspaceRevision !== entry.workspaceRevision ||
          event.opId !== entry.opId ||
          event.eventId !== entry.eventId ||
          event.type !== entry.type ||
          event.occurredAt !== entry.occurredAt
        ) {
          return {
            ok: false,
            code: "audit_entry_digest_mismatch",
            line: lineNumber,
            workspaceRevision: entry.workspaceRevision,
            opId: entry.opId,
            field: "event",
            message: `Line ${lineNumber}: entry envelope fields do not match embedded canonical event.`,
          };
        }
        const actualEventDigest = computeCanonicalEventDigest(manifest.algorithm, event);
        if (actualEventDigest !== entry.eventDigest) {
          return {
            ok: false,
            code: "audit_entry_digest_mismatch",
            line: lineNumber,
            workspaceRevision: entry.workspaceRevision,
            opId: entry.opId,
            field: "eventDigest",
            expected: entry.eventDigest,
            actual: actualEventDigest,
            message: `Line ${lineNumber} (rev ${entry.workspaceRevision}): canonical event digest mismatch.`,
          };
        }
        if (entry.prevChainHash !== expectedPrevChainHash) {
          return {
            ok: false,
            code: "audit_chain_prev_hash_mismatch",
            line: lineNumber,
            workspaceRevision: entry.workspaceRevision,
            opId: entry.opId,
            field: "prevChainHash",
            expected: expectedPrevChainHash,
            actual: entry.prevChainHash,
            message: `Line ${lineNumber} (rev ${entry.workspaceRevision}): prevChainHash link broken.`,
          };
        }
        const actualChainHash = computeAuditChainHash({
          algorithm: manifest.algorithm,
          prevChainHash: entry.prevChainHash,
          workspaceRevision: entry.workspaceRevision,
          opId: entry.opId,
          eventDigest: actualEventDigest,
        });
        if (actualChainHash !== entry.chainHash) {
          return {
            ok: false,
            code: "audit_chain_hash_mismatch",
            line: lineNumber,
            workspaceRevision: entry.workspaceRevision,
            opId: entry.opId,
            field: "chainHash",
            expected: actualChainHash,
            actual: entry.chainHash,
            message: `Line ${lineNumber} (rev ${entry.workspaceRevision}): chainHash mismatch.`,
          };
        }
        const actualPersonId = extractEventPersonId(event);
        if (actualPersonId !== entry.personId) {
          return {
            ok: false,
            code: "audit_entry_digest_mismatch",
            line: lineNumber,
            workspaceRevision: entry.workspaceRevision,
            opId: entry.opId,
            field: "personId",
            expected: String(actualPersonId),
            actual: String(entry.personId),
            message: `Line ${lineNumber} (rev ${entry.workspaceRevision}): entry personId differs from canonical event actor.`,
          };
        }
        if (requirePersonAttribution && actualPersonId === null) {
          return {
            ok: false,
            code: "audit_person_attribution_missing",
            line: lineNumber,
            workspaceRevision: entry.workspaceRevision,
            opId: entry.opId,
            field: "actor.principal.personId",
            message: `Line ${lineNumber} (rev ${entry.workspaceRevision}): write event is missing personId attribution.`,
          };
        }
        if (actualPersonId !== null) {
          attributedEvents += 1;
        } else {
          unattributedEvents += 1;
          if (firstUnattributed === null) {
            firstUnattributed = { line: lineNumber, workspaceRevision: entry.workspaceRevision, opId: entry.opId };
          }
        }
        attributionHasher.feed(`${entry.workspaceRevision}:${actualPersonId ?? ""}\n`);
        if (firstRevision === null) firstRevision = entry.workspaceRevision;
        lastRevision = entry.workspaceRevision;
        eventCount += 1;
        expectedPrevChainHash = actualChainHash;
        input.certificateCollector?.observe(manifest.repoId, event);
        return null;
      },
      finalize(): AuditSliceVerifyResult {
        if (
          eventCount !== manifest.eventCount ||
          firstRevision !== manifest.firstRevision ||
          lastRevision !== manifest.lastRevision
        ) {
          return {
            ok: false,
            code: "audit_manifest_count_mismatch",
            ...(eventCount < manifest.eventCount ? { line: eventCount + 1 } : {}),
            field: "eventCount",
            expected: `${manifest.eventCount} (${String(manifest.firstRevision)}..${String(manifest.lastRevision)})`,
            actual: `${eventCount} (${String(firstRevision)}..${String(lastRevision)})`,
            message:
              eventCount < manifest.eventCount
                ? `Line ${eventCount + 1}: audit entries stream ended prematurely after ${eventCount} of ${manifest.eventCount} expected entries.`
                : "Audit entries count or revision bounds do not match manifest.",
          };
        }
        if (pureRevision && manifest.window.toRevision !== null && manifest.window.toRevision >= expectedStart) {
          const expectedCount = manifest.window.toRevision - expectedStart + 1;
          if (
            eventCount !== expectedCount ||
            firstRevision !== expectedStart ||
            lastRevision !== manifest.window.toRevision
          ) {
            return {
              ok: false,
              code: "audit_revision_gap",
              field: "window",
              expected: `${expectedCount} (${expectedStart}..${manifest.window.toRevision})`,
              actual: `${eventCount} (${String(firstRevision)}..${String(lastRevision)})`,
              message: `Pure revision window ${expectedStart}..${manifest.window.toRevision} is missing revisions (${eventCount} present).`,
            };
          }
        }
        if (expectedPrevChainHash !== manifest.tipChainHash) {
          return {
            ok: false,
            code: "audit_manifest_tip_mismatch",
            field: "tipChainHash",
            expected: manifest.tipChainHash,
            actual: expectedPrevChainHash,
            message: "Audit entries final chainHash does not match manifest tipChainHash.",
          };
        }
        const actualEntriesDigest = entriesHasher.digest();
        if (actualEntriesDigest !== manifest.entriesDigest) {
          return {
            ok: false,
            code: "audit_manifest_entries_digest_mismatch",
            field: "entriesDigest",
            expected: manifest.entriesDigest,
            actual: actualEntriesDigest,
            message: "Audit JSONL raw-byte digest does not match manifest entriesDigest.",
          };
        }
        const complete = unattributedEvents === 0;
        const attributionStatus: AuditAttributionCompleteness = complete ? "complete" : "incomplete";
        const personAttribution: AuditPersonAttributionSummaryV1 = {
          totalEvents: eventCount,
          attributedEvents,
          unattributedEvents,
          traceableRatio: eventCount === 0 ? 1 : attributedEvents / eventCount,
          complete,
          attributionChainDigest: attributionHasher.digest(),
        };
        if (
          manifest.attributionStatus !== attributionStatus ||
          stableStringify(personAttribution) !== stableStringify(manifest.personAttribution)
        ) {
          return {
            ok: false,
            code: "audit_manifest_attribution_mismatch",
            field: "personAttribution",
            expected: stableStringify({ attributionStatus, personAttribution }),
            actual: stableStringify({
              attributionStatus: manifest.attributionStatus,
              personAttribution: manifest.personAttribution,
            }),
            message: "Manifest personAttribution statistics or attributionStatus do not match verified entries.",
          };
        }
        const { rootHash, ...manifestBody } = manifest;
        const actualRootHash = computeAuditManifestRootHash(manifestBody);
        if (actualRootHash !== rootHash) {
          return {
            ok: false,
            code: "audit_manifest_root_hash_mismatch",
            field: "rootHash",
            expected: actualRootHash,
            actual: rootHash,
            message: "Manifest rootHash does not match recomputed deterministic manifest digest.",
          };
        }
        const anchorPinned = input.expectedRootHash !== undefined;
        if (input.expectedRootHash !== undefined && actualRootHash !== input.expectedRootHash) {
          return {
            ok: false,
            code: "audit_expected_root_hash_mismatch",
            field: "expectedRootHash",
            expected: input.expectedRootHash,
            actual: actualRootHash,
            message: `Verified slice rootHash ${actualRootHash} does not match caller-pinned expectedRootHash ${input.expectedRootHash}.`,
          };
        }
        if (!complete) {
          const first = firstUnattributed!;
          return {
            ok: false,
            diagnostic: true,
            verificationStatus: "diagnostic_incomplete_attribution",
            strictVerified: false,
            chainIntegrityOk: true,
            attributionVerified: false,
            anchorPinned,
            code: "audit_person_attribution_missing",
            message: `Diagnostic check passed chain and manifest digests, but ${unattributedEvents} write event(s) (first at line ${first.line}, rev ${first.workspaceRevision}) lack actor.principal.personId; strict attribution verification failed.`,
            line: first.line,
            workspaceRevision: first.workspaceRevision,
            opId: first.opId,
            field: "actor.principal.personId",
            repoId: manifest.repoId,
            algorithm: manifest.algorithm,
            window: manifest.window,
            eventCount,
            firstRevision,
            lastRevision,
            prevRootHash: manifest.prevRootHash,
            rootHash,
            tipChainHash: expectedPrevChainHash,
            attributionStatus: "incomplete",
            personAttribution,
          };
        }
        return {
          ok: true,
          verificationStatus: "verified",
          strictVerified: true,
          anchorPinned,
          repoId: manifest.repoId,
          algorithm: manifest.algorithm,
          window: manifest.window,
          eventCount,
          firstRevision,
          lastRevision,
          prevRootHash: manifest.prevRootHash,
          rootHash,
          tipChainHash: expectedPrevChainHash,
          attributionStatus: "complete",
          personAttribution,
        };
      },
    },
  };
}

export function verifyAuditSliceSequence(
  previous: {
    readonly repoId: string;
    readonly window: AuditExportWindowV1;
    readonly firstRevision: number | null;
    readonly lastRevision: number | null;
    readonly rootHash: AuditDigest;
  },
  current: {
    readonly repoId: string;
    readonly window: AuditExportWindowV1;
    readonly firstRevision: number | null;
    readonly lastRevision: number | null;
    readonly prevRootHash: AuditDigest;
  },
): AuditVerifyFailure | null {
  if (current.repoId !== previous.repoId) {
    return {
      ok: false,
      code: "audit_slice_sequence_invalid",
      field: "repoId",
      expected: previous.repoId,
      actual: current.repoId,
      message: `Audit slice repoId ${current.repoId} does not match previous slice repoId ${previous.repoId}.`,
    };
  }
  if (current.prevRootHash !== previous.rootHash) {
    return {
      ok: false,
      code: "audit_manifest_chain_link_mismatch",
      field: "prevRootHash",
      expected: previous.rootHash,
      actual: current.prevRootHash,
      message: `Audit slice prevRootHash ${current.prevRootHash} does not link to previous rootHash ${previous.rootHash}.`,
    };
  }
  if (
    previous.lastRevision !== null &&
    current.firstRevision !== null &&
    current.firstRevision <= previous.lastRevision
  ) {
    return {
      ok: false,
      code: "audit_slice_sequence_invalid",
      field: "firstRevision",
      expected: `> ${previous.lastRevision}`,
      actual: String(current.firstRevision),
      message: `Audit slice firstRevision ${current.firstRevision} is not strictly after previous slice lastRevision ${previous.lastRevision}.`,
    };
  }
  if (
    isPureRevisionWindow(previous.window) &&
    isPureRevisionWindow(current.window) &&
    previous.window.toRevision !== null &&
    current.window.fromRevision !== null &&
    current.window.fromRevision !== previous.window.toRevision + 1
  ) {
    return {
      ok: false,
      code: "audit_slice_sequence_invalid",
      field: "window.fromRevision",
      expected: String(previous.window.toRevision + 1),
      actual: String(current.window.fromRevision),
      message: `Pure revision slices must be contiguous: previous toRevision ${previous.window.toRevision}, next fromRevision ${current.window.fromRevision}.`,
    };
  }
  if (
    previous.window.utcDate !== null &&
    current.window.utcDate !== null &&
    current.window.utcDate <= previous.window.utcDate
  ) {
    return {
      ok: false,
      code: "audit_slice_sequence_invalid",
      field: "window.utcDate",
      expected: `> ${previous.window.utcDate}`,
      actual: current.window.utcDate,
      message: `UTC date slice ${current.window.utcDate} is not chronologically after ${previous.window.utcDate}.`,
    };
  }
  if (
    previous.window.before !== null &&
    current.window.after !== null &&
    Date.parse(current.window.after) < Date.parse(previous.window.before)
  ) {
    return {
      ok: false,
      code: "audit_slice_sequence_invalid",
      field: "window.after",
      expected: `>= ${previous.window.before}`,
      actual: current.window.after,
      message: `Time-window slice starting at ${current.window.after} overlaps or precedes previous slice ending at ${previous.window.before}.`,
    };
  }
  return null;
}

export function verifyAuditSliceContent(input: {
  readonly manifest: unknown;
  readonly entriesContent: string | Uint8Array;
  readonly expectedAlgorithm?: AuditHashAlgorithm;
  readonly expectedPrevRootHash?: AuditDigest;
  readonly expectedRootHash?: AuditDigest;
  readonly requirePersonAttribution?: boolean;
  readonly certificateCollector?: AuditCertificateChainCollector;
}): AuditSliceVerifyResult {
  const created = createAuditSliceVerifier({
    manifest: input.manifest,
    ...(input.expectedAlgorithm === undefined ? {} : { expectedAlgorithm: input.expectedAlgorithm }),
    ...(input.expectedPrevRootHash === undefined ? {} : { expectedPrevRootHash: input.expectedPrevRootHash }),
    ...(input.expectedRootHash === undefined ? {} : { expectedRootHash: input.expectedRootHash }),
    ...(input.requirePersonAttribution === undefined
      ? {}
      : { requirePersonAttribution: input.requirePersonAttribution }),
    ...(input.certificateCollector === undefined ? {} : { certificateCollector: input.certificateCollector }),
  });
  if (!created.ok) return created;
  const rawBytes =
    typeof input.entriesContent === "string"
      ? Buffer.from(input.entriesContent, "utf8")
      : Buffer.from(input.entriesContent.buffer, input.entriesContent.byteOffset, input.entriesContent.byteLength);
  created.verifier.feedRawBytes(rawBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;
  let lineNumber = 0;
  while (offset < rawBytes.length) {
    const lfIndex = rawBytes.indexOf(0x0a, offset);
    lineNumber += 1;
    if (lfIndex === -1) {
      return {
        ok: false,
        code: "audit_manifest_entries_digest_mismatch",
        line: lineNumber,
        field: "entriesDigest",
        message: `Line ${lineNumber}: audit entries content is missing its canonical trailing LF byte.`,
      };
    }
    const lineSlice = rawBytes.subarray(offset, lfIndex);
    let lineText: string;
    try {
      lineText = decoder.decode(lineSlice);
    } catch {
      return {
        ok: false,
        code: "audit_entry_parse_failed",
        line: lineNumber,
        field: "encoding",
        message: `Line ${lineNumber}: invalid UTF-8 byte sequence in audit entries stream.`,
      };
    }
    const error = created.verifier.verifyLine(lineText, lineNumber);
    if (error !== null) return error;
    offset = lfIndex + 1;
  }
  return created.verifier.finalize();
}

export function extractDeliveryCertificateChainTarget(certificate: unknown): AuditCertificateChainTarget | null {
  if (!isRecord(certificate) || certificate.schema !== DELIVERY_CERTIFICATE_SCHEMA) return null;
  if (!isNonEmptyString(certificate.taskId) || !isRecord(certificate.completion)) return null;
  if (!isNonEmptyString(certificate.completion.opId)) return null;
  const executionId =
    typeof certificate.executionId === "string" && certificate.executionId !== "" ? certificate.executionId : null;
  return {
    taskId: certificate.taskId,
    completionOpId: certificate.completion.opId,
    executionId,
  };
}

export function verifyDeliveryCertificate(
  certificate: unknown,
  options?: {
    readonly expectedAlgorithm?: AuditHashAlgorithm;
    readonly expectedCertificateHash?: AuditDigest;
    readonly chainEvidence?: AuditCertificateChainEvidence;
  },
): AuditCertificateVerifyResult {
  if (!isRecord(certificate) || certificate.schema !== DELIVERY_CERTIFICATE_SCHEMA) {
    return {
      ok: false,
      code: "audit_certificate_invalid",
      field: "schema",
      message: `Certificate must declare schema ${DELIVERY_CERTIFICATE_SCHEMA}.`,
    };
  }
  if (!isAuditHashAlgorithm(certificate.algorithm)) {
    return {
      ok: false,
      code: "audit_algorithm_unsupported",
      field: "algorithm",
      actual: String(certificate.algorithm),
      message: "Certificate algorithm must be sha256 or sm3.",
    };
  }
  const algorithm = certificate.algorithm;
  if (options?.expectedAlgorithm !== undefined && algorithm !== options.expectedAlgorithm) {
    return {
      ok: false,
      code: "audit_algorithm_mismatch",
      field: "algorithm",
      expected: options.expectedAlgorithm,
      actual: algorithm,
      message: `Certificate algorithm ${algorithm} does not match expected ${options.expectedAlgorithm}.`,
    };
  }
  const completionKind = certificate.completionKind;
  if (
    completionKind !== "native" &&
    completionKind !== "external-resolution" &&
    completionKind !== "sibling-resolution"
  ) {
    return {
      ok: false,
      code: "audit_certificate_invalid",
      field: "completionKind",
      actual: String(completionKind),
      message: "Delivery certificate completionKind must be native, external-resolution, or sibling-resolution.",
    };
  }
  if (
    certificate.status !== "done" ||
    !isNonEmptyString(certificate.repoId) ||
    !isNonEmptyString(certificate.taskId) ||
    !isNonEmptyString(certificate.title) ||
    (certificate.commitSha !== null && typeof certificate.commitSha !== "string") ||
    !Array.isArray(certificate.reviews) ||
    (certificate.reviewConsent !== null && !isRecord(certificate.reviewConsent)) ||
    !isRecord(certificate.completion) ||
    !isNonEmptyString(certificate.completion.opId) ||
    !isNonEmptyString(certificate.completion.eventId) ||
    !Number.isSafeInteger(certificate.completion.workspaceRevision) ||
    Number(certificate.completion.workspaceRevision) < 1 ||
    !isNonEmptyString(certificate.completion.occurredAt) ||
    !isRecord(certificate.completion.actor) ||
    !isAuditDigest(certificate.completion.eventDigest, algorithm) ||
    !isAuditDigest(certificate.certificateHash, algorithm)
  ) {
    return {
      ok: false,
      code: "audit_certificate_invalid",
      message: "Delivery certificate is missing required done-task delivery fields.",
    };
  }
  if (completionKind === "native") {
    if (
      !isNonEmptyString(certificate.executionId) ||
      !Number.isSafeInteger(certificate.iteration) ||
      Number(certificate.iteration) < 0 ||
      typeof certificate.submissionDigest !== "string" ||
      !isRecord(certificate.submission) ||
      certificate.resolution !== null
    ) {
      return {
        ok: false,
        code: "audit_certificate_invalid",
        field: "executionId",
        message:
          "Native delivery certificate requires executionId, iteration, submission, submissionDigest, and resolution=null.",
      };
    }
  } else {
    if (
      certificate.executionId !== null ||
      certificate.iteration !== null ||
      certificate.submission !== null ||
      certificate.submissionDigest !== null ||
      certificate.reviewConsent !== null ||
      !isRecord(certificate.resolution) ||
      certificate.resolution.kind !== completionKind ||
      !isNonEmptyString(certificate.resolution.rationale) ||
      !isNonEmptyString(certificate.resolution.factRef)
    ) {
      return {
        ok: false,
        code: "audit_certificate_invalid",
        field: "resolution",
        message: `${completionKind} delivery certificate must declare resolution details and null native execution fields.`,
      };
    }
    if (completionKind === "external-resolution") {
      if (
        !isNonEmptyString(certificate.resolution.commitSha) ||
        certificate.commitSha !== certificate.resolution.commitSha
      ) {
        return {
          ok: false,
          code: "audit_certificate_invalid",
          field: "resolution.commitSha",
          message: "External-resolution delivery certificate requires commitSha matching resolution.commitSha.",
        };
      }
    } else if (!isNonEmptyString(certificate.resolution.sourceTaskId) || certificate.commitSha !== null) {
      return {
        ok: false,
        code: "audit_certificate_invalid",
        field: "resolution.sourceTaskId",
        message: "Sibling-resolution delivery certificate requires resolution.sourceTaskId and commitSha=null.",
      };
    }
  }

  const cert = certificate as unknown as DeliveryCertificateV1;
  if (cert.completionKind === "native") {
    const actualSubmissionDigest = submissionDigest(cert.submission!);
    if (actualSubmissionDigest !== cert.submissionDigest || cert.commitSha !== cert.submission!.commitSha) {
      return {
        ok: false,
        code: "audit_certificate_submission_digest_mismatch",
        field: "submissionDigest",
        expected: actualSubmissionDigest,
        actual: String(cert.submissionDigest),
        message: "Delivery certificate submissionDigest or commitSha does not match its frozen submission.",
      };
    }
  }
  for (const review of cert.reviews) {
    if (!isRecord(review) || review.taskId !== cert.taskId) {
      return {
        ok: false,
        code: "audit_certificate_invalid",
        field: "reviews",
        message: "Delivery certificate contains a review not bound to this task.",
      };
    }
  }
  if (cert.reviewConsent !== null) {
    const consent = cert.reviewConsent;
    const matchedReview = cert.reviews.find((review) => review.reviewId === consent.reviewId);
    if (
      consent.schema !== "review-consent/v1" ||
      consent.taskId !== cert.taskId ||
      consent.executionId !== cert.executionId ||
      (consent.submissionDigest !== undefined && consent.submissionDigest !== cert.submissionDigest) ||
      matchedReview === undefined ||
      consent.reviewDigest !== reviewDigest(matchedReview) ||
      consent.contentDigest !== matchedReview.contentDigest
    ) {
      return {
        ok: false,
        code: "audit_certificate_consent_mismatch",
        field: "reviewConsent",
        expected: matchedReview ? reviewDigest(matchedReview) : "matching review in certificate.reviews",
        actual: String(consent.reviewDigest),
        message: "Delivery certificate reviewConsent does not cryptographically match its review or submission.",
      };
    }
  }
  const { certificateHash, ...body } = cert;
  const actualCertificateHash = computeDeliveryCertificateHash(body);
  if (actualCertificateHash !== certificateHash) {
    return {
      ok: false,
      code: "audit_certificate_hash_mismatch",
      field: "certificateHash",
      expected: actualCertificateHash,
      actual: certificateHash,
      message: "Delivery certificate certificateHash does not match recomputed digest.",
    };
  }
  const anchorPinned = options?.expectedCertificateHash !== undefined;
  if (options?.expectedCertificateHash !== undefined && actualCertificateHash !== options.expectedCertificateHash) {
    return {
      ok: false,
      code: "audit_expected_certificate_hash_mismatch",
      field: "expectedCertificateHash",
      expected: options.expectedCertificateHash,
      actual: actualCertificateHash,
      message: `Verified certificateHash ${actualCertificateHash} does not match caller-pinned expectedCertificateHash ${options.expectedCertificateHash}.`,
    };
  }

  let chainEvidenceSummary: AuditCertificateVerifySuccess["chainEvidence"];
  if (options?.chainEvidence !== undefined) {
    const bound = verifyCertificateAgainstChain(cert, options.chainEvidence);
    if (!bound.ok) return bound;
    chainEvidenceSummary = bound.summary;
  }

  return {
    ok: true,
    verificationStatus: "verified",
    anchorPinned,
    repoId: cert.repoId,
    taskId: cert.taskId,
    completionKind: cert.completionKind,
    executionId: cert.executionId,
    algorithm,
    commitSha: cert.commitSha,
    submissionDigest: cert.submissionDigest,
    resolution: cert.resolution,
    reviewCount: cert.reviews.length,
    consentId: cert.reviewConsent?.consentId ?? null,
    completionOpId: cert.completion.opId,
    completionRevision: cert.completion.workspaceRevision,
    certificateHash,
    ...(chainEvidenceSummary === undefined ? {} : { chainEvidence: chainEvidenceSummary }),
  };
}

function verifyCertificateAgainstChain(
  cert: DeliveryCertificateV1,
  evidence: AuditCertificateChainEvidence,
):
  | { readonly ok: true; readonly summary: NonNullable<AuditCertificateVerifySuccess["chainEvidence"]> }
  | AuditVerifyFailure {
  const observedCompletion = evidence.completionEvent;
  if (observedCompletion === null) {
    return {
      ok: false,
      code: "audit_certificate_event_mismatch",
      workspaceRevision: cert.completion.workspaceRevision,
      opId: cert.completion.opId,
      field: "completion.opId",
      expected: cert.completion.opId,
      actual: "missing",
      message: `Completion event ${cert.completion.opId} (rev ${cert.completion.workspaceRevision}) was not found in the verified audit chain.`,
    };
  }
  if (observedCompletion.repoId !== cert.repoId) {
    return {
      ok: false,
      code: "audit_certificate_event_mismatch",
      workspaceRevision: cert.completion.workspaceRevision,
      opId: cert.completion.opId,
      field: "repoId",
      expected: observedCompletion.repoId,
      actual: cert.repoId,
      message: `Certificate repoId ${cert.repoId} does not match verified audit chain repoId ${observedCompletion.repoId}.`,
    };
  }
  const event = observedCompletion.event;
  const eventRecord = event as unknown as Record<string, unknown>;
  if (
    event.schema !== "task-event/v1" ||
    event.type !== "task_completed" ||
    eventRecord.taskId !== cert.taskId ||
    event.eventId !== cert.completion.eventId ||
    event.workspaceRevision !== cert.completion.workspaceRevision ||
    event.occurredAt !== cert.completion.occurredAt ||
    stableStringify(event.actor) !== stableStringify(cert.completion.actor)
  ) {
    return {
      ok: false,
      code: "audit_certificate_event_mismatch",
      workspaceRevision: cert.completion.workspaceRevision,
      opId: cert.completion.opId,
      field: "completion",
      message: `Canonical event ${event.opId} in the verified audit chain does not match certificate task/type/actor/metadata.`,
    };
  }
  // Independent algorithm binding: recompute canonical event digest using the certificate's algorithm.
  const recomputedInCertAlgorithm = computeCanonicalEventDigest(cert.algorithm, event);
  if (recomputedInCertAlgorithm !== cert.completion.eventDigest) {
    return {
      ok: false,
      code: "audit_certificate_event_mismatch",
      workspaceRevision: cert.completion.workspaceRevision,
      opId: cert.completion.opId,
      field: "completion.eventDigest",
      expected: recomputedInCertAlgorithm,
      actual: cert.completion.eventDigest,
      message: `Canonical task_completed event digest (${cert.algorithm}) does not match certificate completion.eventDigest.`,
    };
  }
  const completedPayload = (event as TaskCompletedEvent).payload;
  if (cert.completionKind === "native") {
    if (completedPayload.externalResolution !== undefined || completedPayload.siblingResolution !== undefined) {
      return {
        ok: false,
        code: "audit_certificate_event_mismatch",
        workspaceRevision: cert.completion.workspaceRevision,
        opId: cert.completion.opId,
        field: "completionKind",
        expected: completedPayload.externalResolution ? "external-resolution" : "sibling-resolution",
        actual: "native",
        message: "Canonical task_completed event is a resolution completion, not a native execution completion.",
      };
    }
    const canonicalExec = completedPayload.execution;
    if (
      canonicalExec === undefined ||
      canonicalExec.executionId !== cert.executionId ||
      canonicalExec.iteration !== cert.iteration ||
      canonicalExec.submission === null ||
      submissionDigest(canonicalExec.submission) !== cert.submissionDigest ||
      stableStringify(canonicalExec.submission) !== stableStringify(cert.submission) ||
      canonicalExec.submission.commitSha !== cert.commitSha
    ) {
      return {
        ok: false,
        code: "audit_certificate_event_mismatch",
        workspaceRevision: cert.completion.workspaceRevision,
        opId: cert.completion.opId,
        field: "submission",
        message: "Certificate execution/submission does not match the canonical task_completed event payload.",
      };
    }
  } else if (cert.completionKind === "external-resolution") {
    const canonicalRes = completedPayload.externalResolution;
    const certRes = cert.resolution as DeliveryCertificateExternalResolutionV1;
    if (
      canonicalRes === undefined ||
      canonicalRes.commitSha !== certRes.commitSha ||
      canonicalRes.rationale !== certRes.rationale ||
      canonicalRes.factRef !== certRes.factRef
    ) {
      return {
        ok: false,
        code: "audit_certificate_event_mismatch",
        workspaceRevision: cert.completion.workspaceRevision,
        opId: cert.completion.opId,
        field: "resolution",
        message: "Certificate externalResolution does not match the canonical task_completed event payload.",
      };
    }
  } else {
    const canonicalRes = completedPayload.siblingResolution;
    const certRes = cert.resolution as DeliveryCertificateSiblingResolutionV1;
    if (
      canonicalRes === undefined ||
      canonicalRes.sourceTaskId !== certRes.sourceTaskId ||
      canonicalRes.rationale !== certRes.rationale ||
      canonicalRes.factRef !== certRes.factRef
    ) {
      return {
        ok: false,
        code: "audit_certificate_event_mismatch",
        workspaceRevision: cert.completion.workspaceRevision,
        opId: cert.completion.opId,
        field: "resolution",
        message: "Certificate siblingResolution does not match the canonical task_completed event payload.",
      };
    }
  }

  const fullHistoryObserved = evidence.firstObservedRevision === 1 || evidence.sawTaskStartOrCreate;
  const certReviewMap = new Map(cert.reviews.map((review) => [review.reviewId, review]));
  let reviewsVerifiedCount = 0;

  for (const review of cert.reviews) {
    const observed = evidence.reviewEvents.get(review.reviewId);
    if (observed !== undefined) {
      if (stableStringify(observed) !== stableStringify(review)) {
        return {
          ok: false,
          code: "audit_certificate_event_mismatch",
          field: "reviews",
          expected: reviewDigest(observed),
          actual: reviewDigest(review),
          message: `Certificate review ${review.reviewId} differs from canonical review_recorded event in verified audit chain.`,
        };
      }
      reviewsVerifiedCount += 1;
    } else if (fullHistoryObserved || isTimestampStrictlyInsideChain(review.reviewedAt, evidence)) {
      return {
        ok: false,
        code: "audit_certificate_event_mismatch",
        field: "reviews",
        expected: "canonical review_recorded event in verified chain",
        actual: review.reviewId,
        message: `Certificate review ${review.reviewId} is absent from the verified canonical audit chain.`,
      };
    }
  }
  for (const [reviewId] of evidence.reviewEvents) {
    if (!certReviewMap.has(reviewId)) {
      return {
        ok: false,
        code: "audit_certificate_event_mismatch",
        field: "reviews",
        expected: reviewId,
        actual: "omitted",
        message: `Canonical review_recorded event ${reviewId} for task ${cert.taskId} is missing from certificate.reviews.`,
      };
    }
  }

  let consentVerified: boolean | "not_applicable" | "not_in_slice_window" = "not_applicable";
  if (cert.reviewConsent !== null) {
    const observedConsent = evidence.consentEvents.get(cert.reviewConsent.consentId);
    if (observedConsent !== undefined) {
      if (
        stableStringify(observedConsent.consent) !== stableStringify(cert.reviewConsent) ||
        observedConsent.executionId !== cert.executionId ||
        reviewDigest(observedConsent.review) !== cert.reviewConsent.reviewDigest
      ) {
        return {
          ok: false,
          code: "audit_certificate_consent_mismatch",
          field: "reviewConsent",
          expected: observedConsent.consent.reviewDigest,
          actual: cert.reviewConsent.reviewDigest,
          message: `Certificate reviewConsent ${cert.reviewConsent.consentId} differs from canonical consent event in verified audit chain.`,
        };
      }
      consentVerified = true;
    } else if (fullHistoryObserved || isTimestampStrictlyInsideChain(cert.reviewConsent.consentedAt, evidence)) {
      return {
        ok: false,
        code: "audit_certificate_consent_mismatch",
        field: "reviewConsent",
        expected: "canonical review_consent_recorded event in verified chain",
        actual: cert.reviewConsent.consentId,
        message: `Certificate reviewConsent ${cert.reviewConsent.consentId} is absent from the verified canonical audit chain.`,
      };
    } else {
      consentVerified = "not_in_slice_window";
    }
  } else if (cert.completionKind === "native" && cert.executionId !== null) {
    const observedConsents = evidence.consentsByExecution.get(cert.executionId) ?? [];
    if (observedConsents.length > 0) {
      return {
        ok: false,
        code: "audit_certificate_consent_mismatch",
        field: "reviewConsent",
        expected: observedConsents.at(-1)!.consentId,
        actual: "null",
        message: `Verified audit chain contains canonical review consent ${observedConsents.at(-1)!.consentId} for execution ${cert.executionId}, but certificate reviewConsent is null.`,
      };
    }
  }

  return {
    ok: true,
    summary: {
      completionVerified: true,
      reviewsVerifiedCount,
      consentVerified,
    },
  };
}

function isTimestampStrictlyInsideChain(timestampText: string, evidence: AuditCertificateChainEvidence): boolean {
  const target = Date.parse(timestampText),
    first = evidence.firstObservedOccurredAt === null ? Number.NaN : Date.parse(evidence.firstObservedOccurredAt),
    last = evidence.lastObservedOccurredAt === null ? Number.NaN : Date.parse(evidence.lastObservedOccurredAt);
  return target > first && target < last;
}

function parseWindowShape(
  value: unknown,
): { readonly ok: true; readonly window: AuditExportWindowV1 } | AuditVerifyFailure {
  if (!isRecord(value)) {
    return {
      ok: false,
      code: "audit_manifest_invalid",
      field: "window",
      message: "Manifest window must be an object.",
    };
  }
  const { fromRevision, toRevision, utcDate, after, before } = value;
  const validRev = (v: unknown): v is number | null =>
    v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 1);
  if (!validRev(fromRevision) || !validRev(toRevision)) {
    return {
      ok: false,
      code: "audit_manifest_invalid",
      field: "window",
      message: "Manifest window fromRevision/toRevision must be null or positive safe integers.",
    };
  }
  if (fromRevision !== null && toRevision !== null && fromRevision > toRevision) {
    return {
      ok: false,
      code: "audit_manifest_invalid",
      field: "window",
      message: "Manifest window fromRevision must not exceed toRevision.",
    };
  }
  if (utcDate !== null && (typeof utcDate !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(utcDate))) {
    return {
      ok: false,
      code: "audit_manifest_invalid",
      field: "window.utcDate",
      message: "Manifest window utcDate must be null or YYYY-MM-DD.",
    };
  }
  const validIso = (v: unknown): v is string | null =>
    v === null || (typeof v === "string" && !Number.isNaN(Date.parse(v)));
  if (!validIso(after) || !validIso(before)) {
    return {
      ok: false,
      code: "audit_manifest_invalid",
      field: "window",
      message: "Manifest window after/before must be null or valid ISO-8601 timestamps.",
    };
  }
  if (after !== null && before !== null && Date.parse(after) > Date.parse(before)) {
    return {
      ok: false,
      code: "audit_manifest_invalid",
      field: "window",
      message: "Manifest window after must not be later than before.",
    };
  }
  if (utcDate !== null && (after !== `${utcDate}T00:00:00.000Z` || before !== `${utcDate}T23:59:59.999Z`)) {
    return {
      ok: false,
      code: "audit_manifest_invalid",
      field: "window.utcDate",
      message: "Manifest window utcDate does not match its after/before UTC day boundaries.",
    };
  }
  return { ok: true, window: { fromRevision, toRevision, utcDate, after, before } };
}

function parseManifestShape(
  value: unknown,
): { readonly ok: true; readonly manifest: AuditExportManifestV1 } | AuditVerifyFailure {
  if (!isRecord(value) || value.schema !== AUDIT_EXPORT_MANIFEST_SCHEMA) {
    return {
      ok: false,
      code: "audit_manifest_invalid",
      field: "schema",
      message: `Manifest must declare schema ${AUDIT_EXPORT_MANIFEST_SCHEMA}.`,
    };
  }
  if (!isAuditHashAlgorithm(value.algorithm)) {
    return {
      ok: false,
      code: "audit_algorithm_unsupported",
      field: "algorithm",
      actual: String(value.algorithm),
      message: "Manifest algorithm must be sha256 or sm3.",
    };
  }
  const algorithm = value.algorithm;
  const parsedWindow = parseWindowShape(value.window);
  if (!parsedWindow.ok) return parsedWindow;
  if (
    !isNonEmptyString(value.repoId) ||
    !isAuditDigest(value.prevRootHash, algorithm) ||
    !Number.isSafeInteger(value.eventCount) ||
    Number(value.eventCount) < 0 ||
    !isNonEmptyString(value.entriesFile) ||
    !isAuditDigest(value.entriesDigest, algorithm) ||
    !isAuditDigest(value.tipChainHash, algorithm) ||
    (value.attributionStatus !== "complete" && value.attributionStatus !== "incomplete") ||
    !isRecord(value.personAttribution) ||
    !isAuditDigest(value.rootHash, algorithm) ||
    (value.firstRevision !== null && (!Number.isSafeInteger(value.firstRevision) || Number(value.firstRevision) < 1)) ||
    (value.lastRevision !== null && (!Number.isSafeInteger(value.lastRevision) || Number(value.lastRevision) < 1))
  ) {
    return {
      ok: false,
      code: "audit_manifest_invalid",
      message: "Audit manifest is missing required structural fields or valid digests.",
    };
  }
  return {
    ok: true,
    manifest: {
      ...(value as unknown as AuditExportManifestV1),
      window: parsedWindow.window,
    },
  };
}

function entryShapeError(
  value: unknown,
  algorithm: AuditHashAlgorithm,
  line: number,
): { readonly ok: true; readonly entry: AuditExportEntryV1 } | AuditVerifyFailure {
  if (!isRecord(value) || value.schema !== AUDIT_EXPORT_ENTRY_SCHEMA) {
    return {
      ok: false,
      code: "audit_entry_parse_failed",
      line,
      field: "schema",
      message: `Line ${line}: entry must declare schema ${AUDIT_EXPORT_ENTRY_SCHEMA}.`,
    };
  }
  if (value.algorithm !== algorithm) {
    return {
      ok: false,
      code: "audit_algorithm_mismatch",
      line,
      field: "algorithm",
      expected: algorithm,
      actual: String(value.algorithm),
      message: `Line ${line}: entry algorithm ${String(value.algorithm)} differs from manifest algorithm ${algorithm}.`,
    };
  }
  if (
    !Number.isSafeInteger(value.workspaceRevision) ||
    Number(value.workspaceRevision) < 1 ||
    !isNonEmptyString(value.opId) ||
    !isNonEmptyString(value.eventId) ||
    !isNonEmptyString(value.type) ||
    !isNonEmptyString(value.occurredAt) ||
    (value.personId !== null && typeof value.personId !== "string") ||
    (value.executorId !== null && typeof value.executorId !== "string") ||
    !isAuditDigest(value.eventDigest, algorithm) ||
    !isAuditDigest(value.prevChainHash, algorithm) ||
    !isAuditDigest(value.chainHash, algorithm) ||
    !isRecord(value.event)
  ) {
    return {
      ok: false,
      code: "audit_entry_parse_failed",
      line,
      message: `Line ${line}: entry is missing required fields or valid ${algorithm} digests.`,
    };
  }
  return { ok: true, entry: value as unknown as AuditExportEntryV1 };
}
