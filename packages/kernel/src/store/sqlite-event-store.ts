import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  serializeCanonicalEventUnchecked,
  serializePersistedCanonicalEvent,
  type CanonicalEventV1,
} from "../domain/doc-sync.contract.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import { localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";
import { replayClaim, replayRelease, replayRenew } from "../projection/rebuildable-task-projection-runtime.ts";
import { TaskEventStoreError } from "./task-event-store-types.ts";
import type { CanonicalContentBlob } from "./task-event-store-types.ts";
import {
  listContentObjectDigests,
  prepareContentObjects,
  readContentObject,
} from "./task-event-store-claims-layout.ts";
import { consumeKnownError } from "../error-consumption.ts";

export const SQLITE_LEDGER_GENERATION = 1;

export interface SqliteWriterFence {
  readonly repoId: string;
  readonly holder: string;
  readonly epoch: number;
}

export interface SqliteLedgerMetadata {
  readonly repoId: string;
  readonly generation: number;
  readonly revision: number;
}

export interface SqliteEventRow {
  readonly revision: number;
  readonly opId: string;
  readonly eventJson: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly digest: `sha256:${string}`;
}

/** The identity SQLite already durably stores for an event, without re-reading or re-serializing its body. */
export interface SqliteEventIdentity {
  readonly revision: number;
  readonly opId: string;
  readonly eventDigest: `sha256:${string}`;
}

export interface SqliteCommandIntent {
  readonly opId: string;
  readonly intentDigest: `sha256:${string}`;
  readonly summary: string;
}

export interface SqliteCommandOutcome {
  readonly opId: string;
  readonly status: "accepted_durable" | "rejected";
  readonly firstRevision: number | null;
  readonly lastRevision: number | null;
  readonly intentDigest: `sha256:${string}`;
  readonly summary: string;
  readonly rejectionCode: string | null;
  readonly recordedAt: string;
  readonly memberOpIds: readonly string[];
}

export type SqliteLedgerRevisionDifference = {
  readonly revision: number;
  readonly kind: "missing_in_sqlite" | "unexpected_in_sqlite" | "event_mismatch";
  readonly canonicalOpId: string | null;
  readonly sqliteOpId: string | null;
  readonly canonicalDigest: `sha256:${string}` | null;
  readonly sqliteDigest: `sha256:${string}` | null;
  readonly sqliteStoredDigest: string | null;
};

export interface SqliteLedgerReconciliation {
  readonly schema: "sqlite-ledger-reconciliation/v1";
  readonly repoId: string;
  readonly generation: number;
  readonly matches: boolean;
  readonly canonical: {
    readonly eventCount: number;
    readonly maxRevision: number;
    readonly distinctOpIds: number;
  };
  readonly sqlite: {
    readonly eventCount: number;
    readonly maxRevision: number;
    readonly distinctOpIds: number;
  };
  readonly firstDivergentRevision: number | null;
  readonly revisionDifferences: readonly SqliteLedgerRevisionDifference[];
  readonly opIdDifferences: {
    readonly missingInSqlite: readonly string[];
    readonly unexpectedInSqlite: readonly string[];
  };
}

export interface SqliteEventStore {
  readonly databasePath: string;
  readonly sqliteVersion: string;
  readonly claimWriter: (fence: SqliteWriterFence) => void;
  /** Hand the ledger back when an offline holder stops writing, so a live writer is not fenced out. */
  readonly releaseWriter: (fence: SqliteWriterFence) => void;
  readonly writerFence: () => SqliteWriterFence | null;
  readonly appendCommand: (input: {
    readonly fence: SqliteWriterFence;
    readonly intent: SqliteCommandIntent;
    readonly events: readonly CanonicalEventV1[];
    readonly blobs?: readonly CanonicalContentBlob[];
    readonly rejectionCode?: string;
    readonly beforeOutcome?: () => void;
    readonly historicalRecord?: {
      readonly recordedAt: string;
      readonly eventRecordedAt: readonly string[];
    };
  }) => SqliteCommandOutcome;
  /** Internal admission seam: the caller has validated the canonical bundle before invoking this. */
  readonly appendValidatedBundle: (input: {
    readonly intent?: (eventBytes: readonly string[]) => SqliteCommandIntent;
    readonly fence: SqliteWriterFence;
    readonly events: readonly CanonicalEventV1[];
    readonly blobs: readonly CanonicalContentBlob[];
    readonly beforeOutcome?: () => void;
  }) => SqliteCommandOutcome;
  readonly outcome: (opId: string) => SqliteCommandOutcome | null;
  readonly readCommandOutcome: (opId: string) => SqliteCommandOutcome | null;
  readonly outcomes: () => readonly SqliteCommandOutcome[];
  readonly metadata: () => SqliteLedgerMetadata;
  readonly eventRows: () => readonly SqliteEventRow[];
  readonly readContentObject: (sha256: string) => Uint8Array | null;
  readonly contentObjectDigests: () => readonly string[];
  readonly revision: () => number;
  readonly events: () => readonly CanonicalEventV1[];
  readonly event: (opId: string) => CanonicalEventV1 | null;
  readonly eventAtRevision: (revision: number) => CanonicalEventV1 | null;
  readonly eventIdentity: (opId: string) => SqliteEventIdentity | null;
  readonly eventIdentityAtRevision: (revision: number) => SqliteEventIdentity | null;
  readonly eventsAfter: (revision: number, limit?: number) => readonly CanonicalEventV1[];
  readonly close: () => void;
}

export function sqliteLedgerPath(input: HarnessLayoutInput, generation = SQLITE_LEDGER_GENERATION): string {
  return path.join(resolveHarnessLayout(input).localRoot, "store", "generations", String(generation), "ledger.sqlite");
}

export interface GenerationTwoActivationV2 {
  readonly schema: "generation-activation/v2";
  readonly repoId: string;
  readonly sourceDigest: string;
  readonly importedPrefixRevision: number;
  readonly generation: 2;
}

export function generationTwoActivationPath(input: HarnessLayoutInput): string {
  return `${sqliteLedgerPath(input, 2)}.activation.json`;
}

export function generationActivationCertificatePath(input: HarnessLayoutInput): string {
  return `${sqliteLedgerPath(input, 1)}.activation.json`;
}

export function preflightCanonicalGeneration(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly repoId: string;
}): void {
  const layout = resolveHarnessLayout(input.rootInput),
    databasePath = sqliteLedgerPath(input.rootInput, 1),
    certificatePath = generationActivationCertificatePath(layout.rootDir),
    markerPath = `${databasePath}.import-source.json`;
  if (
    !localRuntimeStateFileSystem.exists(databasePath) ||
    !localRuntimeStateFileSystem.exists(markerPath) ||
    !localRuntimeStateFileSystem.exists(certificatePath)
  )
    throw new TaskEventStoreError(
      "invalid_store",
      "canonical generation is not activated; run operator conversion before attaching this repository",
    );
  const marker = JSON.parse(localRuntimeStateFileSystem.readText(markerPath)),
    certificate = JSON.parse(localRuntimeStateFileSystem.readText(certificatePath));
  if (
    certificate.schema !== "generation-activation/v1" ||
    certificate.repoId !== input.repoId ||
    certificate.sourceDigest !== marker.sourceDigest ||
    !Number.isSafeInteger(certificate.importedPrefixRevision) ||
    certificate.importedPrefixRevision < 0
  )
    throw new TaskEventStoreError("invalid_store", "generation activation certificate differs");
  const store = openSqliteEventStore({ repoId: input.repoId, databasePath, generation: 1, readOnly: true });
  try {
    if (store.revision() < certificate.importedPrefixRevision)
      throw new TaskEventStoreError("invalid_store", "generation revision precedes its activation certificate");
  } finally {
    store.close();
  }
}

export function activateEmptyCanonicalGeneration(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly repoId: string;
}): void {
  const layout = resolveHarnessLayout(input.rootInput);
  if (preflightGenerationTwoActivation(input) !== null) return;
  const databasePath = sqliteLedgerPath(input.rootInput, 1),
    snapshotPath = path.join(layout.localRoot, "store", "imports", "generation-0.snapshot.json");
  if (localRuntimeStateFileSystem.exists(generationActivationCertificatePath(layout.rootDir))) {
    preflightCanonicalGeneration(input);
    return;
  }
  if (
    localRuntimeStateFileSystem.exists(path.join(layout.authoredRoot, "events")) ||
    localRuntimeStateFileSystem.exists(path.join(layout.authoredRoot, "objects"))
  )
    throw new TaskEventStoreError(
      "invalid_store",
      "canonical generation is not activated; run operator conversion before attaching this repository",
    );
  if (localRuntimeStateFileSystem.exists(databasePath) || localRuntimeStateFileSystem.exists(snapshotPath))
    throw new TaskEventStoreError(
      "invalid_store",
      "legacy generation exists without activation; run operator conversion before attaching this repository",
    );
  const generationTwoPath = sqliteLedgerPath(input.rootInput, 2),
    generationTwoCertificatePath = `${generationTwoPath}.activation.json`,
    generationTwo = openSqliteEventStore({
      repoId: input.repoId,
      databasePath: generationTwoPath,
      generation: 2,
    });
  generationTwo.close();
  const activation = {
    schema: "generation-activation/v2" as const,
    repoId: input.repoId,
    sourceDigest: sha256Text(stableStringify({ repoId: input.repoId, generation: 2, importedPrefixRevision: 0 })),
    importedPrefixRevision: 0,
    generation: 2 as const,
  };
  if (
    !localRuntimeStateFileSystem.createExclusiveText(generationTwoCertificatePath, `${JSON.stringify(activation)}\n`)
  ) {
    const existing = JSON.parse(localRuntimeStateFileSystem.readText(generationTwoCertificatePath));
    if (stableStringify(existing) !== stableStringify(activation))
      throw new TaskEventStoreError("invalid_store", "generation 2 activation certificate differs");
  }
}

/**
 * The one production generation selector. Writers, readers, offline commands and every restart
 * resolve the same answer from the same certificate. A certificate that is malformed or names
 * another repository fails the caller instead of silently falling back to generation 1, so a
 * damaged activation can never be mistaken for "not activated yet".
 */
export function resolveActiveGeneration(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly repoId?: string;
}): 1 | 2 {
  if (readGenerationTwoActivation(input) !== null) return 2;
  return hasLegacyGeneration(input.rootInput) ? 1 : 2;
}

function hasLegacyGeneration(input: HarnessLayoutInput): boolean {
  const layout = resolveHarnessLayout(input),
    generationOneLedger = sqliteLedgerPath(input, 1),
    generationOneCertificate = `${generationOneLedger}.activation.json`,
    generationOneMarker = `${generationOneLedger}.import-source.json`;
  return [
    generationOneLedger,
    generationOneCertificate,
    generationOneMarker,
    path.join(layout.localRoot, "store", "imports", "generation-0.snapshot.json"),
    path.join(layout.authoredRoot, "events"),
    path.join(layout.authoredRoot, "objects"),
  ].some((candidate) => localRuntimeStateFileSystem.exists(candidate));
}

export function readGenerationTwoActivation(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly repoId?: string;
}): GenerationTwoActivationV2 | null {
  const certificatePath = generationTwoActivationPath(input.rootInput);
  if (!localRuntimeStateFileSystem.exists(certificatePath)) return null;
  const certificate = JSON.parse(localRuntimeStateFileSystem.readText(certificatePath)) as GenerationTwoActivationV2;
  if (
    certificate.schema !== "generation-activation/v2" ||
    certificate.generation !== 2 ||
    typeof certificate.repoId !== "string" ||
    typeof certificate.sourceDigest !== "string" ||
    !Number.isSafeInteger(certificate.importedPrefixRevision) ||
    certificate.importedPrefixRevision < 0 ||
    (input.repoId !== undefined && certificate.repoId !== input.repoId)
  )
    throw new TaskEventStoreError("invalid_store", "generation 2 activation certificate differs");
  if (!localRuntimeStateFileSystem.exists(sqliteLedgerPath(input.rootInput, 2)))
    throw new TaskEventStoreError("invalid_store", "generation 2 activation names a missing ledger");
  return certificate;
}

/** Writer-side depth check; the ledger must still carry the imported prefix the certificate names. */
export function preflightGenerationTwoActivation(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly repoId: string;
}): GenerationTwoActivationV2 | null {
  const certificate = readGenerationTwoActivation(input);
  if (certificate === null) return null;
  const store = openSqliteEventStore({
    repoId: certificate.repoId,
    databasePath: sqliteLedgerPath(input.rootInput, 2),
    generation: 2,
    readOnly: true,
  });
  try {
    if (store.revision() < certificate.importedPrefixRevision)
      throw new TaskEventStoreError("invalid_store", "generation 2 revision precedes its activation certificate");
  } finally {
    store.close();
  }
  return certificate;
}

export function sqliteContentObjectPath(
  input: HarnessLayoutInput,
  sha256: string,
  generation = SQLITE_LEDGER_GENERATION,
): string {
  if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new Error("content object hash is invalid");
  return path.join(
    path.dirname(sqliteLedgerPath(input, generation)),
    "objects",
    "sha256",
    sha256.slice(0, 2),
    sha256.slice(2),
  );
}

const SQLITE_BUSY = 5,
  OPEN_BUSY_BUDGET_MS = 5000,
  OPEN_BUSY_BACKOFF_MS = 10;

// busy_timeout goes first so every later lock wait is honoured. The WAL switch is the exception:
// SQLite skips the busy handler when a connection holding SHARED asks for EXCLUSIVE while another
// connection holds RESERVED (deadlock avoidance), so with several openers on one fresh ledger a
// concurrent opener gets SQLITE_BUSY at once no matter the timeout. A bounded retry within the same
// budget is the only remedy the engine leaves; every pragma here is idempotent.
function configureLedgerConnection(db: DatabaseSync, readOnly = false): void {
  const deadline = Date.now() + OPEN_BUSY_BUDGET_MS;
  for (;;) {
    try {
      /* @gate-identity check-bypass-write-boundary/bypass-write-127 */ db.exec(
        readOnly
          ? `PRAGMA busy_timeout=${OPEN_BUSY_BUDGET_MS}; PRAGMA foreign_keys=ON`
          : `PRAGMA busy_timeout=${OPEN_BUSY_BUDGET_MS}; PRAGMA journal_mode=WAL; ` +
              "PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON",
      );
      return;
    } catch (error) {
      // Retry only while a further attempt can still start inside the budget.
      if (!isSqliteBusy(error) || Date.now() + OPEN_BUSY_BACKOFF_MS >= deadline) throw error;
      consumeKnownError(error);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, OPEN_BUSY_BACKOFF_MS);
      // The wait can oversleep; never start an attempt at or after the deadline.
      if (Date.now() >= deadline) throw error;
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { readonly errcode?: unknown }).errcode === SQLITE_BUSY
  );
}

export function openSqliteEventStore(options: {
  readonly repoId?: string;
  readonly rootInput?: HarnessLayoutInput;
  readonly databasePath?: string;
  readonly generation?: number;
  readonly readOnly?: boolean;
  /** Offline generation conversion only; ordinary writers cannot backfill acceptance time. */
  readonly conversionSourceGeneration?: 1;
}): SqliteEventStore {
  if (!options.readOnly && options.repoId === undefined)
    throw new TaskEventStoreError("repo_mismatch", "mutable SQLite ledger opening requires repoId");
  const generation =
      options.generation ??
      (options.databasePath === undefined && options.rootInput !== undefined
        ? resolveActiveGeneration({ rootInput: options.rootInput, repoId: options.repoId })
        : SQLITE_LEDGER_GENERATION),
    databasePath = options.databasePath ?? sqliteLedgerPath(options.rootInput ?? process.cwd(), generation),
    objectRoot = path.join(path.dirname(databasePath), "objects", "sha256");
  if (options.conversionSourceGeneration !== undefined && (generation !== 2 || options.readOnly))
    throw new TaskEventStoreError("invalid_store", "conversion requires a writable generation 2 destination");
  if (!options.readOnly) localRuntimeStateFileSystem.mkdirp(path.dirname(databasePath));
  const db = /* @gate-identity check-bypass-write-boundary/bypass-write-128 */ new DatabaseSync(databasePath, {
    readOnly: options.readOnly ?? false,
  });
  configureLedgerConnection(db, options.readOnly);
  const query: SqliteQuery = (sql, values = []) =>
    /* @gate-identity check-bypass-write-boundary/bypass-write-117 */ db.prepare(sql).all(...values);
  if (!options.readOnly) createSchema(db, options.repoId!, generation);
  const metadata = readMetadata(query),
    repoId = options.repoId ?? metadata.repoId;
  assertMetadata(query, repoId, generation);
  const sqliteVersion = String(
    /* @gate-identity check-bypass-write-boundary/bypass-write-126 */ db
      .prepare("SELECT sqlite_version() AS version")
      .get()!.version,
  );

  const insertEvent = /* @gate-identity check-bypass-write-boundary/bypass-write-120 */ db.prepare(
    "INSERT INTO event(revision, op_id, event_json, digest, occurred_at, recorded_at) " +
      "VALUES (?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
  );

  const transaction = <A>(run: () => A): A => {
    /* @gate-identity check-bypass-write-boundary/bypass-write-125 */ db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      /* @gate-identity check-bypass-write-boundary/bypass-write-124 */ db.exec("COMMIT");
      return result;
    } catch (error) {
      // SQLite may already have rolled back on its own (I/O error, disk full); a failing ROLLBACK
      // must not replace the original error, which is the only record of the root cause.
      try {
        /* @gate-identity check-bypass-write-boundary/bypass-write-123 */ db.exec("ROLLBACK");
      } catch (rollbackError) {
        consumeKnownError(rollbackError);
      }
      throw error;
    }
  };
  // All lease mutations share the store's transaction and the same repository ownership boundary.
  const persistWriterLease = (fence: SqliteWriterFence | null): void => {
    /* @gate-identity check-bypass-write-boundary/bypass-write-122 */ db.prepare(
      fence === null
        ? "DELETE FROM writer_lease WHERE repo_id=?"
        : "INSERT INTO writer_lease(repo_id, holder, epoch) VALUES (?, ?, ?) " +
            "ON CONFLICT(repo_id) DO UPDATE SET holder=excluded.holder, epoch=excluded.epoch",
    ).run(...(fence === null ? [repoId] : [fence.repoId, fence.holder, fence.epoch]));
  };

  const claimWriter = (fence: SqliteWriterFence): void =>
    transaction(() => {
      assertFenceShape(fence, repoId);
      const current = readWriter(db, repoId);
      if (current && fence.epoch < current.epoch)
        throw new TaskEventStoreError(
          "revision_conflict",
          `writer epoch ${fence.epoch} is stale; current is ${current.epoch}`,
        );
      if (current && fence.epoch === current.epoch && fence.holder !== current.holder)
        throw new TaskEventStoreError("revision_conflict", `writer epoch ${fence.epoch} belongs to another holder`);
      persistWriterLease(fence);
    });

  const releaseWriter = (fence: SqliteWriterFence): void =>
    transaction(() => {
      assertFenceShape(fence, repoId);
      const current = readWriter(db, repoId);
      if (!current || current.holder !== fence.holder || current.epoch !== fence.epoch) return;
      persistWriterLease(null);
    });

  const outcome = (opId: string): SqliteCommandOutcome | null => readOutcome(db, query, opId);
  const appendCommand = (
    input: Parameters<SqliteEventStore["appendCommand"]>[0],
    eventBytes = input.events.map(serializePersistedCanonicalEvent),
  ): SqliteCommandOutcome => {
    if ((options.conversionSourceGeneration !== undefined) !== (input.historicalRecord !== undefined))
      throw new TaskEventStoreError("invalid_write_plan", "historical timestamps require an offline conversion writer");
    if (
      input.historicalRecord &&
      (input.historicalRecord.eventRecordedAt.length !== input.events.length ||
        [input.historicalRecord.recordedAt, ...input.historicalRecord.eventRecordedAt].some(
          (stamp) => !Number.isFinite(Date.parse(stamp)),
        ))
    )
      throw new TaskEventStoreError("invalid_write_plan", "historical acceptance timestamps are incomplete");
    prepareContentObjects(objectRoot, input.events, input.blobs ?? []);
    return transaction(() => {
      assertFenceShape(input.fence, repoId);
      const prior = readOutcome(db, query, input.intent.opId);
      if (prior) {
        if (prior.intentDigest !== input.intent.intentDigest)
          throw new TaskEventStoreError(
            "op_conflict",
            `opId ${input.intent.opId} already names another command intent`,
          );
        return prior;
      }
      const writer = readWriter(db, repoId);
      if (writer && input.fence.epoch < writer.epoch)
        throw new TaskEventStoreError("revision_conflict", `writer epoch ${input.fence.epoch} is stale`);
      if (writer && input.fence.epoch === writer.epoch && input.fence.holder !== writer.holder)
        throw new TaskEventStoreError(
          "revision_conflict",
          `writer epoch ${input.fence.epoch} belongs to another holder`,
        );
      persistWriterLease(input.fence);
      if (input.rejectionCode && input.events.length)
        throw new TaskEventStoreError("invalid_write_plan", "a rejected command cannot append events");
      const head = readRevision(db);
      for (const [offset, event] of input.events.entries()) {
        const revision = head + offset + 1;
        if (event.workspaceRevision !== revision)
          throw new TaskEventStoreError(
            "revision_conflict",
            `workspace revision ${event.workspaceRevision} must equal ` + `allocated revision ${revision}`,
          );
        const eventJson = eventBytes[offset]!,
          digest = `sha256:${sha256Text(eventJson)}`;
        insertEvent.run(
          revision,
          event.opId,
          eventJson,
          digest,
          event.occurredAt,
          input.historicalRecord?.eventRecordedAt[offset] ?? null,
        );
        applyDerivedGuards(db, event);
      }
      const firstRevision = input.events.length ? head + 1 : null,
        lastRevision = input.events.length ? head + input.events.length : null,
        status = input.rejectionCode ? "rejected" : "accepted_durable",
        recordedAt = input.historicalRecord?.recordedAt ?? new Date().toISOString(),
        memberOpIds = input.events.map((event) => event.opId);
      if (lastRevision !== null)
        /* @gate-identity check-bypass-write-boundary/bypass-write-119 */ db.prepare(
          "UPDATE ledger_meta SET revision=? WHERE singleton=1",
        ).run(lastRevision);
      input.beforeOutcome?.();
      /* @gate-identity check-bypass-write-boundary/bypass-write-118 */ db.prepare(
        "INSERT INTO command_outcome(" +
          "op_id, status, first_revision, last_revision, intent_digest, " +
          "intent_summary, rejection_code, recorded_at" +
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        input.intent.opId,
        status,
        firstRevision,
        lastRevision,
        input.intent.intentDigest,
        input.intent.summary,
        input.rejectionCode ?? null,
        recordedAt,
      );
      return {
        opId: input.intent.opId,
        status,
        firstRevision,
        lastRevision,
        intentDigest: input.intent.intentDigest,
        summary: input.intent.summary,
        rejectionCode: input.rejectionCode ?? null,
        recordedAt,
        memberOpIds,
      };
    });
  };
  return {
    databasePath,
    sqliteVersion,
    claimWriter,
    releaseWriter,
    writerFence: () => {
      const writer = readWriter(db, repoId);
      return writer ? { repoId, ...writer } : null;
    },
    appendCommand,
    appendValidatedBundle: ({ events, intent, ...input }) => {
      const eventBytes = events.map(serializeCanonicalEventUnchecked),
        terminal = events.at(-1)!;
      return appendCommand(
        {
          ...input,
          events,
          intent: intent?.(eventBytes) ?? {
            opId: terminal.opId,
            intentDigest: `sha256:${sha256Text(JSON.stringify(eventBytes))}`,
            summary: terminal.type,
          },
        },
        eventBytes,
      );
    },
    outcome,
    readCommandOutcome: (opId) => readCommandOutcome(db, query, opId),
    outcomes: () => readOutcomes(db, query),
    metadata: () => readMetadata(query),
    eventRows: () => readEventRows(query),
    readContentObject: (sha256) => readContentObject(objectRoot, sha256),
    contentObjectDigests: () => listContentObjectDigests(objectRoot),
    revision: () => readRevision(db),
    events: () =>
      query("SELECT event_json FROM event ORDER BY revision").map(
        (row) => JSON.parse(String(row.event_json)) as CanonicalEventV1,
      ),
    event: (opId) => readEvent(query, "op_id", opId),
    eventAtRevision: (revision) => readEvent(query, "revision", revision),
    eventIdentity: (opId) => readEventIdentity(query, "op_id", opId),
    eventIdentityAtRevision: (revision) => readEventIdentity(query, "revision", revision),
    eventsAfter: (revision, limit = 4096) =>
      query("SELECT event_json FROM event WHERE revision>? ORDER BY revision LIMIT ?", [revision, limit]).map(
        (row) => JSON.parse(String(row.event_json)) as CanonicalEventV1,
      ),
    close: () => db.close(),
  };
}

export function migrateEventsToSqlite(input: {
  readonly store: SqliteEventStore;
  readonly repoId: string;
  readonly events: readonly CanonicalEventV1[];
  readonly holder?: string;
  readonly epoch?: number;
  readonly verifyExact?: boolean;
  readonly beforeEvent?: (revision: number) => void;
}): { readonly migrated: number; readonly revision: number } {
  const fence = {
    repoId: input.repoId,
    holder: input.holder ?? "generation-migrator",
    epoch: input.epoch ?? 1,
  };
  input.store.claimWriter(fence);
  const existingRevision = input.store.revision();
  if (existingRevision > input.events.length)
    throw new TaskEventStoreError("invalid_store", "SQLite migration revision exceeds the source stream");
  for (const event of input.events.slice(existingRevision)) {
    input.beforeEvent?.(event.workspaceRevision);
    const eventJson = serializePersistedCanonicalEvent(event),
      intentDigest = `sha256:${sha256Text(eventJson)}` as const;
    input.store.appendCommand({
      fence,
      intent: { opId: event.opId, intentDigest, summary: event.type },
      events: [event],
    });
  }
  const revision = input.store.revision();
  if (input.verifyExact === false) return { migrated: revision - existingRevision, revision };
  const stored = input.store.events();
  if (stored.length !== input.events.length || stored.at(-1)?.workspaceRevision !== stored.length)
    throw new TaskEventStoreError("invalid_store", "SQLite migration count and maximum revision differ");
  for (const [index, event] of input.events.entries()) {
    const storedBytes = serializePersistedCanonicalEvent(stored[index]!),
      sourceBytes = serializePersistedCanonicalEvent(event);
    if (storedBytes !== sourceBytes)
      throw new TaskEventStoreError("invalid_store", `SQLite migration digest differs at revision ${index + 1}`);
  }
  return { migrated: revision - existingRevision, revision };
}

function createSchema(db: DatabaseSync, repoId: string, generation: number): void {
  /* @gate-identity check-bypass-write-boundary/bypass-write-116 */ db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_meta (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), repo_id TEXT NOT NULL UNIQUE,
      generation INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS event (
      revision INTEGER PRIMARY KEY, op_id TEXT NOT NULL UNIQUE, event_json TEXT NOT NULL,
      digest TEXT NOT NULL, occurred_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS command_outcome (
      op_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('accepted_durable','rejected')),
      first_revision INTEGER, last_revision INTEGER, intent_digest TEXT NOT NULL,
      intent_summary TEXT NOT NULL, rejection_code TEXT,
      recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK(
        (status='accepted_durable' AND rejection_code IS NULL)
        OR (status='rejected' AND rejection_code IS NOT NULL)
      )
    ) STRICT;
    CREATE INDEX IF NOT EXISTS command_outcome_revision ON command_outcome(last_revision, first_revision);
    CREATE TABLE IF NOT EXISTS writer_lease (
      repo_id TEXT PRIMARY KEY, holder TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch>0)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS lease_cas (
      task_id TEXT PRIMARY KEY, lease_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS lease_interval (
      task_id TEXT NOT NULL, execution_id TEXT NOT NULL, acquired_revision INTEGER NOT NULL,
      released_revision INTEGER, holder_json TEXT NOT NULL, previous_holder_json TEXT,
      lease_expires_at TEXT NOT NULL, reason TEXT NOT NULL,
      PRIMARY KEY(task_id, execution_id, acquired_revision)
    ) STRICT;
  `);
  /* @gate-identity check-bypass-write-boundary/bypass-write-115 */ db.prepare(
    "INSERT OR IGNORE INTO ledger_meta(singleton, repo_id, generation, revision) " + "VALUES (1, ?, ?, 0)",
  ).run(repoId, generation);
  const meta = /* @gate-identity check-bypass-write-boundary/bypass-write-114 */ db
    .prepare("SELECT repo_id, generation FROM ledger_meta WHERE singleton=1")
    .get()!;
  if (meta.repo_id !== repoId || Number(meta.generation) !== generation)
    throw new TaskEventStoreError(
      "repo_mismatch",
      "SQLite ledger metadata belongs to another repository or generation",
    );
}

type SqliteQuery = (
  sql: string,
  values?: readonly (string | number | null)[],
) => Record<string, import("node:sqlite").SQLOutputValue>[];

function assertMetadata(query: SqliteQuery, repoId: string, generation: number): void {
  const metadata = readMetadata(query);
  if (metadata.repoId !== repoId || metadata.generation !== generation)
    throw new TaskEventStoreError("repo_mismatch", "SQLite ledger belongs to another repository or generation");
}

function readEvent(query: SqliteQuery, column: "op_id" | "revision", value: string | number): CanonicalEventV1 | null {
  const row = query(`SELECT event_json FROM event WHERE ${column}=?`, [value]).at(0);
  return row ? (JSON.parse(String(row.event_json)) as CanonicalEventV1) : null;
}

function readEventIdentity(
  query: SqliteQuery,
  column: "op_id" | "revision",
  value: string | number,
): SqliteEventIdentity | null {
  const row = query(`SELECT revision, op_id, digest FROM event WHERE ${column}=?`, [value]).at(0);
  return row
    ? { revision: Number(row.revision), opId: String(row.op_id), eventDigest: String(row.digest) as `sha256:${string}` }
    : null;
}

function applyDerivedGuards(db: DatabaseSync, event: CanonicalEventV1): void {
  if (event.schema !== "task-event/v1") return;
  if (event.type === "execution_started") replayClaim(db, event);
  if (event.type === "lease_renewed") replayRenew(db, event);
  if (
    (event.type === "execution_submitted" && event.payload.supersedesSubmissionId === undefined) ||
    event.type === "lease_released"
  )
    replayRelease(db, event.taskId, event.payload.execution.executionId, event.workspaceRevision);
}

function assertFenceShape(fence: SqliteWriterFence, repoId: string): void {
  if (fence.repoId !== repoId || !fence.holder || !Number.isSafeInteger(fence.epoch) || fence.epoch < 1)
    throw new TaskEventStoreError("invalid_write_plan", "SQLite writer fence is invalid");
}

function readWriter(db: DatabaseSync, repoId: string): { readonly holder: string; readonly epoch: number } | null {
  const row = /* @gate-identity check-bypass-write-boundary/bypass-write-113 */ db
    .prepare("SELECT holder, epoch FROM writer_lease WHERE repo_id=?")
    .get(repoId);
  return row ? { holder: String(row.holder), epoch: Number(row.epoch) } : null;
}

function readMetadata(query: SqliteQuery): SqliteLedgerMetadata {
  const row = query("SELECT repo_id, generation, revision FROM ledger_meta WHERE singleton=1").at(0)!;
  return { repoId: String(row.repo_id), generation: Number(row.generation), revision: Number(row.revision) };
}

function readEventRows(query: SqliteQuery): readonly SqliteEventRow[] {
  return query("SELECT revision, op_id, event_json, digest, occurred_at, recorded_at FROM event ORDER BY revision").map(
    (row) => ({
      revision: Number(row.revision),
      opId: String(row.op_id),
      eventJson: String(row.event_json),
      occurredAt: String(row.occurred_at),
      recordedAt: String(row.recorded_at),
      digest: String(row.digest) as `sha256:${string}`,
    }),
  );
}

function readOutcomes(_db: DatabaseSync, query: SqliteQuery): readonly SqliteCommandOutcome[] {
  const rows = query(
      "SELECT outcome.rowid AS outcome_rowid, outcome.*, event.op_id AS member_op_id " +
        "FROM command_outcome outcome LEFT JOIN event " +
        "ON event.revision BETWEEN outcome.first_revision AND outcome.last_revision " +
        "ORDER BY outcome.rowid, event.revision",
    ),
    outcomes = new Map<number, SqliteCommandOutcome>();
  for (const row of rows) {
    const rowid = Number(row.outcome_rowid),
      current = outcomes.get(rowid),
      memberOpIds = row.member_op_id === null ? [] : [String(row.member_op_id)];
    if (current) {
      outcomes.set(rowid, { ...current, memberOpIds: [...current.memberOpIds, ...memberOpIds] });
      continue;
    }
    outcomes.set(rowid, outcomeFromRow(row, memberOpIds));
  }
  return [...outcomes.values()];
}

function readOutcome(db: DatabaseSync, query: SqliteQuery, opId: string): SqliteCommandOutcome | null {
  const row = /* @gate-identity check-bypass-write-boundary/bypass-write-112 */ db
    .prepare(
      "SELECT op_id, status, first_revision, last_revision, intent_digest, " +
        "intent_summary, rejection_code, recorded_at " +
        "FROM command_outcome WHERE op_id=?",
    )
    .get(opId);
  if (!row) return null;
  return outcomeFromRow(row, outcomeMemberOpIds(query, row));
}

function outcomeFromRow(row: Record<string, unknown>, memberOpIds: readonly string[]): SqliteCommandOutcome {
  return {
    opId: String(row.op_id),
    status: row.status as SqliteCommandOutcome["status"],
    firstRevision: row.first_revision === null ? null : Number(row.first_revision),
    lastRevision: row.last_revision === null ? null : Number(row.last_revision),
    intentDigest: String(row.intent_digest) as `sha256:${string}`,
    summary: String(row.intent_summary),
    rejectionCode: row.rejection_code === null ? null : String(row.rejection_code),
    recordedAt: String(row.recorded_at),
    memberOpIds,
  };
}

function readCommandOutcome(db: DatabaseSync, query: SqliteQuery, opId: string): SqliteCommandOutcome | null {
  const direct = readOutcome(db, query, opId);
  if (direct !== null) return direct;
  const event = query("SELECT revision FROM event WHERE op_id=?", [opId]).at(0);
  if (!event) return null;
  const revision = Number(event.revision),
    parent = query(
      "SELECT op_id FROM command_outcome " +
        "WHERE first_revision<=? AND last_revision>=? ORDER BY last_revision LIMIT 1",
      [revision, revision],
    ).at(0);
  return parent ? readOutcome(db, query, String(parent.op_id)) : null;
}

function outcomeMemberOpIds(query: SqliteQuery, row: Record<string, unknown>): readonly string[] {
  if (row.first_revision === null || row.last_revision === null) return [];
  const firstRevision = Number(row.first_revision),
    lastRevision = Number(row.last_revision);
  return query("SELECT op_id FROM event WHERE revision BETWEEN ? AND ? ORDER BY revision", [
    firstRevision,
    lastRevision,
  ]).map((event) => String(event.op_id));
}

function readRevision(db: DatabaseSync): number {
  return Number(
    /* @gate-identity check-bypass-write-boundary/bypass-write-111 */ db
      .prepare("SELECT revision FROM ledger_meta WHERE singleton=1")
      .get()!.revision,
  );
}
