import { openReplicaAckStore, type ReplicaDeliveryKey } from "./replica-ack-store.ts";
import type { ReplicaDeliveryLease } from "./replica-delivery-lease.ts";
import { FleetFault } from "./center-types.ts";
import { READ_MODEL_SCHEMA_GENERATION, runtimeEventContentClaims } from "@harness-anything/kernel";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { consumeKnownError } from "@harness-anything/kernel";
import {
  canonicalDocumentClaims,
  canonicalDocumentRetirements,
  serializeEventHead,
  serializePersistedCanonicalEvent,
  sha256Bytes,
  sha256Text,
  stableStringify,
  type CanonicalEventV1,
  type LedgerCutIdentity,
  type ReplicaProjectionBasis,
} from "@harness-anything/kernel";
import { edgeReadModelEntries, isReadModelPath, type EdgeReadModelRows } from "@harness-anything/kernel";
import {
  fleetManifestDigest,
  type FleetBlob,
  type FleetDeltaChange,
  type FleetEntry,
  type FleetManifest,
} from "./contract.ts";

export interface SnapshotCut {
  readonly repoId: string;
  readonly revision: number;
  readonly headDigest: string;
  readonly manifest: FleetManifest;
}
export interface ReplicaChangeLogEntry {
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly change: FleetDeltaChange;
}
export interface ReplicaManifestPage {
  readonly entries: readonly FleetEntry[];
  readonly done: boolean;
}
export interface ReplicaCutSource {
  readonly pin: (
    key: ReplicaDeliveryKey,
    holderId: string,
    from: number | null,
    quota: number,
    leaseRoot: string,
  ) => Promise<{ readonly cut: SnapshotCut; readonly lease: ReplicaDeliveryLease }>;
  readonly releasePin: (lease: ReplicaDeliveryLease) => void;
  readonly pinActive: (lease: ReplicaDeliveryLease) => boolean;

  readonly activate: () => SnapshotCut | null;
  readonly prepare: () => Promise<SnapshotCut | null>;
  readonly delivery: {
    readonly manifestPage: (revision: number, offset: number) => Promise<ReplicaManifestPage | null>;
    readonly manifestEntry: (revision: number, path: string) => Promise<FleetEntry | null>;
    readonly changes: (from: number, to: number) => Promise<readonly FleetDeltaChange[] | null>;
    readonly content: (blob: FleetBlob) => Promise<Uint8Array>;
  };
  readonly ledgerCut: () => LedgerCutIdentity | null;
  readonly exactRevision: () => number | null;
  readonly kick: () => void;
  readonly waitForCut: (revision: number, signal?: AbortSignal) => Promise<SnapshotCut>;
  readonly latest: () => SnapshotCut | null;
  readonly cut: (revision: number) => SnapshotCut | null;
  readonly eventAt: (revision: number) => string | null;
  readonly receiptBasis: (opId: string) => { readonly event: CanonicalEventV1; readonly applied: boolean } | null;
  readonly manifest: (revision: number) => readonly FleetEntry[] | null;
  readonly manifestPage: (revision: number, offset: number) => ReplicaManifestPage | null;
  readonly manifestEntry: (revision: number, path: string) => FleetEntry | null;
  readonly changes: (fromRevision: number, toRevision: number) => readonly FleetDeltaChange[] | null;
  readonly changeLog: () => readonly ReplicaChangeLogEntry[];
  readonly content: (blob: FleetBlob) => Uint8Array;
  readonly close: () => void;
}
export interface ReplicaCutSourceOptions {
  readonly repoId: string;
  readonly localRoot: string;
  readonly readBasis: (afterRevision: number | null) => ReplicaProjectionBasis;
  /** Bind basis and model reads to one SQLite snapshot when a concurrent writer owns the projection. */
  readonly withReadSnapshot?: <T>(read: () => T) => T;
  readonly readLedgerCut?: () => LedgerCutIdentity;
  readonly readContentBlob: (sha256: string) => Uint8Array | null;
  readonly readEvent?: (opId: string) => CanonicalEventV1 | null;
  readonly readApplied?: (opId: string) => { readonly event: CanonicalEventV1; readonly watermark: number } | null;
  /** The edge read model at the projection's current revision, or null while it is not ready. */
  readonly readEdgeReadModel?: <T>(
    read: (
      model: {
        readonly sourceRevision: number;
        readonly rootThreshold: number;
        readonly rows: EdgeReadModelRows;
      } | null,
    ) => T,
  ) => T;
}

export function openReplicaCutSource(options: ReplicaCutSourceOptions): ReplicaCutSource {
  if (!/^[A-Za-z0-9_-]{1,96}$/u.test(options.repoId)) throw new Error("replica repo id is invalid");
  const root = path.join(options.localRoot, "replica", "repos", options.repoId, `g${READ_MODEL_SCHEMA_GENERATION}`),
    // A schema upgrade publishes a new derived namespace at the same canonical head.
    // Complete checkpoints use their own derived namespace; integer cuts are not checkpoints.
    databasePath = path.join(root, "checkpoints.sqlite");
  let database: DatabaseSync | null = null,
    active = false,
    scheduled = false,
    closed = false;
  const db = () => {
    if (closed) throw new Error("replica cut source is closed");
    if (database) return database;
    mkdirSync(root, { recursive: true });
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    database.exec(
      "CREATE TABLE IF NOT EXISTS cut (repo_id TEXT NOT NULL, revision INTEGER PRIMARY KEY, head_digest TEXT NOT NULL, manifest_digest TEXT NOT NULL, entry_count INTEGER NOT NULL, total_bytes INTEGER NOT NULL, event_occurred_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS change (repo_id TEXT NOT NULL, from_revision INTEGER NOT NULL, to_revision INTEGER NOT NULL, path TEXT NOT NULL, op TEXT NOT NULL, blob_sha256 TEXT, size INTEGER, media_type TEXT, PRIMARY KEY(repo_id, from_revision, to_revision, path)); CREATE TABLE IF NOT EXISTS delivery_pin (id TEXT PRIMARY KEY, lease_json TEXT NOT NULL, lease_root TEXT NOT NULL, from_revision INTEGER NOT NULL, to_revision INTEGER NOT NULL, quota INTEGER NOT NULL, remaining INTEGER); CREATE TABLE IF NOT EXISTS checkpoint_link (to_revision INTEGER PRIMARY KEY, from_revision INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS read_model_blob (sha256 TEXT PRIMARY KEY, bytes BLOB NOT NULL); CREATE TABLE IF NOT EXISTS manifest_entry (manifest_digest TEXT NOT NULL, ordinal INTEGER NOT NULL, path TEXT NOT NULL, entry_json TEXT NOT NULL, PRIMARY KEY(manifest_digest, ordinal), UNIQUE(manifest_digest, path));",
    );
    return database;
  };
  // Retention follows the existing delivery lease, including renewals while the builder is busy.
  const leaseStores = new Map<string, ReturnType<typeof openReplicaAckStore>>();
  const pinId = (lease: ReplicaDeliveryLease) =>
    JSON.stringify([lease.nodeId, lease.viewId, lease.holderId, lease.claimFence]);
  const leaseStore = (leaseRoot: string) => {
    let authority = leaseStores.get(leaseRoot);
    if (!authority) {
      authority = openReplicaAckStore(leaseRoot);
      leaseStores.set(leaseRoot, authority);
    }
    return authority;
  };
  const liveLease = (lease: ReplicaDeliveryLease, leaseRoot: string) => {
    const active = leaseStore(leaseRoot).delivery.active(lease, Date.now());
    return (
      active?.holderId === lease.holderId && active.claimFence === lease.claimFence && active.viewId === lease.viewId
    );
  };
  // Buffer deletion evidence until its checkpoint transaction commits, never log rolled-back releases.
  const pinReleaseLogs: string[] = [];
  const cutFrom = (row: Record<string, unknown> | undefined): SnapshotCut | null =>
    row
      ? {
          repoId: options.repoId,
          revision: Number(row.revision),
          headDigest: String(row.head_digest),
          manifest: {
            digest: String(row.manifest_digest),
            entryCount: Number(row.entry_count),
            totalBytes: Number(row.total_bytes),
          },
        }
      : null;
  const latest = () =>
      cutFrom(
        db().prepare("SELECT * FROM cut ORDER BY revision DESC LIMIT 1").get() as Record<string, unknown> | undefined,
      ),
    cut = (revision: number) =>
      cutFrom(db().prepare("SELECT * FROM cut WHERE revision=?").get(revision) as Record<string, unknown> | undefined),
    eventAt = (revision: number) =>
      (
        db().prepare("SELECT event_occurred_at FROM cut WHERE revision=?").get(revision) as
          | { event_occurred_at: string }
          | undefined
      )?.event_occurred_at ?? null,
    exactRevision = () => {
      const basis = options.readBasis(null);
      return basis.watermark > 0 && basis.watermark === basis.sourceRevision ? basis.watermark : null;
    },
    receiptBasis = (opId: string) => {
      const event = options.readEvent?.(opId);
      if (!event) return null;
      const applied = options.readApplied?.(opId);
      return {
        event,
        applied:
          !!applied &&
          applied.watermark >= event.workspaceRevision &&
          serializePersistedCanonicalEvent(applied.event) === serializePersistedCanonicalEvent(event),
      };
    };
  const manifestPage = (revision: number, offset: number): ReplicaManifestPage | null => {
    const current = cut(revision);
    if (!current) return null;
    const rows = db()
      .prepare(
        "SELECT entry_json FROM manifest_entry WHERE manifest_digest = ? AND ordinal >= ? ORDER BY ordinal LIMIT 129",
      )
      .all(current.manifest.digest, offset);
    return {
      entries: rows.slice(0, 128).map((row) => JSON.parse(String(row.entry_json)) as FleetEntry),
      done: rows.length <= 128,
    };
  };
  const manifestEntry = (revision: number, entryPath: string): FleetEntry | null => {
    const current = cut(revision);
    if (!current) return null;
    const row = db()
      .prepare("SELECT entry_json FROM manifest_entry WHERE manifest_digest = ? AND path = ?")
      .get(current.manifest.digest, entryPath);
    return row ? (JSON.parse(String(row.entry_json)) as FleetEntry) : null;
  };
  const manifest = (revision: number): FleetEntry[] | null => {
    const current = cut(revision);
    if (!current) return null;
    const entries: FleetEntry[] = [],
      hash = createHash("sha256").update("[");
    for (const row of db()
      .prepare("SELECT entry_json FROM manifest_entry WHERE manifest_digest = ? ORDER BY ordinal")
      .iterate(current.manifest.digest)) {
      if (entries.length) hash.update(",");
      hash.update(String(row.entry_json));
      entries.push(JSON.parse(String(row.entry_json)) as FleetEntry);
    }
    if (hash.update("]").digest("hex") !== current.manifest.digest)
      throw new Error(`replica manifest ${current.manifest.digest} is corrupt`);
    return entries;
  };
  const writeManifest = (entries: readonly FleetEntry[]): string => {
    const hash = createHash("sha256").update("[");
    for (const [index, entry] of entries.entries()) {
      if (index) hash.update(",");
      hash.update(stableStringify(entry));
    }
    const digest = hash.update("]").digest("hex"),
      store = db();
    const prior = store
      .prepare("SELECT entry_json FROM manifest_entry WHERE manifest_digest = ? ORDER BY ordinal")
      .iterate(digest);
    const first = prior.next();
    if (!first.done) {
      try {
        let row: ReturnType<typeof prior.next> = first;
        for (const entry of entries) {
          if (row.done || String(row.value.entry_json) !== stableStringify(entry))
            throw new Error(`replica manifest CAS collision ${digest}`);
          row = prior.next();
        }
        if (!row.done) throw new Error(`replica manifest CAS collision ${digest}`);
        return digest;
      } finally {
        prior.return?.();
      }
    }
    const insert = store.prepare("INSERT INTO manifest_entry VALUES (?, ?, ?, ?)");
    for (const [index, entry] of entries.entries()) insert.run(digest, index, entry.path, stableStringify(entry));
    return digest;
  };
  // Connection-local derived accounting: rebuild once on owner activation, then update in the
  // publication transaction. TEMP tables roll back with the cut and require no persistent migration.
  let retentionInitialized = false;
  const countRetention = (deltas: Map<string, { size: number; refs: number }>, blob: FleetBlob, refs: number) => {
    const delta = deltas.get(blob.sha256);
    if (delta) delta.refs += refs;
    else deltas.set(blob.sha256, { size: blob.size, refs });
  };
  const initializeRetention = (store: DatabaseSync) => {
    if (retentionInitialized) return;
    transact(store, () => {
      store.exec(
        "CREATE TEMP TABLE retention_blob (sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, refs INTEGER NOT NULL, last_revision INTEGER NOT NULL); " +
          "CREATE INDEX retention_retired ON retention_blob(refs, last_revision); " +
          "CREATE TEMP TABLE retention_total (revision INTEGER PRIMARY KEY, bytes INTEGER NOT NULL);",
      );
      // The retained chain already records every path change. Seed one manifest, then replay
      // its sparse suffix; activation must not scan all retained full manifests either.
      const entries = new Map<string, FleetBlob>(),
        changes = store.prepare("SELECT * FROM change WHERE repo_id = ? AND from_revision = ? AND to_revision = ?");
      let previous: number | null = null;
      for (const cut of store.prepare("SELECT revision, manifest_digest FROM cut ORDER BY revision").all()) {
        const revision = Number(cut.revision),
          deltas = new Map<string, { size: number; refs: number }>();
        if (previous === null) {
          for (const row of store
            .prepare("SELECT entry_json FROM manifest_entry WHERE manifest_digest = ?")
            .iterate(cut.manifest_digest)) {
            const entry = JSON.parse(String(row.entry_json)) as FleetEntry;
            entries.set(entry.path, entry.blob);
            countRetention(deltas, entry.blob, 1);
          }
        } else {
          for (const row of changes.iterate(options.repoId, previous, revision)) {
            const itemPath = String(row.path),
              before = entries.get(itemPath);
            if (before) countRetention(deltas, before, -1);
            if (row.op === "put") {
              const blob = {
                sha256: String(row.blob_sha256),
                size: Number(row.size),
                mediaType: String(row.media_type),
              };
              entries.set(itemPath, blob);
              countRetention(deltas, blob, 1);
            } else entries.delete(itemPath);
          }
        }
        accountRetention(store, revision, previous, deltas);
        previous = revision;
      }
      return [];
    });
    retentionInitialized = true;
  };
  const retainedBytes = (store: DatabaseSync, from: number): number =>
    Number(store.prepare("SELECT bytes FROM retention_total WHERE revision = ?").get(from)!.bytes);
  const accountRetention = (
    store: DatabaseSync,
    revision: number,
    previousRevision: number | null,
    deltas: ReadonlyMap<string, { readonly size: number; readonly refs: number }>,
  ) => {
    let headBytes = previousRevision === null ? 0 : retainedBytes(store, previousRevision);
    const read = store.prepare("SELECT refs, last_revision FROM retention_blob WHERE sha256 = ?"),
      write = store.prepare(
        "INSERT INTO retention_blob VALUES (?, ?, ?, ?) ON CONFLICT(sha256) DO UPDATE SET refs=excluded.refs, last_revision=excluded.last_revision",
      ),
      add = store.prepare("UPDATE retention_total SET bytes = bytes + ? WHERE revision > ?");
    for (const [sha256, delta] of deltas) {
      if (delta.refs === 0) continue;
      const prior = previousRevision === null ? undefined : read.get(sha256),
        before = Number(prior?.refs ?? 0),
        after = before + delta.refs;
      // A returning blob is already charged to suffixes that include its last appearance.
      if (before === 0) {
        headBytes += delta.size;
        if (previousRevision !== null) add.run(delta.size, Number(prior?.last_revision ?? 0));
      } else if (after === 0) headBytes -= delta.size;
      write.run(sha256, delta.size, after, after === 0 ? previousRevision! : revision);
    }
    store.prepare("INSERT INTO retention_total VALUES (?, ?)").run(revision, headBytes);
  };
  const prune = (store: DatabaseSync) => {
    const retained = store
        .prepare("SELECT revision FROM cut ORDER BY revision DESC LIMIT 64")
        .all() as unknown as readonly { readonly revision: number }[],
      normalOldest = retained.at(-1)?.revision;
    if (normalOldest === undefined) return [] as string[];
    let oldest = normalOldest;
    for (const pin of store.prepare("SELECT * FROM delivery_pin").all()) {
      const lease = JSON.parse(String(pin.lease_json)) as ReplicaDeliveryLease;
      const cursor = leaseStore(String(pin.lease_root)).cursor(lease);
      // ACK ends the offer lease, but its cursor needs a bounded opportunity to request the next delta.
      const acknowledged = cursor?.revision === Number(pin.to_revision);
      const remaining = pin.remaining === null ? 64 : Number(pin.remaining) - 1;
      const from = acknowledged ? cursor.revision : Number(pin.from_revision);
      const observed = acknowledged ? null : leaseStore(String(pin.lease_root)).delivery.inspect(lease, Date.now());
      const reason = (acknowledged ? remaining <= 0 : observed!.state !== "active")
        ? acknowledged
          ? "ack_window_exhausted"
          : "lease_inactive"
        : acknowledged && retainedBytes(store, from) > Number(pin.quota)
          ? "ack_quota_exceeded"
          : cursor && cursor.revision > Number(pin.to_revision)
            ? "cursor_advanced"
            : null;
      if (reason) {
        const evidence = observed ?? leaseStore(String(pin.lease_root)).delivery.inspect(lease, Date.now());
        store.prepare("DELETE FROM delivery_pin WHERE id=?").run(String(pin.id));
        pinReleaseLogs.push(
          JSON.stringify({
            event: "replica_pin_released",
            reason,
            now: evidence.now,
            requested: lease,
            lease: evidence,
          }),
        );
        continue;
      }
      if (acknowledged)
        store
          .prepare("UPDATE delivery_pin SET remaining=?, from_revision=? WHERE id=?")
          .run(remaining, from, String(pin.id));
      oldest = Math.min(oldest, from);
    }
    const digests = (
      store.prepare("SELECT DISTINCT manifest_digest FROM cut WHERE revision < ?").all(oldest) as unknown as readonly {
        readonly manifest_digest: string;
      }[]
    ).map((row) => row.manifest_digest);
    store.prepare("DELETE FROM cut WHERE revision < ?").run(oldest);
    store.prepare("DELETE FROM change WHERE from_revision < ?").run(oldest);
    store.prepare("DELETE FROM retention_total WHERE revision < ?").run(oldest);
    store.prepare("DELETE FROM retention_blob WHERE refs = 0 AND last_revision < ?").run(oldest);
    store.prepare("DELETE FROM checkpoint_link WHERE from_revision < ?").run(oldest);
    return digests;
  };
  // Cut and manifest rows share the round transaction; unreferenced content is reclaimed afterwards.
  const persistCut = (
    store: DatabaseSync,
    event: CanonicalEventV1,
    entries: readonly FleetEntry[],
    previous: { readonly revision: number; readonly entries: readonly FleetEntry[] } | null,
    digest: string,
  ): { readonly cut: SnapshotCut; readonly pruned: readonly string[] } => {
    const headDigest = `sha256:${sha256Text(
        serializeEventHead({
          revision: event.workspaceRevision,
          opId: event.opId,
          eventDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(event))}`,
        }),
      )}`,
      prior = new Map(previous?.entries.map((entry) => [entry.path, entry])),
      next = new Set(entries.map((entry) => entry.path)),
      changes = previous
        ? [
            ...entries
              .filter((entry) => {
                const before = prior.get(entry.path)?.blob;
                return (
                  before === undefined ||
                  before.sha256 !== entry.blob.sha256 ||
                  before.size !== entry.blob.size ||
                  before.mediaType !== entry.blob.mediaType
                );
              })
              .map((entry) => ({ op: "put" as const, path: entry.path, blob: entry.blob })),
            ...previous.entries
              .filter((entry) => !next.has(entry.path))
              .map((entry) => ({ op: "delete" as const, path: entry.path })),
          ]
        : [],
      insertCut = store.prepare(
        "INSERT OR IGNORE INTO cut(repo_id, revision, head_digest, manifest_digest, entry_count, total_bytes, event_occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ),
      insertChange = store.prepare(
        "INSERT OR IGNORE INTO change(repo_id, from_revision, to_revision, path, op, blob_sha256, size, media_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
    const deltas = new Map<string, { size: number; refs: number }>();
    if (previous) {
      for (const change of changes) {
        const before = prior.get(change.path);
        if (before) countRetention(deltas, before.blob, -1);
        if (change.op === "put") countRetention(deltas, change.blob, 1);
      }
    } else for (const entry of entries) countRetention(deltas, entry.blob, 1);
    accountRetention(store, event.workspaceRevision, previous?.revision ?? null, deltas);
    insertCut.run(
      options.repoId,
      event.workspaceRevision,
      headDigest,
      digest,
      entries.length,
      entries.reduce((sum, entry) => sum + entry.blob.size, 0),
      event.occurredAt,
    );
    if (previous)
      store.prepare("INSERT INTO checkpoint_link VALUES (?, ?)").run(event.workspaceRevision, previous.revision);
    for (const change of changes)
      insertChange.run(
        options.repoId,
        previous!.revision,
        event.workspaceRevision,
        change.path,
        change.op,
        change.op === "put" ? change.blob.sha256 : null,
        change.op === "put" ? change.blob.size : null,
        change.op === "put" ? change.blob.mediaType : null,
      );
    return { cut: latest()!, pruned: prune(store) };
  };
  const transact = (store: DatabaseSync, body: () => readonly string[]): readonly string[] => {
    store.exec("BEGIN IMMEDIATE");
    let pruned: readonly string[];
    try {
      pruned = body();
      store.exec("COMMIT");
    } catch (error) {
      pinReleaseLogs.length = 0;
      try {
        store.exec("ROLLBACK");
      } catch (rollbackError) {
        consumeKnownError(rollbackError);
      }
      throw error;
    }
    for (const entry of pinReleaseLogs.splice(0)) console.info("[fleet-center] pin-release", entry);
    return pruned;
  };
  const pruneContent = (store: DatabaseSync, digests: readonly string[]): void => {
    for (const orphan of digests)
      if (!store.prepare("SELECT 1 FROM cut WHERE manifest_digest = ? LIMIT 1").get(orphan))
        store.prepare("DELETE FROM manifest_entry WHERE manifest_digest = ?").run(orphan);
    if (digests.length === 0) return;
    // Every retained snapshot and delta must keep its content, including results removed from the head.
    const live = new Set(
      (
        store
          .prepare(
            "SELECT DISTINCT blob_sha256 FROM change WHERE path LIKE '.read-model/%' AND blob_sha256 IS NOT NULL",
          )
          .all() as unknown as readonly { readonly blob_sha256: string }[]
      ).map((row) => row.blob_sha256),
    );
    for (const retained of store.prepare("SELECT MIN(revision) AS revision FROM cut GROUP BY manifest_digest").all())
      for (const entry of manifest(Number(retained.revision)) ?? [])
        if (isReadModelPath(entry.path)) live.add(entry.blob.sha256);
    transact(store, () => {
      const remove = store.prepare("DELETE FROM read_model_blob WHERE sha256 = ?");
      for (const row of store.prepare("SELECT sha256 FROM read_model_blob").all())
        if (!live.has(String(row.sha256))) remove.run(row.sha256);
      return [];
    });
  };
  const persistInitial = (event: CanonicalEventV1, entries: FleetEntry[]): SnapshotCut => {
    const store = db();
    let cut!: SnapshotCut;
    const pruned = transact(store, () => {
      const published = withReadModel(entries, event.workspaceRevision),
        digest = writeManifest(published),
        persisted = persistCut(store, event, published, null, digest);
      cut = persisted.cut;
      return persisted.pruned;
    });
    pruneContent(store, pruned);
    return cut;
  };
  const entriesFrom = (basis: ReplicaProjectionBasis) =>
    basis.documents
      .map(({ path: itemPath, blobSha256, size, mediaType }) => ({
        path: itemPath,
        blob: { sha256: blobSha256, size, mediaType },
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
  // Derived row bytes share the cut's SQLite transaction, so publication pays one durable commit
  // instead of one file and directory flush per row. The wire still addresses each row by its hash.
  const withReadModel = (entries: FleetEntry[], revision: number): FleetEntry[] => {
    if (!options.readEdgeReadModel) return entries;
    return options.readEdgeReadModel((model) => {
      if (!model || model.sourceRevision !== revision)
        throw new Error(`Read model is unavailable at revision ${revision}`);
      const insertBlob = db().prepare("INSERT OR IGNORE INTO read_model_blob(sha256, bytes) VALUES (?, ?)"),
        readModelEntry = (entryPath: string, text: string, mediaType: string): FleetEntry => {
          const body = Buffer.from(text),
            sha256 = sha256Bytes(body);
          insertBlob.run(sha256, body);
          return { path: entryPath, blob: { sha256, size: body.byteLength, mediaType } };
        };
      const ciDetails: FleetEntry[] = [];
      const results = new Map<string, FleetEntry>(),
        requiredResults = new Set<string>(),
        unavailable = new Set<string>(),
        unavailableEntries: FleetEntry[] = [];
      const requireResult = (ref: string | null | undefined) => {
        if (ref) requiredResults.add(ref);
      };
      for (const row of model.rows.repository) {
        if (row.table === "runtime_session")
          requireResult((JSON.parse(String(row.values.value_json)) as { resultRef?: string | null }).resultRef);
        if (row.table !== "event_index") continue;
        const event = JSON.parse(String(row.values.event_json)) as CanonicalEventV1;
        if (event.schema === "ci-run-observation/v4" && event.payload.detailRef)
          ciDetails.push(
            readModelEntry(
              `.read-model/ci-details/${event.eventId}.json`,
              JSON.stringify({ eventId: event.eventId, ref: event.payload.detailRef }),
              "application/json",
            ),
          );
        if (event.schema === "schedule-event/v1") {
          const detail = event.payload.schedule.status.lastRun?.detail;
          // Retired schedule settlement stored a result ref plus cleanup prose in detail.
          // Current outcomes carry claims; their missing/corrupt content still fails below.
          if (detail?.startsWith("artifact:runtime-result/")) {
            requireResult(detail);
            unavailable.add(detail);
          }
        }
        if (event.schema !== "agent-runtime-event/v1" || event.type !== "runtime_session_outcome_observed") continue;
        requireResult(event.payload.resultRef);
        if (event.payload.result === null) unavailable.add(event.payload.resultRef);
        for (const claim of runtimeEventContentClaims(event)) {
          const bytes = options.readContentBlob(claim.sha256);
          if (!bytes || bytes.byteLength !== claim.size || sha256Bytes(bytes) !== claim.sha256)
            throw new Error(`Runtime result ${claim.sha256} is unavailable at revision ${revision}`);
          insertBlob.run(claim.sha256, bytes);
          results.set(claim.sha256, {
            path: `.read-model/runtime-results/${claim.sha256}`,
            blob: { sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType },
          });
        }
      }
      for (const ref of requiredResults) {
        const digest = /^artifact:runtime-result\/sha256\/([a-f0-9]{64})$/u.exec(ref)?.[1];
        if (
          (!digest || !results.has(digest)) &&
          unavailable.has(ref) &&
          (!digest || options.readContentBlob(digest) === null)
        ) {
          unavailable.add(ref);
          unavailableEntries.push(
            readModelEntry(
              `.read-model/runtime-results-unavailable/${digest ?? `ref-${sha256Text(ref)}`}`,
              stableStringify({ resultRef: ref, availability: "unavailable", downloadable: false }),
              "application/json",
            ),
          );
          continue;
        }
        if (!digest || !results.has(digest))
          throw new Error(`Runtime result ${ref} has no content claim at revision ${revision}`);
      }
      const published = [
        ...ciDetails,
        ...unavailableEntries,
        ...results.values(),
        ...entries.filter((entry) => !isReadModelPath(entry.path)),
      ];
      for (const entry of edgeReadModelEntries({
        sourceRevision: revision,
        rootThreshold: model.rootThreshold,
        rows: {
          ...model.rows,
          repository: (function* () {
            for (const row of model.rows.repository) {
              yield publicSession(row);
            }
          })(),
        },
      }))
        published.push(readModelEntry(entry.path, entry.text, "application/json"));
      return published.sort((left, right) => left.path.localeCompare(right.path));

      function publicSession(row: EdgeReadModelRows["repository"] extends Iterable<infer R> ? R : never) {
        if (row.table !== "runtime_session") return row;
        const session = JSON.parse(String(row.values.value_json)) as { resultRef?: string };
        if (!session.resultRef || !unavailable.has(session.resultRef)) return row;
        const digest = /^artifact:runtime-result\/sha256\/([a-f0-9]{64})$/u.exec(session.resultRef)?.[1];
        if (digest && results.has(digest)) return row;
        return {
          ...row,
          values: {
            ...row.values,
            value_json: stableStringify({
              ...session,
              resultAvailability: "unavailable",
              resultDownloadable: false,
            }),
          },
        };
      }
    });
  };
  const documentDigest = (entries: readonly FleetEntry[]) =>
    fleetManifestDigest(entries.filter((entry) => !isReadModelPath(entry.path)));
  const settle = (cut: SnapshotCut) => {
    for (const [revision, rows] of waiters) {
      if (revision > cut.revision) continue;
      waiters.delete(revision);
      for (const row of rows) row.resolve(cut);
    }
  };
  const readSnapshot = options.withReadSnapshot ?? (<T>(read: () => T): T => read());
  const buildRound = () => {
    const initial = latest(),
      basis = options.readBasis(initial?.revision ?? null);
    if (basis.watermark === 0 || basis.watermark !== basis.sourceRevision || !basis.headEvent) return;
    if (initial && basis.watermark <= initial.revision) return;
    if (!initial) {
      settle(persistInitial(basis.headEvent, entriesFrom(basis)));
      return;
    }
    const before = manifest(initial.revision)!,
      store = db(),
      entries = new Map(before.map((entry) => [entry.path, entry]));
    // Reconcile the captured event suffix once, without publishing mixed-model intermediate cuts.
    for (const event of basis.events) {
      for (const retirement of canonicalDocumentRetirements(event)) entries.delete(retirement.path);
      for (const claim of canonicalDocumentClaims(event))
        entries.set(claim.path, {
          path: claim.path,
          blob: { sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType },
        });
    }
    let published!: SnapshotCut;
    const pruned = transact(store, () => {
      const complete = withReadModel(
        [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)),
        basis.watermark,
      );
      if (documentDigest(complete) !== documentDigest(entriesFrom(basis)))
        throw new Error(`replica manifest drift at revision ${basis.watermark}`);
      const persisted = persistCut(
        store,
        basis.headEvent!,
        complete,
        { revision: initial.revision, entries: before },
        writeManifest(complete),
      );
      published = persisted.cut;
      return persisted.pruned;
    });
    pruneContent(store, pruned);
    settle(published);
  };
  const runRound = () => readSnapshot(buildRound);
  const waiters = new Map<
    number,
    Array<{ readonly resolve: (cut: SnapshotCut) => void; readonly reject: (error: unknown) => void }>
  >();
  const activateSnapshot = () => {
    active = true;
    initializeRetention(db());
    const current = latest();
    if (current) {
      kick();
      return current;
    }
    const basis = options.readBasis(null),
      cut =
        basis.watermark > 0 && basis.watermark === basis.sourceRevision && basis.headEvent
          ? persistInitial(basis.headEvent, entriesFrom(basis))
          : null;
    if (cut) settle(cut);
    else kick();
    return cut;
  };
  const activate = () => readSnapshot(activateSnapshot);
  const kick = () => {
    if (!active || scheduled || closed) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      try {
        runRound();
      } catch (error) {
        consumeKnownError(error);
        const pending = [...waiters.values()].flat();
        waiters.clear();
        for (const row of pending) row.reject(error);
      }
    });
  };
  const waitForCut = (revision: number, signal?: AbortSignal) => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const row = cutFrom(
      db().prepare("SELECT * FROM cut WHERE revision >= ? ORDER BY revision LIMIT 1").get(revision) as
        | Record<string, unknown>
        | undefined,
    );
    if (row) return Promise.resolve(row);
    const promise = new Promise<SnapshotCut>((resolve, reject) => {
      const rows = waiters.get(revision) ?? [];
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const waiter = {
        resolve: (cut: SnapshotCut) => {
          cleanup();
          resolve(cut);
        },
        reject: (error: unknown) => {
          cleanup();
          reject(error);
        },
      };
      const abort = () => {
        rows.splice(rows.indexOf(waiter), 1);
        if (!rows.length) waiters.delete(revision);
        waiter.reject(signal!.reason);
      };
      rows.push(waiter);
      waiters.set(revision, rows);
      signal?.addEventListener("abort", abort, { once: true });
    });
    kick();
    return promise;
  };
  const changeRowOf = (row: Record<string, unknown>): ReplicaChangeLogEntry => ({
    fromRevision: Number(row.from_revision),
    toRevision: Number(row.to_revision),
    change:
      row.op === "put"
        ? {
            op: "put" as const,
            path: String(row.path),
            blob: { sha256: String(row.blob_sha256), size: Number(row.size), mediaType: String(row.media_type) },
          }
        : { op: "delete" as const, path: String(row.path) },
  });
  const changeRows = (range?: { readonly from: number; readonly to: number }): readonly ReplicaChangeLogEntry[] => {
    const store = db(),
      rows =
        range === undefined
          ? (store
              .prepare("SELECT * FROM change ORDER BY from_revision, to_revision, path")
              .all() as unknown as readonly Record<string, unknown>[])
          : (store
              .prepare(
                "SELECT * FROM change WHERE from_revision >= ? AND to_revision <= ? " +
                  "ORDER BY from_revision, to_revision, path",
              )
              .all(range.from, range.to) as unknown as readonly Record<string, unknown>[]);
    return rows.map(changeRowOf);
  };
  const changeLog = () => changeRows();
  const changes = (fromRevision: number, toRevision: number) => {
    if (!cut(fromRevision) || !cut(toRevision) || fromRevision > toRevision) return null;
    const links = db()
      .prepare(
        "SELECT from_revision, to_revision FROM checkpoint_link WHERE to_revision > ? AND to_revision <= ? ORDER BY to_revision",
      )
      .all(fromRevision, toRevision);
    let reached = fromRevision;
    for (const link of links) {
      if (Number(link.from_revision) !== reached) return null;
      reached = Number(link.to_revision);
    }
    if (reached !== toRevision) return null;
    const folded = new Map<string, FleetDeltaChange>();
    for (const row of changeRows({ from: fromRevision, to: toRevision })) folded.set(row.change.path, row.change);
    return [...folded.values()].sort((left, right) => left.path.localeCompare(right.path));
  };
  const content = (blob: FleetBlob) => {
    const row = db().prepare("SELECT bytes FROM read_model_blob WHERE sha256 = ?").get(blob.sha256) as
      | { readonly bytes: Uint8Array }
      | undefined;
    const bytes = row
      ? Buffer.from(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength)
      : options.readContentBlob(blob.sha256);
    if (!bytes || bytes.byteLength !== blob.size || sha256Bytes(bytes) !== blob.sha256)
      throw new Error(`canonical content blob ${blob.sha256} is unavailable or corrupt`);
    return bytes;
  };
  return {
    pin: async (key, holderId, from, quota, leaseRoot) => {
      const store = db();
      initializeRetention(store);
      let target!: SnapshotCut;
      let lease: ReplicaDeliveryLease | null = null;
      try {
        transact(store, () => {
          // The owner acquires the lease after its queue, in the same operation as target selection and pinning.
          lease = leaseStore(leaseRoot).delivery.claim(key, holderId, Date.now(), 30_000);
          if (!lease)
            throw new FleetFault(
              "replica_delivery_busy",
              "This node/repository already has an active delivery lease",
              true,
            );
          const latestCut = latest();
          if (!latestCut) throw new FleetFault("replica_pending", "No checkpoint is published.");
          target = latestCut;
          const pinFrom = from !== null && cut(from) ? from : target.revision;
          let oldest = pinFrom;
          for (const pin of store.prepare("SELECT * FROM delivery_pin").all()) {
            const held = JSON.parse(String(pin.lease_json)) as ReplicaDeliveryLease;
            if (liveLease(held, String(pin.lease_root))) oldest = Math.min(oldest, Number(pin.from_revision));
          }
          // Admission may reject the newcomer, never revoke an already admitted live delivery.
          if (retainedBytes(store, oldest) > quota)
            throw new FleetFault(
              "replica_quota_insufficient",
              "Shared checkpoint content exceeds delivery retention quota.",
            );
          store
            .prepare("INSERT OR REPLACE INTO delivery_pin VALUES (?, ?, ?, ?, ?, ?, NULL)")
            .run(pinId(lease), JSON.stringify(lease), leaseRoot, pinFrom, target.revision, quota);
          return [];
        });
      } catch (error) {
        if (lease) leaseStore(leaseRoot).delivery.release(lease);
        throw error;
      }
      return { cut: target, lease: lease! };
    },
    releasePin: (lease) => {
      const deleted = db().prepare("DELETE FROM delivery_pin WHERE id=?").run(pinId(lease));
      if (Number(deleted.changes) > 0)
        console.info(
          "[fleet-center] pin-release",
          JSON.stringify({
            event: "replica_pin_released",
            reason: "delivery_released",
            now: Date.now(),
            requested: lease,
          }),
        );
    },
    pinActive: (lease) => !!db().prepare("SELECT 1 FROM delivery_pin WHERE id=?").get(pinId(lease)),
    activate,
    prepare: async () => activate(),
    delivery: {
      manifestPage: async (revision, offset) => manifestPage(revision, offset),
      manifestEntry: async (revision, entryPath) => manifestEntry(revision, entryPath),
      changes: async (from, to) => changes(from, to),
      content: async (blob) => content(blob),
    },
    ledgerCut: () => options.readLedgerCut?.() ?? null,
    exactRevision,
    kick,
    waitForCut,
    latest,
    cut,
    eventAt,
    receiptBasis,
    manifest,
    manifestPage,
    manifestEntry,
    changes,
    changeLog,
    content,
    close: () => {
      closed = true;
      for (const row of [...waiters.values()].flat()) row.reject(new Error("replica cut source is closed"));
      waiters.clear();
      for (const authority of leaseStores.values()) authority.close();
      leaseStores.clear();
      database?.close();
      database = null;
    },
  };
}
