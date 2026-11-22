import type { PersistedCanonicalEventV1 } from "../domain/doc-sync-types.ts";
import { isNonEmptyString, isRecord } from "../domain/contract-validation.ts";
import {
  createBytesDigestAccumulator,
  createTextDigestAccumulator,
  isAuditHashAlgorithm,
  stableStringify,
  type AuditDigest,
  type AuditHashAlgorithm,
} from "./stable-hash.ts";
import {
  AUDIT_EXPORT_ENTRY_SCHEMA,
  AUDIT_EXPORT_MANIFEST_SCHEMA,
  AuditChainGapError,
  auditGenesisChainHash,
  computeAuditChainHash,
  computeAuditManifestRootHash,
  computeCanonicalEventDigest,
  extractEventExecutorId,
  extractEventPersonId,
  formatAuditEntriesFileName,
  isAuditDigest,
  isPureRevisionWindow,
  type AuditAttributionCompleteness,
  type AuditCertificateChainCollector,
  type AuditExportEntryV1,
  type AuditExportManifestV1,
  type AuditExportWindowV1,
  type AuditPersonAttributionSummaryV1,
  type AuditSliceVerifyResult,
  type AuditVerifyFailure,
} from "./audit-types.ts";

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
      const entriesDigest = entriesHasher.digest();
      const entriesFile = input.entriesFile ?? formatAuditEntriesFileName(entriesDigest);
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
        entriesDigest,
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
        input.certificateCollector?.observeSlice({
          repoId: manifest.repoId,
          window: manifest.window,
          firstRevision,
          lastRevision,
          eventCount,
        });
        if (!complete) {
          const first = firstUnattributed!;
          return {
            ok: false,
            diagnostic: true,
            verificationStatus: "diagnostic_incomplete_attribution",
            selfConsistent: false,
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
          verificationMode: anchorPinned ? "strict" : "self-consistent-only",
          selfConsistent: true,
          strictVerified: anchorPinned,
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
  const prevPure = isPureRevisionWindow(previous.window);
  const currPure = isPureRevisionWindow(current.window);
  if (prevPure && currPure) {
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
        message: `Pure revision slice firstRevision ${current.firstRevision} is not strictly after previous slice lastRevision ${previous.lastRevision}.`,
      };
    }
    if (
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
    return null;
  }
  if (!prevPure && !currPure) {
    // Time/date slices are ordered by declared UTC window, not workspaceRevision, because
    // historical migration imports can assign higher revisions to earlier occurredAt dates.
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
    if (previous.window.before === null || current.window.after === null) {
      return {
        ok: false,
        code: "audit_slice_sequence_invalid",
        field: previous.window.before === null ? "window.before" : "window.after",
        expected: "bounded non-overlapping time window",
        actual: "open-ended",
        message: "Chained time-window slices must declare finite non-overlapping before/after endpoints.",
      };
    }
    // Windows are inclusive [after, before], so equal boundary endpoints overlap and must be rejected.
    if (Date.parse(current.window.after) <= Date.parse(previous.window.before)) {
      return {
        ok: false,
        code: "audit_slice_sequence_invalid",
        field: "window.after",
        expected: `> ${previous.window.before}`,
        actual: current.window.after,
        message: `Time-window slice starting at ${current.window.after} overlaps or equals previous slice end ${previous.window.before}.`,
      };
    }
    return null;
  }
  // Mixed revision-window and time-window chaining requires strictly advancing observed revisions.
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
  const { fromRevision, toRevision, utcDate, after, before, cursorTruncated } = value;
  if (cursorTruncated !== undefined && cursorTruncated !== true) {
    return {
      ok: false,
      code: "audit_manifest_invalid",
      field: "window.cursorTruncated",
      message: "Manifest window cursorTruncated must be omitted or true.",
    };
  }
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
  return {
    ok: true,
    window: {
      fromRevision,
      toRevision,
      utcDate,
      after,
      before,
      ...(cursorTruncated === true ? { cursorTruncated: true as const } : {}),
    },
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
