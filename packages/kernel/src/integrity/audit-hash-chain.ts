import { serializeCanonicalEventUnchecked } from "../domain/doc-sync-canonical-events.ts";
import type { PersistedCanonicalEventV1 } from "../domain/doc-sync-types.ts";
import { submissionDigest, type ExecutionV1, type SubmissionV1 } from "../domain/execution.ts";
import { reviewDigest, type ReviewConsentV1, type ReviewV1 } from "../domain/review.ts";
import type { TaskCompletedEvent } from "../domain/task-lifecycle-event.ts";
import type { TaskV2 } from "../domain/task.ts";
import type { ActorIdentity } from "../domain/write-chain.contract.ts";
import { isNonEmptyString, isRecord } from "../domain/contract-validation.ts";
import {
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
  readonly distinctPersonIds: readonly string[];
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
  readonly personAttribution: AuditPersonAttributionSummaryV1;
  readonly rootHash: AuditDigest;
}

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
  readonly executionId: string;
  readonly iteration: number;
  readonly commitSha: string | null;
  readonly submissionDigest: `sha256:${string}`;
  readonly submission: SubmissionV1;
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
  | "audit_person_attribution_missing"
  | "audit_manifest_invalid"
  | "audit_manifest_entries_digest_mismatch"
  | "audit_manifest_count_mismatch"
  | "audit_manifest_tip_mismatch"
  | "audit_manifest_attribution_mismatch"
  | "audit_manifest_root_hash_mismatch"
  | "audit_manifest_chain_link_mismatch"
  | "audit_certificate_invalid"
  | "audit_certificate_submission_digest_mismatch"
  | "audit_certificate_consent_mismatch"
  | "audit_certificate_hash_mismatch"
  | "audit_certificate_event_mismatch";

export interface AuditVerifyFailure {
  readonly ok: false;
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
  readonly repoId: string;
  readonly algorithm: AuditHashAlgorithm;
  readonly eventCount: number;
  readonly firstRevision: number | null;
  readonly lastRevision: number | null;
  readonly prevRootHash: AuditDigest;
  readonly rootHash: AuditDigest;
  readonly tipChainHash: AuditDigest;
  readonly personAttribution: AuditPersonAttributionSummaryV1;
}

export type AuditSliceVerifyResult = AuditSliceVerifySuccess | AuditVerifyFailure;

export interface AuditCertificateVerifySuccess {
  readonly ok: true;
  readonly repoId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly algorithm: AuditHashAlgorithm;
  readonly commitSha: string | null;
  readonly submissionDigest: `sha256:${string}`;
  readonly reviewCount: number;
  readonly consentId: string | null;
  readonly completionOpId: string;
  readonly completionRevision: number;
  readonly certificateHash: AuditDigest;
}

export type AuditCertificateVerifyResult = AuditCertificateVerifySuccess | AuditVerifyFailure;

export function createAuditVerifyFailure(
  code: AuditVerifyErrorCode,
  message: string,
  detail?: Omit<AuditVerifyFailure, "ok" | "code" | "message">,
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
  const entriesHasher = createTextDigestAccumulator(input.algorithm);
  const distinctPersonIds = new Set<string>();
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
      if (lastRevision !== null && event.workspaceRevision <= lastRevision) {
        throw new Error(
          `Audit export requires strictly increasing workspaceRevision (${event.workspaceRevision} <= ${lastRevision})`,
        );
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
        distinctPersonIds.add(personId);
      } else {
        unattributedEvents += 1;
      }
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
      entriesHasher.feed(line);
      return { entry, line };
    },
    finalize() {
      const personAttribution: AuditPersonAttributionSummaryV1 = {
        totalEvents: eventCount,
        attributedEvents,
        unattributedEvents,
        traceableRatio: eventCount === 0 ? 1 : attributedEvents / eventCount,
        distinctPersonIds: [...distinctPersonIds].sort(),
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
  readonly execution: ExecutionV1;
  readonly reviews: readonly ReviewV1[];
  readonly reviewConsent: ReviewConsentV1 | null;
  readonly completionEvent: TaskCompletedEvent;
}): DeliveryCertificateV1 {
  const algorithm = input.algorithm ?? "sha256";
  if (input.task.status !== "done") {
    throw new Error(`Delivery certificate requires a done task; got status ${input.task.status}`);
  }
  if (input.execution.submission === null) {
    throw new Error(
      `Delivery certificate requires an execution with a frozen submission (${input.execution.executionId})`,
    );
  }
  if (input.completionEvent.type !== "task_completed" || input.completionEvent.taskId !== input.task.taskId) {
    throw new Error(`Completion event does not match task ${input.task.taskId}`);
  }
  const sortedReviews = [...input.reviews].sort((left, right) =>
    left.reviewedAt === right.reviewedAt
      ? left.reviewId.localeCompare(right.reviewId)
      : left.reviewedAt.localeCompare(right.reviewedAt),
  );
  const body: Omit<DeliveryCertificateV1, "certificateHash"> = {
    schema: DELIVERY_CERTIFICATE_SCHEMA,
    algorithm,
    repoId: input.repoId,
    taskId: input.task.taskId,
    title: input.task.title,
    status: "done",
    executionId: input.execution.executionId,
    iteration: input.execution.iteration,
    commitSha: input.execution.submission.commitSha,
    submissionDigest: submissionDigest(input.execution.submission),
    submission: input.execution.submission,
    reviews: sortedReviews,
    reviewConsent: input.reviewConsent,
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
  readonly verifyLine: (rawLine: string, lineNumber: number) => AuditVerifyFailure | null;
  readonly finalize: () => AuditSliceVerifyResult;
  readonly observedEvents: ReadonlyMap<
    string,
    { readonly workspaceRevision: number; readonly eventDigest: AuditDigest }
  >;
}

export function createAuditSliceVerifier(input: {
  readonly manifest: unknown;
  readonly expectedAlgorithm?: AuditHashAlgorithm;
  readonly expectedPrevRootHash?: AuditDigest;
  readonly requirePersonAttribution?: boolean;
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
  const entriesHasher = createTextDigestAccumulator(manifest.algorithm);
  const distinctPersonIds = new Set<string>();
  const observedEvents = new Map<string, { readonly workspaceRevision: number; readonly eventDigest: AuditDigest }>();
  let expectedPrevChainHash: AuditDigest = manifest.prevRootHash;
  let firstRevision: number | null = null;
  let lastRevision: number | null = null;
  let eventCount = 0;
  let attributedEvents = 0;
  let unattributedEvents = 0;

  return {
    ok: true,
    verifier: {
      observedEvents,
      verifyLine(rawLine: string, lineNumber: number): AuditVerifyFailure | null {
        entriesHasher.feed(`${rawLine}\n`);
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
          distinctPersonIds.add(actualPersonId);
        } else {
          unattributedEvents += 1;
        }
        if (firstRevision === null) firstRevision = entry.workspaceRevision;
        lastRevision = entry.workspaceRevision;
        eventCount += 1;
        expectedPrevChainHash = actualChainHash;
        observedEvents.set(entry.opId, { workspaceRevision: entry.workspaceRevision, eventDigest: actualEventDigest });
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
            field: "eventCount",
            expected: `${manifest.eventCount} (${String(manifest.firstRevision)}..${String(manifest.lastRevision)})`,
            actual: `${eventCount} (${String(firstRevision)}..${String(lastRevision)})`,
            message: "Audit entries count or revision bounds do not match manifest.",
          };
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
            message: "Audit JSONL file digest does not match manifest entriesDigest.",
          };
        }
        const personAttribution: AuditPersonAttributionSummaryV1 = {
          totalEvents: eventCount,
          attributedEvents,
          unattributedEvents,
          traceableRatio: eventCount === 0 ? 1 : attributedEvents / eventCount,
          distinctPersonIds: [...distinctPersonIds].sort(),
        };
        if (stableStringify(personAttribution) !== stableStringify(manifest.personAttribution)) {
          return {
            ok: false,
            code: "audit_manifest_attribution_mismatch",
            field: "personAttribution",
            expected: stableStringify(personAttribution),
            actual: stableStringify(manifest.personAttribution),
            message: "Manifest personAttribution statistics do not match verified entries.",
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
        return {
          ok: true,
          repoId: manifest.repoId,
          algorithm: manifest.algorithm,
          eventCount,
          firstRevision,
          lastRevision,
          prevRootHash: manifest.prevRootHash,
          rootHash,
          tipChainHash: expectedPrevChainHash,
          personAttribution,
        };
      },
    },
  };
}

export function verifyAuditSliceContent(input: {
  readonly manifest: unknown;
  readonly entriesContent: string;
  readonly expectedAlgorithm?: AuditHashAlgorithm;
  readonly expectedPrevRootHash?: AuditDigest;
  readonly requirePersonAttribution?: boolean;
}): AuditSliceVerifyResult {
  const created = createAuditSliceVerifier({
    manifest: input.manifest,
    ...(input.expectedAlgorithm === undefined ? {} : { expectedAlgorithm: input.expectedAlgorithm }),
    ...(input.expectedPrevRootHash === undefined ? {} : { expectedPrevRootHash: input.expectedPrevRootHash }),
    ...(input.requirePersonAttribution === undefined
      ? {}
      : { requirePersonAttribution: input.requirePersonAttribution }),
  });
  if (!created.ok) return created;
  if (input.entriesContent.length > 0) {
    const normalized = input.entriesContent.endsWith("\n") ? input.entriesContent.slice(0, -1) : input.entriesContent;
    const lines = normalized.length === 0 ? [] : normalized.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const error = created.verifier.verifyLine(lines[index]!, index + 1);
      if (error !== null) return error;
    }
  }
  return created.verifier.finalize();
}

export function verifyDeliveryCertificate(
  certificate: unknown,
  options?: {
    readonly expectedAlgorithm?: AuditHashAlgorithm;
    readonly verifiedEvents?: ReadonlyMap<
      string,
      { readonly workspaceRevision: number; readonly eventDigest: AuditDigest }
    >;
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
  if (
    certificate.status !== "done" ||
    !isNonEmptyString(certificate.repoId) ||
    !isNonEmptyString(certificate.taskId) ||
    !isNonEmptyString(certificate.title) ||
    !isNonEmptyString(certificate.executionId) ||
    !Number.isSafeInteger(certificate.iteration) ||
    Number(certificate.iteration) < 0 ||
    (certificate.commitSha !== null && typeof certificate.commitSha !== "string") ||
    typeof certificate.submissionDigest !== "string" ||
    !isRecord(certificate.submission) ||
    !Array.isArray(certificate.reviews) ||
    (certificate.reviewConsent !== null && !isRecord(certificate.reviewConsent)) ||
    !isRecord(certificate.completion) ||
    !isNonEmptyString(certificate.completion.opId) ||
    !isNonEmptyString(certificate.completion.eventId) ||
    !Number.isSafeInteger(certificate.completion.workspaceRevision) ||
    Number(certificate.completion.workspaceRevision) < 1 ||
    !isNonEmptyString(certificate.completion.occurredAt) ||
    !isAuditDigest(certificate.completion.eventDigest, algorithm) ||
    !isAuditDigest(certificate.certificateHash, algorithm)
  ) {
    return {
      ok: false,
      code: "audit_certificate_invalid",
      message: "Delivery certificate is missing required done-task delivery fields.",
    };
  }
  const cert = certificate as unknown as DeliveryCertificateV1;
  const actualSubmissionDigest = submissionDigest(cert.submission);
  if (actualSubmissionDigest !== cert.submissionDigest || cert.commitSha !== cert.submission.commitSha) {
    return {
      ok: false,
      code: "audit_certificate_submission_digest_mismatch",
      field: "submissionDigest",
      expected: actualSubmissionDigest,
      actual: cert.submissionDigest,
      message: "Delivery certificate submissionDigest or commitSha does not match its frozen submission.",
    };
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
  if (options?.verifiedEvents !== undefined) {
    const observed = options.verifiedEvents.get(cert.completion.opId);
    if (
      observed === undefined ||
      observed.workspaceRevision !== cert.completion.workspaceRevision ||
      observed.eventDigest !== cert.completion.eventDigest
    ) {
      return {
        ok: false,
        code: "audit_certificate_event_mismatch",
        workspaceRevision: cert.completion.workspaceRevision,
        opId: cert.completion.opId,
        field: "completion.eventDigest",
        expected: cert.completion.eventDigest,
        actual: observed?.eventDigest ?? "missing",
        message: `Completion event ${cert.completion.opId} (rev ${cert.completion.workspaceRevision}) was not matched in the verified audit chain.`,
      };
    }
  }
  return {
    ok: true,
    repoId: cert.repoId,
    taskId: cert.taskId,
    executionId: cert.executionId,
    algorithm,
    commitSha: cert.commitSha,
    submissionDigest: cert.submissionDigest,
    reviewCount: cert.reviews.length,
    consentId: cert.reviewConsent?.consentId ?? null,
    completionOpId: cert.completion.opId,
    completionRevision: cert.completion.workspaceRevision,
    certificateHash,
  };
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
  if (
    !isNonEmptyString(value.repoId) ||
    !isRecord(value.window) ||
    !isAuditDigest(value.prevRootHash, algorithm) ||
    !Number.isSafeInteger(value.eventCount) ||
    Number(value.eventCount) < 0 ||
    !isNonEmptyString(value.entriesFile) ||
    !isAuditDigest(value.entriesDigest, algorithm) ||
    !isAuditDigest(value.tipChainHash, algorithm) ||
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
  return { ok: true, manifest: value as unknown as AuditExportManifestV1 };
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
