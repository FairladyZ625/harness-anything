import { consumeKnownError } from "../error-consumption.ts";
import { parseCanonicalEvent, serializePersistedCanonicalEvent } from "../domain/doc-sync-canonical-events.ts";
import type { LedgerCutIdentity } from "../domain/write-chain.contract.ts";
import { sha256Bytes, sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";
import { contentClaims } from "./task-event-store-claims-layout.ts";
import { canonicalLedgerCut } from "./task-event-store-contract.ts";
import { planLegacyGenerationSnapshotConversion } from "./legacy-generation-conversion.ts";
import {
  openSqliteEventStore,
  sqliteLedgerPath,
  SQLITE_LEDGER_GENERATION,
  type SqliteCommandOutcome,
} from "./sqlite-event-store.ts";

export interface GitFollowerReadback {
  readonly commitSha: string;
  readonly cut: LedgerCutIdentity;
  readonly documents: readonly {
    readonly path: string;
    readonly mode: string;
    readonly sha256: string;
    readonly size: number;
  }[];
  readonly retirements: readonly string[];
}

export interface SqliteLedgerReconciliation {
  readonly schema: "sqlite-ledger-reconciliation/v2";
  readonly repoId: string;
  readonly generation: number;
  readonly sourceDigest: string;
  readonly matches: boolean;
  readonly metadataMatches: boolean;
  readonly rowDigestMatches: boolean;
  readonly outcomeMatches: boolean;
  readonly objectMatches: boolean;
  readonly gitReadbackMatches: boolean;
  readonly expected: { readonly events: number; readonly outcomes: number; readonly objects: number };
  readonly actual: { readonly events: number; readonly outcomes: number; readonly objects: number };
  readonly differences: readonly string[];
}

/** Compares the accepted ledger to an immutable import source and independent Git read-back. */
export function reconcileSqliteEvents(input: {
  readonly repoId: string;
  readonly rootDir: string;
  readonly snapshotPath: string;
  readonly gitReadback: GitFollowerReadback;
  readonly databasePath?: string;
  readonly generation?: number;
}): SqliteLedgerReconciliation {
  const generation = input.generation ?? SQLITE_LEDGER_GENERATION,
    databasePath = input.databasePath ?? sqliteLedgerPath(input.rootDir, generation),
    { snapshot, plan } = planLegacyGenerationSnapshotConversion({
      rootDir: input.rootDir,
      snapshotPath: input.snapshotPath,
    }),
    store = openSqliteEventStore({ repoId: input.repoId, databasePath, generation, readOnly: true });
  try {
    const marker = readImportEvidence(`${databasePath}.import-source.json`),
      certificate = readImportEvidence(`${databasePath}.activation.json`),
      metadata = store.metadata(),
      rows = store.eventRows(),
      outcomes = store.outcomes(),
      parsedRows = rows.map((row) => {
        try {
          return parseCanonicalEvent(row.eventJson);
        } catch (error) {
          consumeKnownError(error);
          return null;
        }
      }),
      expectedRows = plan.events.map((event) => {
        const eventJson = serializePersistedCanonicalEvent(event);
        return {
          revision: event.workspaceRevision,
          opId: event.opId,
          eventJson,
          occurredAt: event.occurredAt,
          digest: `sha256:${sha256Text(eventJson)}`,
        };
      }),
      expectedOutcomes = expectedRows.map((row) => ({
        opId: row.opId,
        status: "accepted_durable",
        firstRevision: row.revision,
        lastRevision: row.revision,
        intentDigest: row.digest,
        rejectionCode: null,
      })),
      actualOutcomes = outcomes.map((outcome) => ({
        opId: outcome.opId,
        status: outcome.status,
        firstRevision: outcome.firstRevision,
        lastRevision: outcome.lastRevision,
        intentDigest: outcome.intentDigest,
        rejectionCode: outcome.rejectionCode,
      })),
      allClaims = parsedRows.flatMap((event) => (event === null ? [] : contentClaims(event))),
      expectedObjects = [...new Set(allClaims.map((claim) => claim.sha256))].sort(),
      actualObjects = [...store.contentObjectDigests()].sort(),
      metadataMatches =
        snapshot.repoId === input.repoId &&
        snapshot.generation === 0 &&
        marker?.schema === "generation-import-source/v1" &&
        marker.sourceDigest === snapshot.sourceDigest &&
        certificate?.schema === "generation-activation/v1" &&
        certificate.repoId === input.repoId &&
        certificate.sourceDigest === snapshot.sourceDigest &&
        certificate.importedPrefixRevision === expectedRows.length &&
        metadata.repoId === input.repoId &&
        metadata.generation === generation &&
        metadata.revision === rows.length,
      rowDigestMatches =
        rows.length >= expectedRows.length &&
        rows.every((row, index) => {
          const event = parsedRows[index];
          return (
            event !== null &&
            event !== undefined &&
            row.revision === index + 1 &&
            event.workspaceRevision === row.revision &&
            event.opId === row.opId &&
            event.occurredAt === row.occurredAt &&
            Number.isFinite(Date.parse(row.recordedAt)) &&
            row.digest === `sha256:${sha256Text(row.eventJson)}`
          );
        }),
      outcomeMatches =
        stableStringify(actualOutcomes.slice(0, expectedOutcomes.length)) === stableStringify(expectedOutcomes) &&
        outcomes.every((outcome) =>
          outcome.status === "rejected"
            ? outcome.firstRevision === null && outcome.lastRevision === null && outcome.memberOpIds.length === 0
            : outcome.firstRevision === null || outcome.lastRevision === null
              ? outcome.firstRevision === null && outcome.lastRevision === null && outcome.memberOpIds.length === 0
              : outcome.firstRevision >= 1 &&
                outcome.lastRevision <= rows.length &&
                outcome.memberOpIds.length === outcome.lastRevision - outcome.firstRevision + 1,
        ) &&
        completeCommandIntervals(outcomes, rows.length),
      objectMatches =
        parsedRows.every((event) => event !== null) &&
        allClaims.every((claim) => {
          const bytes = store.readContentObject(claim.sha256);
          return bytes !== null && bytes.byteLength === claim.size && sha256Bytes(bytes) === claim.sha256;
        }),
      current = rows.at(-1),
      expectedCut = canonicalLedgerCut(
        input.repoId,
        current
          ? {
              revision: current.revision,
              opId: current.opId,
              eventDigest: `sha256:${sha256Text(current.eventJson)}`,
            }
          : null,
      ),
      gitReadbackMatches =
        input.gitReadback.commitSha.length > 0 &&
        stableStringify(input.gitReadback.cut) === stableStringify(expectedCut),
      differences = [
        metadataMatches ? null : "ledger metadata differs from immutable source",
        rowDigestMatches ? null : "event rows or stored row digests differ from immutable source",
        outcomeMatches ? null : "command outcomes differ from immutable source import outcomes",
        objectMatches ? null : "content object closure differs from immutable source claims",
        gitReadbackMatches ? null : "Git follower read-back differs from immutable source",
      ].filter((difference): difference is string => difference !== null);
    return {
      schema: "sqlite-ledger-reconciliation/v2",
      repoId: input.repoId,
      generation,
      sourceDigest: snapshot.sourceDigest,
      matches: differences.length === 0,
      metadataMatches,
      rowDigestMatches,
      outcomeMatches,
      objectMatches,
      gitReadbackMatches,
      expected: { events: expectedRows.length, outcomes: expectedOutcomes.length, objects: expectedObjects.length },
      actual: { events: rows.length, outcomes: outcomes.length, objects: actualObjects.length },
      differences,
    };
  } finally {
    store.close();
  }
}

function readImportEvidence(inputPath: string): Record<string, unknown> | null {
  if (!localRuntimeStateFileSystem.exists(inputPath)) return null;
  const value: unknown = JSON.parse(localRuntimeStateFileSystem.readText(inputPath));
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function completeCommandIntervals(outcomes: readonly SqliteCommandOutcome[], revisions: number): boolean {
  const intervals = outcomes
    .filter(
      (outcome) =>
        outcome.status === "accepted_durable" && outcome.firstRevision !== null && outcome.lastRevision !== null,
    )
    .sort((left, right) => left.firstRevision! - right.firstRevision!);
  let next = 1;
  for (const interval of intervals) {
    if (interval.firstRevision !== next || interval.lastRevision! < interval.firstRevision) return false;
    next = interval.lastRevision! + 1;
  }
  return next === revisions + 1;
}
