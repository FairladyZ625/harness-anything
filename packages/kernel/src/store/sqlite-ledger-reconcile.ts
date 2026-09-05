import { DatabaseSync } from "node:sqlite";
import { serializePersistedCanonicalEvent, type CanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import {
  SQLITE_LEDGER_GENERATION,
  sqliteLedgerPath,
  type SqliteLedgerReconciliation,
  type SqliteLedgerRevisionDifference,
} from "./sqlite-event-store.ts";
import { TaskEventStoreError } from "./task-event-store-types.ts";

// Read-only reconciliation of the generation-N SQLite ledger against the canonical stream.
// It opens the database read-only and never writes; that is why it lives outside the store module.
export function reconcileSqliteEvents(input: {
  readonly repoId: string;
  readonly events: readonly CanonicalEventV1[];
  readonly rootInput?: HarnessLayoutInput;
  readonly databasePath?: string;
  readonly generation?: number;
}): SqliteLedgerReconciliation {
  const generation = input.generation ?? SQLITE_LEDGER_GENERATION,
    databasePath = input.databasePath ?? sqliteLedgerPath(input.rootInput ?? process.cwd(), generation),
    db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const meta = db.prepare("SELECT repo_id, generation, revision FROM ledger_meta WHERE singleton=1").get();
    if (!meta || meta.repo_id !== input.repoId || Number(meta.generation) !== generation)
      throw new TaskEventStoreError(
        "repo_mismatch",
        "SQLite ledger metadata belongs to another repository or generation",
      );
    const rows = db.prepare("SELECT revision, op_id, event_json, digest FROM event ORDER BY revision").all(),
      sqliteByRevision = new Map(rows.map((row) => [Number(row.revision), row])),
      canonicalByRevision = new Map(input.events.map((event) => [event.workspaceRevision, event])),
      revisions = [...new Set([...canonicalByRevision.keys(), ...sqliteByRevision.keys()])].sort(
        (left, right) => left - right,
      ),
      revisionDifferences: SqliteLedgerRevisionDifference[] = [];
    for (const revision of revisions) {
      const canonical = canonicalByRevision.get(revision),
        sqlite = sqliteByRevision.get(revision),
        canonicalDigest = canonical
          ? (`sha256:${sha256Text(serializePersistedCanonicalEvent(canonical))}` as const)
          : null,
        sqliteDigest = sqlite ? (`sha256:${sha256Text(String(sqlite.event_json))}` as const) : null,
        sqliteStoredDigest = sqlite ? String(sqlite.digest) : null;
      if (
        !canonical ||
        !sqlite ||
        canonical.opId !== sqlite.op_id ||
        canonicalDigest !== sqliteDigest ||
        sqliteDigest !== sqliteStoredDigest
      )
        revisionDifferences.push({
          revision,
          kind: !canonical ? "unexpected_in_sqlite" : !sqlite ? "missing_in_sqlite" : "event_mismatch",
          canonicalOpId: canonical?.opId ?? null,
          sqliteOpId: sqlite ? String(sqlite.op_id) : null,
          canonicalDigest,
          sqliteDigest,
          sqliteStoredDigest,
        });
    }
    const canonicalOpIds = new Set(input.events.map(({ opId }) => opId)),
      sqliteOpIds = new Set(rows.map((row) => String(row.op_id))),
      missingInSqlite = [...canonicalOpIds].filter((opId) => !sqliteOpIds.has(opId)).sort(),
      unexpectedInSqlite = [...sqliteOpIds].filter((opId) => !canonicalOpIds.has(opId)).sort(),
      canonical = {
        eventCount: input.events.length,
        maxRevision: input.events.reduce((maximum, event) => Math.max(maximum, event.workspaceRevision), 0),
        distinctOpIds: canonicalOpIds.size,
      },
      sqlite = {
        eventCount: rows.length,
        maxRevision: rows.reduce((maximum, row) => Math.max(maximum, Number(row.revision)), 0),
        distinctOpIds: sqliteOpIds.size,
      },
      matches =
        canonical.eventCount === sqlite.eventCount &&
        canonical.maxRevision === sqlite.maxRevision &&
        canonical.distinctOpIds === sqlite.distinctOpIds &&
        revisionDifferences.length === 0 &&
        missingInSqlite.length === 0 &&
        unexpectedInSqlite.length === 0;
    return {
      schema: "sqlite-ledger-reconciliation/v1",
      repoId: input.repoId,
      generation,
      matches,
      canonical,
      sqlite,
      firstDivergentRevision: revisionDifferences[0]?.revision ?? null,
      revisionDifferences,
      opIdDifferences: { missingInSqlite, unexpectedInSqlite },
    };
  } finally {
    db.close();
  }
}
