import { serializePersistedCanonicalEvent } from "../domain/doc-sync-canonical-events.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { contentClaims } from "./task-event-store-claims-layout.ts";
import { planLegacyGenerationSnapshotConversion } from "./legacy-generation-conversion.ts";
import { openSqliteEventStore, sqliteLedgerPath, SQLITE_LEDGER_GENERATION } from "./sqlite-event-store.ts";

export interface GitFollowerReadback {
  readonly status: "pending" | "verified";
  readonly revision: number;
  readonly eventDigests: readonly string[];
  readonly objectDigests: readonly string[];
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
    store = openSqliteEventStore({ repoId: input.repoId, databasePath, generation });
  try {
    const metadata = store.metadata(),
      rows = store.eventRows(),
      outcomes = store.outcomes(),
      expectedRows = plan.events.map((event) => {
        const eventJson = serializePersistedCanonicalEvent(event);
        return {
          revision: event.workspaceRevision,
          opId: event.opId,
          eventJson,
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
      expectedObjects = [
        ...new Set(plan.events.flatMap((event) => contentClaims(event).map((claim) => claim.sha256))),
      ].sort(),
      actualObjects = [...store.contentObjectDigests()].sort(),
      metadataMatches =
        metadata.repoId === input.repoId && metadata.generation === generation && metadata.revision === rows.length,
      rowDigestMatches =
        rows.length >= expectedRows.length &&
        stableStringify(rows.slice(0, expectedRows.length)) === stableStringify(expectedRows) &&
        rows.every((row) => row.digest === `sha256:${sha256Text(row.eventJson)}`),
      outcomeMatches =
        stableStringify(actualOutcomes.slice(0, expectedOutcomes.length)) === stableStringify(expectedOutcomes) &&
        rows.every((row) => {
          const outcome = store.readCommandOutcome(row.opId);
          return (
            outcome?.status === "accepted_durable" &&
            outcome.firstRevision !== null &&
            outcome.lastRevision !== null &&
            outcome.firstRevision <= row.revision &&
            outcome.lastRevision >= row.revision
          );
        }),
      objectMatches = expectedObjects.every((sha256) => actualObjects.includes(sha256)),
      gitReadbackMatches =
        input.gitReadback.status === "verified" &&
        input.gitReadback.revision === rows.length &&
        stableStringify([...input.gitReadback.eventDigests]) === stableStringify(rows.map((row) => row.digest)) &&
        stableStringify([...input.gitReadback.objectDigests].sort()) === stableStringify(actualObjects),
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
