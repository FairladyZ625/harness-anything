import { normalizePersistedEventValue } from "../domain/doc-sync-canonical-events.ts";
import type { PersistedCanonicalEventV1 } from "../domain/doc-sync-types.ts";
import { submissionDigest, type ExecutionV1, type SubmissionV1 } from "../domain/execution.ts";
import { isMigrationImportEvent, type MigrationImportEventV1 } from "../domain/migration-import-event.ts";
import { reviewDigest, type ReviewConsentV1, type ReviewV1 } from "../domain/review.ts";
import type { TaskCompletedEvent } from "../domain/task-lifecycle-event.ts";
import type { TaskV2 } from "../domain/task.ts";
import { isNonEmptyString, isRecord } from "../domain/contract-validation.ts";
import { isAuditHashAlgorithm, stableStringify, type AuditDigest, type AuditHashAlgorithm } from "./stable-hash.ts";
import {
  computeCanonicalEventDigest,
  computeDeliveryCertificateHash,
  DELIVERY_CERTIFICATE_SCHEMA,
  isAuditDigest,
  isPureRevisionWindow,
  type AuditCertificateChainCollector,
  type AuditCertificateChainEvidence,
  type AuditCertificateChainSummary,
  type AuditCertificateChainTarget,
  type AuditCertificateVerifyResult,
  type AuditVerifiedSliceInterval,
  type AuditVerifyFailure,
  type DeliveryCertificateCompletionKind,
  type DeliveryCertificateExternalResolutionV1,
  type DeliveryCertificateImportedMigrationV1,
  type DeliveryCertificateResolutionV1,
  type DeliveryCertificateSiblingResolutionV1,
  type DeliveryCertificateV1,
} from "./audit-types.ts";

const IMPORTED_MIGRATION_GENERATION = "v0" as const;

export function createAuditCertificateChainCollector(
  target: AuditCertificateChainTarget,
): AuditCertificateChainCollector {
  const repoIds = new Set<string>();
  const verifiedSlices: AuditVerifiedSliceInterval[] = [];
  const reviewEvents = new Map<string, ReviewV1>();
  const consentEvents = new Map<
    string,
    { readonly review: ReviewV1; readonly consent: ReviewConsentV1; readonly executionId: string }
  >();
  const consentsByExecution = new Map<string, ReviewConsentV1[]>();
  const executionStartedRevisions = new Map<string, number>();
  const executionStartedOccurredAt = new Map<string, string>();
  let taskOriginRevision: number | null = null;
  let taskOriginOccurredAt: string | null = null;
  let completionEvent: { readonly repoId: string; readonly event: PersistedCanonicalEventV1 } | null = null;

  const recordTaskOrigin = (rev: number, occurredAt: string) => {
    if (taskOriginRevision === null || rev < taskOriginRevision) {
      taskOriginRevision = rev;
    }
    if (taskOriginOccurredAt === null || Date.parse(occurredAt) < Date.parse(taskOriginOccurredAt)) {
      taskOriginOccurredAt = occurredAt;
    }
  };

  return {
    observe(repoId, event) {
      repoIds.add(repoId);
      if (event.opId === target.completionOpId) {
        completionEvent = { repoId, event };
      }
      if (
        isMigrationImportEvent(event) &&
        event.payload.entity.kind === "task" &&
        event.payload.entity.task.taskId === target.taskId
      ) {
        recordTaskOrigin(event.workspaceRevision, event.occurredAt);
      }
      const record = event as unknown as Record<string, unknown>;
      const eventTaskId = typeof record.taskId === "string" ? record.taskId : null;
      if (eventTaskId !== target.taskId) return;
      if (event.type === "task_created" || event.type === "task_bootstrapped") {
        recordTaskOrigin(event.workspaceRevision, event.occurredAt);
      }
      const payload = isRecord(record.payload) ? record.payload : null;
      if (event.type === "execution_started" && payload && isRecord(payload.execution)) {
        const execId = payload.execution.executionId;
        if (isNonEmptyString(execId)) {
          const prevRev = executionStartedRevisions.get(execId);
          if (prevRev === undefined || event.workspaceRevision < prevRev) {
            executionStartedRevisions.set(execId, event.workspaceRevision);
          }
          const prevAt = executionStartedOccurredAt.get(execId);
          if (prevAt === undefined || Date.parse(event.occurredAt) < Date.parse(prevAt)) {
            executionStartedOccurredAt.set(execId, event.occurredAt);
          }
        }
      } else if (event.type === "review_recorded" && payload && isRecord(payload.review)) {
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
    observeSlice(slice) {
      verifiedSlices.push(slice);
    },
    evidence(): AuditCertificateChainEvidence {
      return {
        repoIds,
        verifiedSlices,
        taskOriginRevision,
        taskOriginOccurredAt,
        executionStartedRevisions,
        executionStartedOccurredAt,
        completionEvent,
        reviewEvents,
        consentEvents,
        consentsByExecution,
      };
    },
  };
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

export function buildDeliveryCertificate(input: {
  readonly algorithm?: AuditHashAlgorithm;
  readonly repoId: string;
  readonly task: TaskV2;
  readonly execution: ExecutionV1 | null;
  readonly reviews: readonly ReviewV1[];
  readonly reviewConsent: ReviewConsentV1 | null;
  readonly completionEvent: TaskCompletedEvent | MigrationImportEventV1;
}): DeliveryCertificateV1 {
  const algorithm = input.algorithm ?? "sha256";
  if (input.task.status !== "done") {
    throw new Error(`Delivery certificate requires a done task; got status ${input.task.status}`);
  }
  const sortedReviews = [...input.reviews].sort((left, right) => {
    const leftMs = Date.parse(left.reviewedAt);
    const rightMs = Date.parse(right.reviewedAt);
    if (leftMs !== rightMs && !Number.isNaN(leftMs) && !Number.isNaN(rightMs)) {
      return leftMs - rightMs;
    }
    return left.reviewId.localeCompare(right.reviewId);
  });

  let completionKind: DeliveryCertificateCompletionKind;
  let executionId: string | null = null;
  let iteration: number | null = null;
  let commitSha: string | null = null;
  let computedSubmissionDigest: `sha256:${string}` | null = null;
  let submission: SubmissionV1 | null = null;
  let resolution: DeliveryCertificateResolutionV1 | null = null;
  let reviewConsent: ReviewConsentV1 | null = null;

  if (isMigrationImportEvent(input.completionEvent)) {
    const entity = input.completionEvent.payload.entity;
    if (
      input.completionEvent.type !== "entity_migrated" ||
      entity.kind !== "task" ||
      entity.task.taskId !== input.task.taskId ||
      entity.task.status !== "done"
    ) {
      throw new Error(`Migration import completion event does not represent done task ${input.task.taskId}`);
    }
    completionKind = "imported-migration";
    resolution = {
      kind: "imported-migration",
      migratedFrom: input.completionEvent.payload.migratedFrom,
      generation: input.completionEvent.payload.generation,
      originalStatus: entity.originalStatus,
      packagePath: entity.packagePath,
    };
  } else {
    if (input.completionEvent.type !== "task_completed" || input.completionEvent.taskId !== input.task.taskId) {
      throw new Error(`Completion event does not match task ${input.task.taskId}`);
    }
    const completionPayload = input.completionEvent.payload;
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
    completionKind !== "sibling-resolution" &&
    completionKind !== "imported-migration"
  ) {
    return {
      ok: false,
      code: "audit_certificate_invalid",
      field: "completionKind",
      actual: String(completionKind),
      message:
        "Delivery certificate completionKind must be native, external-resolution, sibling-resolution, or imported-migration.",
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
  const kindError = completionKindShapeError(certificate, completionKind);
  if (kindError !== null) return kindError;

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
    const reviewDigestMatches =
      matchedReview !== undefined &&
      (consent.reviewDigest === reviewDigest(matchedReview) ||
        consent.reviewDigest === reviewDigest(normalizePersistedEventValue(matchedReview)));
    if (
      consent.schema !== "review-consent/v1" ||
      consent.taskId !== cert.taskId ||
      consent.executionId !== cert.executionId ||
      (consent.submissionDigest !== undefined && consent.submissionDigest !== cert.submissionDigest) ||
      matchedReview === undefined ||
      !reviewDigestMatches ||
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

  let chainEvidenceSummary: AuditCertificateChainSummary | undefined;
  if (options?.chainEvidence !== undefined) {
    const bound = verifyCertificateAgainstChain(cert, options.chainEvidence);
    if (!bound.ok) return bound;
    chainEvidenceSummary = bound.summary;
  }

  const strictVerified =
    anchorPinned && (chainEvidenceSummary === undefined || chainEvidenceSummary.coverage === "complete");
  return {
    ok: true,
    verificationStatus: "verified",
    verificationMode: strictVerified ? "strict" : "self-consistent-only",
    selfConsistent: true,
    strictVerified,
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

function completionKindShapeError(
  certificate: Record<string, unknown>,
  completionKind: DeliveryCertificateCompletionKind,
): AuditVerifyFailure | null {
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
    return null;
  }
  if (
    certificate.executionId !== null ||
    certificate.iteration !== null ||
    certificate.submission !== null ||
    certificate.submissionDigest !== null ||
    certificate.reviewConsent !== null ||
    !isRecord(certificate.resolution) ||
    certificate.resolution.kind !== completionKind
  ) {
    return {
      ok: false,
      code: "audit_certificate_invalid",
      field: "resolution",
      message: `${completionKind} delivery certificate must declare resolution details and null native execution fields.`,
    };
  }
  if (completionKind === "imported-migration") {
    const genOk = certificate.resolution.generation === IMPORTED_MIGRATION_GENERATION;
    if (
      !isNonEmptyString(certificate.resolution.migratedFrom) ||
      !genOk ||
      !isNonEmptyString(certificate.resolution.originalStatus) ||
      !isNonEmptyString(certificate.resolution.packagePath) ||
      certificate.commitSha !== null
    ) {
      return {
        ok: false,
        code: "audit_certificate_invalid",
        field: "resolution",
        message:
          "Imported-migration delivery certificate requires migratedFrom, generation='v0', originalStatus, packagePath, and commitSha=null.",
      };
    }
    return null;
  }
  if (!isNonEmptyString(certificate.resolution.rationale) || !isNonEmptyString(certificate.resolution.factRef)) {
    return {
      ok: false,
      code: "audit_certificate_invalid",
      field: "resolution",
      message: `${completionKind} delivery certificate requires rationale and factRef.`,
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
  return null;
}

function verifyCertificateAgainstChain(
  cert: DeliveryCertificateV1,
  evidence: AuditCertificateChainEvidence,
): { readonly ok: true; readonly summary: AuditCertificateChainSummary } | AuditVerifyFailure {
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
  if (
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
      message: `Canonical event ${event.opId} in the verified audit chain does not match certificate actor/metadata.`,
    };
  }
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
      message: `Canonical completion event digest (${cert.algorithm}) does not match certificate completion.eventDigest.`,
    };
  }

  const payloadError = verifyCompletionPayloadAgainstChain(cert, event);
  if (payloadError !== null) return payloadError;

  const coverageIntervals = buildVerifiedCoverageIntervals(
    evidence.verifiedSlices,
    cert.repoId,
    cert.completion.workspaceRevision,
  );
  const completionRev = cert.completion.workspaceRevision;
  const completionMs = Date.parse(cert.completion.occurredAt);
  const fullTaskLifecycleCovered =
    cert.completionKind === "imported-migration" ||
    intervalSetCoversSpan(coverageIntervals.revisions, 1, completionRev) ||
    (evidence.taskOriginRevision !== null &&
      intervalSetCoversSpan(coverageIntervals.revisions, evidence.taskOriginRevision, completionRev)) ||
    (evidence.taskOriginOccurredAt !== null &&
      intervalSetCoversSpan(coverageIntervals.timestamps, Date.parse(evidence.taskOriginOccurredAt), completionMs));
  const execStartRev = cert.executionId === null ? undefined : evidence.executionStartedRevisions.get(cert.executionId);
  const execStartAt = cert.executionId === null ? undefined : evidence.executionStartedOccurredAt.get(cert.executionId);
  const fullExecutionConsentWindowCovered =
    fullTaskLifecycleCovered ||
    (execStartRev !== undefined && intervalSetCoversSpan(coverageIntervals.revisions, execStartRev, completionRev)) ||
    (execStartAt !== undefined &&
      intervalSetCoversSpan(coverageIntervals.timestamps, Date.parse(execStartAt), completionMs));

  const certReviewMap = new Map(cert.reviews.map((review) => [review.reviewId, review]));
  let reviewsVerifiedCount = 0;
  const uncoveredReviewIds: string[] = [];

  for (const review of cert.reviews) {
    const observed = evidence.reviewEvents.get(review.reviewId);
    if (observed !== undefined) {
      if (
        stableStringify(normalizePersistedEventValue(observed)) !==
        stableStringify(normalizePersistedEventValue(review))
      ) {
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
    } else if (
      fullTaskLifecycleCovered ||
      timestampStrictlyInsideIntervals(review.reviewedAt, coverageIntervals.timestamps)
    ) {
      return {
        ok: false,
        code: "audit_certificate_event_mismatch",
        field: "reviews",
        expected: "canonical review_recorded event in verified chain",
        actual: review.reviewId,
        message: `Certificate review ${review.reviewId} is absent from the verified canonical audit chain.`,
      };
    } else {
      uncoveredReviewIds.push(review.reviewId);
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
  let uncoveredConsentId: string | null = null;
  if (cert.reviewConsent !== null) {
    const observedConsent = evidence.consentEvents.get(cert.reviewConsent.consentId);
    if (observedConsent !== undefined) {
      const consentReviewDigestOk =
        reviewDigest(observedConsent.review) === cert.reviewConsent.reviewDigest ||
        reviewDigest(normalizePersistedEventValue(observedConsent.review)) === cert.reviewConsent.reviewDigest;
      if (
        stableStringify(normalizePersistedEventValue(observedConsent.consent)) !==
          stableStringify(normalizePersistedEventValue(cert.reviewConsent)) ||
        observedConsent.executionId !== cert.executionId ||
        !consentReviewDigestOk
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
    } else if (
      fullExecutionConsentWindowCovered ||
      timestampStrictlyInsideIntervals(cert.reviewConsent.consentedAt, coverageIntervals.timestamps)
    ) {
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
      uncoveredConsentId = cert.reviewConsent.consentId;
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
    if (!fullExecutionConsentWindowCovered) {
      consentVerified = "not_in_slice_window";
    }
  }

  const allClaimedCovered = uncoveredReviewIds.length === 0 && uncoveredConsentId === null;
  const absenceProven =
    cert.completionKind === "imported-migration" ||
    (fullTaskLifecycleCovered &&
      (cert.reviewConsent !== null || cert.completionKind !== "native" || fullExecutionConsentWindowCovered));
  const coverage = allClaimedCovered && absenceProven ? "complete" : "partial";
  return {
    ok: true,
    summary: {
      completionVerified: true,
      coverage,
      reviewsTotalCount: cert.reviews.length,
      reviewsVerifiedCount,
      uncoveredReviewIds,
      consentVerified,
      uncoveredConsentId,
    },
  };
}

function verifyCompletionPayloadAgainstChain(
  cert: DeliveryCertificateV1,
  event: PersistedCanonicalEventV1,
): AuditVerifyFailure | null {
  if (cert.completionKind === "imported-migration") {
    if (!isMigrationImportEvent(event) || event.type !== "entity_migrated" || event.payload.entity.kind !== "task") {
      return {
        ok: false,
        code: "audit_certificate_event_mismatch",
        workspaceRevision: cert.completion.workspaceRevision,
        opId: cert.completion.opId,
        field: "completionKind",
        message: "Canonical event in verified audit chain is not a task migration-import event.",
      };
    }
    const entity = event.payload.entity;
    const certRes = cert.resolution as DeliveryCertificateImportedMigrationV1;
    if (
      entity.task.taskId !== cert.taskId ||
      entity.task.status !== cert.status ||
      event.payload.migratedFrom !== certRes.migratedFrom ||
      event.payload.generation !== certRes.generation ||
      entity.originalStatus !== certRes.originalStatus ||
      entity.packagePath !== certRes.packagePath
    ) {
      return {
        ok: false,
        code: "audit_certificate_event_mismatch",
        workspaceRevision: cert.completion.workspaceRevision,
        opId: cert.completion.opId,
        field: "resolution",
        message: "Certificate imported-migration resolution does not match canonical entity_migrated event.",
      };
    }
    return null;
  }

  const eventRecord = event as unknown as Record<string, unknown>;
  if (event.schema !== "task-event/v1" || event.type !== "task_completed" || eventRecord.taskId !== cert.taskId) {
    return {
      ok: false,
      code: "audit_certificate_event_mismatch",
      workspaceRevision: cert.completion.workspaceRevision,
      opId: cert.completion.opId,
      field: "completion",
      message: `Canonical event ${event.opId} in the verified audit chain does not match task_completed for ${cert.taskId}.`,
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
      stableStringify(normalizePersistedEventValue(canonicalExec.submission)) !==
        stableStringify(normalizePersistedEventValue(cert.submission)) ||
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
    return null;
  }
  if (cert.completionKind === "external-resolution") {
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
    return null;
  }
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
  return null;
}

interface ClosedNumericInterval {
  readonly start: number;
  readonly end: number;
}

function mergeContiguousIntervals(intervals: readonly ClosedNumericInterval[]): readonly ClosedNumericInterval[] {
  if (intervals.length <= 1) return intervals;
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: ClosedNumericInterval[] = [sorted[0]!];
  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index]!;
    const prev = merged.at(-1)!;
    if (current.start <= prev.end + 1) {
      merged[merged.length - 1] = { start: prev.start, end: Math.max(prev.end, current.end) };
    } else {
      merged.push(current);
    }
  }
  return merged;
}

function buildVerifiedCoverageIntervals(
  slices: readonly AuditVerifiedSliceInterval[],
  repoId: string,
  completionRevision: number,
): {
  readonly revisions: readonly ClosedNumericInterval[];
  readonly timestamps: readonly ClosedNumericInterval[];
} {
  const revIntervals: ClosedNumericInterval[] = [];
  const timeIntervals: ClosedNumericInterval[] = [];
  for (const slice of slices) {
    if (slice.repoId !== repoId) continue;
    if (isPureRevisionWindow(slice.window)) {
      const start = slice.window.fromRevision ?? slice.firstRevision ?? 1;
      const end = slice.window.toRevision ?? slice.lastRevision;
      if (end !== null && end >= start) {
        revIntervals.push({ start, end });
      }
      continue;
    }
    // A time-window slice proves coverage for timestamps in [after, before] only when not clipped below completion.
    if (
      slice.window.fromRevision === null &&
      (slice.window.toRevision === null || slice.window.toRevision >= completionRevision)
    ) {
      const start = slice.window.after === null ? Number.NEGATIVE_INFINITY : Date.parse(slice.window.after);
      const end = slice.window.before === null ? Number.POSITIVE_INFINITY : Date.parse(slice.window.before);
      if (!Number.isNaN(start) && !Number.isNaN(end) && start <= end) {
        timeIntervals.push({ start, end });
      }
    }
  }
  return {
    revisions: mergeContiguousIntervals(revIntervals),
    timestamps: mergeContiguousIntervals(timeIntervals),
  };
}

function intervalSetCoversSpan(intervals: readonly ClosedNumericInterval[], start: number, end: number): boolean {
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) return false;
  return intervals.some((interval) => interval.start <= start && interval.end >= end);
}

function timestampStrictlyInsideIntervals(timestampText: string, intervals: readonly ClosedNumericInterval[]): boolean {
  const target = Date.parse(timestampText);
  return !Number.isNaN(target) && intervals.some((interval) => target > interval.start && target < interval.end);
}
