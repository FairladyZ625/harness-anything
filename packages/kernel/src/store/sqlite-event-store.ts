import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  parseCanonicalEvent,
  serializePersistedCanonicalEvent,
  type CanonicalEventV1,
} from "../domain/doc-sync.contract.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import { localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";
import { replayClaim, replayRelease, replayRenew } from "../projection/rebuildable-task-projection-runtime.ts";
import { TaskEventStoreError } from "./task-event-store-types.ts";

export const SQLITE_LEDGER_GENERATION = 1;

export interface SqliteWriterFence {
  readonly repoId: string;
  readonly holder: string;
  readonly epoch: number;
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
}

export interface SqliteEventStore {
  readonly databasePath: string;
  readonly sqliteVersion: string;
  readonly claimWriter: (fence: SqliteWriterFence) => void;
  readonly appendCommand: (input: {
    readonly fence: SqliteWriterFence;
    readonly intent: SqliteCommandIntent;
    readonly events: readonly CanonicalEventV1[];
    readonly rejectionCode?: string;
    readonly beforeOutcome?: () => void;
  }) => SqliteCommandOutcome;
  readonly outcome: (opId: string) => SqliteCommandOutcome | null;
  readonly revision: () => number;
  readonly events: () => readonly CanonicalEventV1[];
  readonly close: () => void;
}

export function sqliteLedgerPath(input: HarnessLayoutInput, generation = SQLITE_LEDGER_GENERATION): string {
  return path.join(resolveHarnessLayout(input).localRoot, "store", "generations", String(generation), "ledger.sqlite");
}

export function openSqliteEventStore(options: {
  readonly repoId: string;
  readonly rootInput?: HarnessLayoutInput;
  readonly databasePath?: string;
  readonly generation?: number;
}): SqliteEventStore {
  const generation = options.generation ?? SQLITE_LEDGER_GENERATION,
    databasePath = options.databasePath ?? sqliteLedgerPath(options.rootInput ?? process.cwd(), generation);
  localRuntimeStateFileSystem.mkdirp(path.dirname(databasePath));
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; " + "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  createSchema(db, options.repoId, generation);
  const sqliteVersion = String(db.prepare("SELECT sqlite_version() AS version").get()!.version);

  const transaction = <A>(run: () => A): A => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const claimWriter = (fence: SqliteWriterFence): void =>
    transaction(() => {
      assertFenceShape(fence, options.repoId);
      const current = readWriter(db, options.repoId);
      if (current && fence.epoch < current.epoch)
        throw new TaskEventStoreError(
          "revision_conflict",
          `writer epoch ${fence.epoch} is stale; current is ${current.epoch}`,
        );
      if (current && fence.epoch === current.epoch && fence.holder !== current.holder)
        throw new TaskEventStoreError("revision_conflict", `writer epoch ${fence.epoch} belongs to another holder`);
      db.prepare(
        "INSERT INTO writer_lease(repo_id, holder, epoch) VALUES (?, ?, ?) " +
          "ON CONFLICT(repo_id) DO UPDATE SET holder=excluded.holder, epoch=excluded.epoch",
      ).run(fence.repoId, fence.holder, fence.epoch);
    });

  const outcome = (opId: string): SqliteCommandOutcome | null => readOutcome(db, opId);
  const appendCommand: SqliteEventStore["appendCommand"] = (input) =>
    transaction(() => {
      assertFenceShape(input.fence, options.repoId);
      const prior = readOutcome(db, input.intent.opId);
      if (prior) {
        if (prior.intentDigest !== input.intent.intentDigest)
          throw new TaskEventStoreError(
            "op_conflict",
            `opId ${input.intent.opId} already names another command intent`,
          );
        return prior;
      }
      const writer = readWriter(db, options.repoId);
      if (writer && input.fence.epoch < writer.epoch)
        throw new TaskEventStoreError("revision_conflict", `writer epoch ${input.fence.epoch} is stale`);
      if (writer && input.fence.epoch === writer.epoch && input.fence.holder !== writer.holder)
        throw new TaskEventStoreError(
          "revision_conflict",
          `writer epoch ${input.fence.epoch} belongs to another holder`,
        );
      db.prepare(
        "INSERT INTO writer_lease(repo_id, holder, epoch) VALUES (?, ?, ?) " +
          "ON CONFLICT(repo_id) DO UPDATE SET holder=excluded.holder, epoch=excluded.epoch",
      ).run(input.fence.repoId, input.fence.holder, input.fence.epoch);
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
        const eventJson = serializePersistedCanonicalEvent(event),
          digest = `sha256:${sha256Text(eventJson)}`;
        db.prepare(
          "INSERT INTO event(revision, op_id, event_json, digest, occurred_at) " + "VALUES (?, ?, ?, ?, ?)",
        ).run(revision, event.opId, eventJson, digest, event.occurredAt);
        applyDerivedGuards(db, event);
      }
      const firstRevision = input.events.length ? head + 1 : null,
        lastRevision = input.events.length ? head + input.events.length : null,
        status = input.rejectionCode ? "rejected" : "accepted_durable";
      if (lastRevision !== null) db.prepare("UPDATE ledger_meta SET revision=? WHERE singleton=1").run(lastRevision);
      input.beforeOutcome?.();
      db.prepare(
        "INSERT INTO command_outcome(" +
          "op_id, status, first_revision, last_revision, intent_digest, " +
          "intent_summary, rejection_code" +
          ") VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        input.intent.opId,
        status,
        firstRevision,
        lastRevision,
        input.intent.intentDigest,
        input.intent.summary,
        input.rejectionCode ?? null,
      );
      return readOutcome(db, input.intent.opId)!;
    });
  return {
    databasePath,
    sqliteVersion,
    claimWriter,
    appendCommand,
    outcome,
    revision: () => readRevision(db),
    events: () =>
      db
        .prepare("SELECT event_json FROM event ORDER BY revision")
        .all()
        .map((row) => parseCanonicalEvent(String(row.event_json))),
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
  db.exec(`
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
  db.prepare(
    "INSERT OR IGNORE INTO ledger_meta(singleton, repo_id, generation, revision) " + "VALUES (1, ?, ?, 0)",
  ).run(repoId, generation);
  const meta = db.prepare("SELECT repo_id, generation FROM ledger_meta WHERE singleton=1").get()!;
  if (meta.repo_id !== repoId || Number(meta.generation) !== generation)
    throw new TaskEventStoreError(
      "repo_mismatch",
      "SQLite ledger metadata belongs to another repository or generation",
    );
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
  const row = db.prepare("SELECT holder, epoch FROM writer_lease WHERE repo_id=?").get(repoId);
  return row ? { holder: String(row.holder), epoch: Number(row.epoch) } : null;
}

function readOutcome(db: DatabaseSync, opId: string): SqliteCommandOutcome | null {
  const row = db
    .prepare(
      "SELECT op_id, status, first_revision, last_revision, intent_digest, " +
        "intent_summary, rejection_code " +
        "FROM command_outcome WHERE op_id=?",
    )
    .get(opId);
  if (!row) return null;
  return {
    opId: String(row.op_id),
    status: row.status as SqliteCommandOutcome["status"],
    firstRevision: row.first_revision === null ? null : Number(row.first_revision),
    lastRevision: row.last_revision === null ? null : Number(row.last_revision),
    intentDigest: String(row.intent_digest) as `sha256:${string}`,
    summary: String(row.intent_summary),
    rejectionCode: row.rejection_code === null ? null : String(row.rejection_code),
  };
}

function readRevision(db: DatabaseSync): number {
  return Number(db.prepare("SELECT revision FROM ledger_meta WHERE singleton=1").get()!.revision);
}
