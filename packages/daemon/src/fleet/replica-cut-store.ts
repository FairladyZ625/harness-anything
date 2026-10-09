import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  READ_MODEL_SCHEMA_GENERATION,
  consumeKnownError,
  sha256Bytes,
  sha256Text,
  stableStringify,
  serializePersistedCanonicalEvent,
  updateReplicaManifestDigest,
  type ReplicaSequenceRead,
  type ReplicaRevision,
  type CanonicalEventV1,
  type LedgerCutIdentity,
} from "@harness-anything/kernel";
import { openReplicaAckStore, type ReplicaDeliveryKey } from "./replica-ack-store.ts";
import type { ReplicaDeliveryLease } from "./replica-delivery-lease.ts";
import { FleetFault } from "./center-types.ts";
import type { FleetBlob, FleetDeltaChange, FleetEntry, FleetManifest } from "./contract.ts";

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
export interface ReplicaChanges {
  readonly count: number;
  readonly totalBytes: number;
  readonly page: (after: readonly [number, number] | null) => {
    readonly changes: readonly FleetDeltaChange[];
    readonly cursor: readonly [number, number] | null;
    readonly done: boolean;
  };
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
    readonly manifestPage: (revision: number, afterPath: string) => Promise<ReplicaManifestPage | null>;
    readonly manifestEntry: (revision: number, path: string) => Promise<FleetEntry | null>;
    readonly changes: (from: number, to: number) => Promise<ReplicaChanges | null>;
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
  readonly manifestPage: (revision: number, afterPath: string) => ReplicaManifestPage | null;
  readonly manifestEntry: (revision: number, path: string) => FleetEntry | null;
  readonly changes: (fromRevision: number, toRevision: number) => ReplicaChanges | null;
  readonly changeLog: () => readonly ReplicaChangeLogEntry[];
  readonly content: (blob: FleetBlob) => Uint8Array;
  readonly close: () => void;
}
export interface ReplicaCutSourceOptions {
  readonly repoId: string;
  readonly localRoot: string;
  readonly readSequence: <A>(from: number | null, read: (sequence: ReplicaSequenceRead | null) => A) => A;
  readonly readRevision: (revision?: number) => ReplicaRevision | null;
  readonly readLedgerCut?: () => LedgerCutIdentity;
  readonly readContentBlob: (sha256: string) => Uint8Array | null;
  readonly readEvent?: (opId: string) => CanonicalEventV1 | null;
  readonly readApplied?: (opId: string) => { readonly event: CanonicalEventV1; readonly watermark: number } | null;
}

export function openReplicaCutSource(options: ReplicaCutSourceOptions): ReplicaCutSource {
  if (!/^[A-Za-z0-9_-]{1,96}$/u.test(options.repoId)) throw new Error("replica repo id is invalid");
  const root = path.join(options.localRoot, "replica", "repos", options.repoId, `g${READ_MODEL_SCHEMA_GENERATION}`);
  let database: DatabaseSync | null = null,
    closed = false,
    active = false,
    scheduled = false;
  const db = () => {
    if (closed) throw new Error("replica cut source is closed");
    if (database) return database;
    mkdirSync(root, { recursive: true });
    database = new DatabaseSync(path.join(root, "checkpoints.sqlite"));
    database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS cut (revision INTEGER PRIMARY KEY, head_digest TEXT NOT NULL, manifest_digest TEXT NOT NULL, entry_count INTEGER NOT NULL, total_bytes INTEGER NOT NULL, occurred_at TEXT NOT NULL, root_revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS entry (revision INTEGER NOT NULL, path TEXT NOT NULL, entry_json TEXT, end_revision INTEGER, blob_sha256 TEXT, PRIMARY KEY(path,revision));
      CREATE INDEX IF NOT EXISTS entry_revision ON entry(revision);
      CREATE INDEX IF NOT EXISTS entry_retired ON entry(end_revision) WHERE end_revision IS NOT NULL;
      CREATE INDEX IF NOT EXISTS entry_blob ON entry(blob_sha256);
      CREATE TABLE IF NOT EXISTS content (sha256 TEXT PRIMARY KEY, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS link (to_revision INTEGER PRIMARY KEY, from_revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS delivery_pin (id TEXT PRIMARY KEY, lease_json TEXT NOT NULL, lease_root TEXT NOT NULL, from_revision INTEGER NOT NULL, to_revision INTEGER NOT NULL, quota INTEGER NOT NULL, remaining INTEGER);
      CREATE TABLE IF NOT EXISTS retention_blob (sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, refs INTEGER NOT NULL, last_revision INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS retention_retired ON retention_blob(refs,last_revision);
      CREATE TABLE IF NOT EXISTS retention_total (revision INTEGER PRIMARY KEY, bytes INTEGER NOT NULL);
      CREATE TEMP TABLE retention_delta (sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, refs INTEGER NOT NULL);
      CREATE TEMP TABLE retired_content (sha256 TEXT PRIMARY KEY);`);
    return database;
  };
  // Buffer deletion evidence until its checkpoint transaction commits, never log rolled-back releases.
  const pinReleaseLogs: string[] = [];
  const transact = <T>(body: () => T): T => {
    const store = db();
    store.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = body();
      store.exec("COMMIT");
    } catch (error) {
      pinReleaseLogs.length = 0;
      store.exec("ROLLBACK");
      throw error;
    }
    for (const entry of pinReleaseLogs.splice(0)) console.info("[fleet-center] pin-release", entry);
    return result;
  };
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
  const latest = () => cutFrom(db().prepare("SELECT * FROM cut ORDER BY revision DESC LIMIT 1").get());
  const cut = (revision: number) => cutFrom(db().prepare("SELECT * FROM cut WHERE revision=?").get(revision));
  const eventAt = (revision: number) => {
    const row = db().prepare("SELECT occurred_at FROM cut WHERE revision=?").get(revision);
    return row ? String(row.occurred_at) : null;
  };
  const entryAt = (revision: number, itemPath: string): FleetEntry | null => {
    const target = db().prepare("SELECT root_revision FROM cut WHERE revision=?").get(revision);
    if (!target) return null;
    const row = db()
      .prepare(
        "SELECT entry_json FROM entry WHERE path=? AND revision<=? AND revision>=? ORDER BY revision DESC LIMIT 1",
      )
      .get(itemPath, revision, target.root_revision);
    return row?.entry_json ? (JSON.parse(String(row.entry_json)) as FleetEntry) : null;
  };
  const manifestPage = (revision: number, afterPath: string): ReplicaManifestPage | null => {
    if (!cut(revision)) return null;
    const target = db().prepare("SELECT root_revision FROM cut WHERE revision=?").get(revision)!;
    // Seek the existing path primary key; revision-index scans would sort the full cut per page.
    const rows = db()
      .prepare(
        `SELECT entry_json FROM entry e INDEXED BY sqlite_autoindex_entry_1 WHERE path>? AND revision<=? AND revision>=? AND (end_revision IS NULL OR end_revision>?) AND entry_json IS NOT NULL ORDER BY path LIMIT 129`,
      )
      .all(afterPath, revision, target.root_revision, revision);
    return {
      entries: rows.slice(0, 128).map((row) => JSON.parse(String(row.entry_json)) as FleetEntry),
      done: rows.length <= 128,
    };
  };
  const manifest = (revision: number): FleetEntry[] | null => {
    if (!cut(revision)) return null;
    const entries: FleetEntry[] = [];
    for (;;) {
      const page = manifestPage(revision, entries.at(-1)?.path ?? "")!;
      entries.push(...page.entries);
      if (page.done) return entries;
    }
  };
  const authorities = new Map<string, ReturnType<typeof openReplicaAckStore>>();
  const authority = (leaseRoot: string) => {
    let store = authorities.get(leaseRoot);
    if (!store) {
      store = openReplicaAckStore(leaseRoot);
      authorities.set(leaseRoot, store);
    }
    return store;
  };
  const pinId = (lease: ReplicaDeliveryLease) =>
    JSON.stringify([lease.nodeId, lease.viewId, lease.holderId, lease.claimFence]);
  const live = (lease: ReplicaDeliveryLease, leaseRoot: string) => {
    const current = authority(leaseRoot).delivery.active(lease, Date.now());
    return current?.holderId === lease.holderId && current.claimFence === lease.claimFence;
  };
  const retainedBytes = (store: DatabaseSync, from: number): number =>
    Number(store.prepare("SELECT bytes FROM retention_total WHERE revision = ?").get(from)!.bytes);
  const accountRetention = (store: DatabaseSync, revision: number, previousRevision: number | null) => {
    const delta = Number(
      store
        .prepare(
          `SELECT COALESCE(SUM(CASE
      WHEN COALESCE(b.refs,0)=0 THEN d.size
      WHEN b.refs+d.refs=0 THEN -d.size ELSE 0 END),0) AS bytes
      FROM retention_delta d LEFT JOIN retention_blob b USING(sha256) WHERE d.refs != 0`,
        )
        .get()!.bytes,
    );
    const headBytes = (previousRevision === null ? 0 : retainedBytes(store, previousRevision)) + delta;
    // Returning blobs are already charged to suffixes that include their last appearance.
    store.exec(`UPDATE retention_total SET bytes=bytes+COALESCE((
      SELECT SUM(d.size) FROM retention_delta d LEFT JOIN retention_blob b USING(sha256)
      WHERE d.refs != 0 AND COALESCE(b.refs,0)=0
        AND retention_total.revision>COALESCE(b.last_revision,0)),0)`);
    store
      .prepare(
        `INSERT INTO retention_blob
      SELECT d.sha256,d.size,COALESCE(b.refs,0)+d.refs,
        CASE WHEN COALESCE(b.refs,0)+d.refs=0 THEN ? ELSE ? END
      FROM retention_delta d LEFT JOIN retention_blob b USING(sha256) WHERE d.refs != 0
      ON CONFLICT(sha256) DO UPDATE SET refs=excluded.refs,last_revision=excluded.last_revision`,
      )
      .run(previousRevision, revision);
    store.prepare("INSERT INTO retention_total VALUES (?, ?)").run(revision, headBytes);
  };
  const prune = () => {
    const store = db();
    let oldest = Number(
      store
        .prepare("SELECT MIN(revision) AS revision FROM (SELECT revision FROM cut ORDER BY revision DESC LIMIT 64)")
        .get()!.revision,
    );
    for (const pin of store.prepare("SELECT * FROM delivery_pin").all()) {
      const lease = JSON.parse(String(pin.lease_json)) as ReplicaDeliveryLease;
      const cursor = authority(String(pin.lease_root)).cursor(lease);
      const acknowledged = cursor?.revision === Number(pin.to_revision);
      const remaining = pin.remaining === null ? 64 : Number(pin.remaining) - 1;
      const from = acknowledged ? cursor.revision : Number(pin.from_revision);
      const observed = acknowledged ? null : authority(String(pin.lease_root)).delivery.inspect(lease, Date.now());
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
        const evidence = observed ?? authority(String(pin.lease_root)).delivery.inspect(lease, Date.now());
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
          .prepare("UPDATE delivery_pin SET remaining=?,from_revision=? WHERE id=?")
          .run(remaining, from, String(pin.id));
      oldest = Math.min(oldest, from);
    }
    store.prepare("DELETE FROM cut WHERE revision<?").run(oldest);
    store.prepare("DELETE FROM link WHERE from_revision<?").run(oldest);
    store.prepare("DELETE FROM retention_total WHERE revision<?").run(oldest);
    store.prepare("DELETE FROM retention_blob WHERE refs=0 AND last_revision<?").run(oldest);
    store.prepare("DELETE FROM entry WHERE entry_json IS NULL AND revision<?").run(oldest);
    store.exec("DELETE FROM retired_content");
    store
      .prepare(
        "INSERT INTO retired_content SELECT DISTINCT blob_sha256 FROM entry WHERE end_revision<=? AND blob_sha256 IS NOT NULL",
      )
      .run(oldest);
    store.prepare("DELETE FROM entry WHERE end_revision<=?").run(oldest);
    store.exec(`DELETE FROM content WHERE sha256 IN (SELECT sha256 FROM retired_content)
      AND NOT EXISTS (SELECT 1 FROM entry WHERE blob_sha256=content.sha256)`);
  };
  const waiters = new Map<number, Set<{ resolve: (cut: SnapshotCut) => void; reject: (error: unknown) => void }>>();
  const publish = () => {
    const capturedFrom = latest();
    const write = (captured: ReplicaSequenceRead | null): SnapshotCut | null => {
      if (!captured) return capturedFrom;
      return transact(() => {
        const current = latest();
        if (current && current.revision >= captured.to.revision) return current;
        const prior = captured.from === null ? null : current;
        const sequence = captured;
        const store = db();
        const retention = store.prepare(`INSERT INTO retention_delta VALUES (?,?,?)
        ON CONFLICT(sha256) DO UPDATE SET refs=refs+excluded.refs`),
          writeContent = store.prepare("INSERT OR IGNORE INTO content VALUES (?,?)"),
          retireEntry = store.prepare("UPDATE entry SET end_revision=? WHERE path=? AND end_revision IS NULL"),
          writeEntry = store.prepare("INSERT INTO entry VALUES (?,?,?,NULL,?)"),
          readEntry = store.prepare(
            "SELECT entry_json FROM entry WHERE path=? AND revision<=? AND revision>=? ORDER BY revision DESC LIMIT 1",
          );
        const rootRevision = prior
          ? Number(store.prepare("SELECT root_revision FROM cut WHERE revision=?").get(prior.revision)!.root_revision)
          : sequence.to.revision;
        store.exec("DELETE FROM retention_delta");
        if (!prior && current)
          for (const row of db()
            .prepare("SELECT entry_json FROM entry WHERE end_revision IS NULL AND entry_json IS NOT NULL")
            .iterate()) {
            const blob = (JSON.parse(String(row.entry_json)) as FleetEntry).blob;
            retention.run(blob.sha256, blob.size, -1);
          }
        if (!prior)
          db().prepare("UPDATE entry SET end_revision=? WHERE end_revision IS NULL").run(sequence.to.revision);
        let digest = prior?.manifest.digest ?? "0".repeat(64),
          count = prior?.manifest.entryCount ?? 0,
          total = prior?.manifest.totalBytes ?? 0;
        for (const change of sequence.changes) {
          const row = prior && readEntry.get(change.path, prior.revision, rootRevision);
          const before = row?.entry_json ? (JSON.parse(String(row.entry_json)) as FleetEntry) : null;
          if (before) {
            retention.run(before.blob.sha256, before.blob.size, -1);
            digest = updateReplicaManifestDigest(digest, before);
            count--;
            total -= before.blob.size;
          }
          let entry: FleetEntry | null = null;
          if (change.op === "put") {
            const body = change.text === null ? null : Buffer.from(change.text);
            const blob = change.blob ?? {
              sha256: sha256Text(change.text!),
              size: body!.byteLength,
              mediaType: "application/json",
            };
            if (body) writeContent.run(blob.sha256, body);
            entry = { path: change.path, blob };
            retention.run(blob.sha256, blob.size, 1);
            digest = updateReplicaManifestDigest(digest, entry);
            count++;
            total += blob.size;
          }
          retireEntry.run(sequence.to.revision, change.path);
          writeEntry.run(
            sequence.to.revision,
            change.path,
            entry ? stableStringify(entry) : null,
            entry?.blob.sha256 ?? null,
          );
        }
        db()
          .prepare("INSERT INTO cut VALUES (?,?,?,?,?,?,?)")
          .run(
            sequence.to.revision,
            sequence.to.headDigest,
            digest,
            count,
            total,
            sequence.to.occurredAt,
            rootRevision,
          );
        if (prior) db().prepare("INSERT INTO link VALUES (?,?)").run(sequence.to.revision, prior.revision);
        accountRetention(db(), sequence.to.revision, current?.revision ?? null);
        prune();
        return latest();
      });
    };
    const result = options.readSequence(capturedFrom?.revision ?? null, (sequence) =>
      !sequence && capturedFrom ? options.readSequence(null, write) : write(sequence),
    );
    if (result)
      for (const [revision, rows] of waiters)
        if (revision <= result.revision) {
          waiters.delete(revision);
          for (const row of rows) row.resolve(result);
        }
    return result;
  };
  const kick = () => {
    if (!active || scheduled || closed) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (closed) return;
      try {
        publish();
      } catch (error) {
        consumeKnownError(error);
        for (const rows of waiters.values()) for (const row of rows) row.reject(error);
        waiters.clear();
      }
    });
  };
  const activate = () => {
    active = true;
    return publish();
  };
  const continuous = (from: number, to: number): boolean => {
    if (!cut(from) || !cut(to) || from > to) return false;
    let reached = from;
    for (const row of db()
      .prepare("SELECT * FROM link WHERE to_revision>? AND to_revision<=? ORDER BY to_revision")
      .iterate(from, to)) {
      if (Number(row.from_revision) !== reached) return false;
      reached = Number(row.to_revision);
    }
    return reached === to;
  };
  const changes = (from: number, to: number): ReplicaChanges | null => {
    if (!continuous(from, to)) return null;
    const where = "revision>? AND revision<=? AND (end_revision IS NULL OR end_revision>?)";
    const summary = db()
      .prepare(
        `SELECT COUNT(*) AS count,
      COALESCE(SUM(json_extract(entry_json, '$.blob.size')), 0) AS bytes FROM entry WHERE ${where}`,
      )
      .get(from, to, to)!;
    return {
      count: Number(summary.count),
      totalBytes: Number(summary.bytes),
      page: (after) => {
        // The revision index includes rowid: seek it without scanning unrelated paths or
        // keeping a SQLite cursor open while an edge waits on its transport.
        const [revision, rowid] = after ?? [from + 1, 0];
        const rows = db()
          .prepare(
            `SELECT rowid AS entry_id,revision,path,entry_json FROM entry
            WHERE revision=? AND rowid>? AND revision<=? AND (end_revision IS NULL OR end_revision>?)
            UNION ALL SELECT rowid AS entry_id,revision,path,entry_json FROM entry
            WHERE revision>? AND revision<=? AND (end_revision IS NULL OR end_revision>?)
            ORDER BY revision,entry_id LIMIT 129`,
          )
          .all(revision, rowid, to, to, revision, to, to);
        const last = rows[Math.min(rows.length, 128) - 1];
        return {
          changes: rows.slice(0, 128).map((row): FleetDeltaChange => {
            const entry = row.entry_json ? (JSON.parse(String(row.entry_json)) as FleetEntry) : null;
            return entry ? { op: "put", ...entry } : { op: "delete", path: String(row.path) };
          }),
          cursor: last ? [Number(last.revision), Number(last.entry_id)] : null,
          done: rows.length <= 128,
        };
      },
    };
  };
  const content = (blob: FleetBlob) => {
    const row = db().prepare("SELECT bytes FROM content WHERE sha256=?").get(blob.sha256);
    const bytes = row ? Buffer.from(row.bytes as Uint8Array) : options.readContentBlob(blob.sha256);
    if (!bytes || bytes.byteLength !== blob.size || sha256Bytes(bytes) !== blob.sha256)
      throw new Error(`canonical content blob ${blob.sha256} is unavailable or corrupt`);
    return bytes;
  };
  const waitForCut = async (revision: number, signal?: AbortSignal): Promise<SnapshotCut> => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    active = true;
    const current = publish();
    if (current && current.revision >= revision) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const rows = waiters.get(revision) ?? new Set();
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const row = {
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
        rows.delete(row);
        if (!rows.size) waiters.delete(revision);
        row.reject(signal!.reason);
      };
      rows.add(row);
      waiters.set(revision, rows);
      signal?.addEventListener("abort", abort, { once: true });
      kick();
    });
  };
  const pin = async (
    key: ReplicaDeliveryKey,
    holderId: string,
    from: number | null,
    quota: number,
    leaseRoot: string,
  ) => {
    active = true;
    if (from !== null) publish();
    let lease: ReplicaDeliveryLease | null = null;
    try {
      const target = transact(() => {
        // Publication precedes the lease: only active delivery work consumes its unchanged TTL.
        lease = authority(leaseRoot).delivery.claim(key, holderId, Date.now(), 30_000);
        if (!lease)
          throw new FleetFault(
            "replica_delivery_busy",
            "This node/repository already has an active delivery lease",
            true,
          );
        const target = latest();
        if (!target) throw new FleetFault("replica_pending", "No checkpoint is published.");
        const pinFrom = from !== null && continuous(from, target.revision) ? from : target.revision;
        let oldest = pinFrom;
        for (const pin of db().prepare("SELECT * FROM delivery_pin").all()) {
          const held = JSON.parse(String(pin.lease_json)) as ReplicaDeliveryLease;
          if (live(held, String(pin.lease_root))) oldest = Math.min(oldest, Number(pin.from_revision));
        }
        if (retainedBytes(db(), oldest) > quota)
          throw new FleetFault(
            "replica_quota_insufficient",
            "Shared checkpoint content exceeds delivery retention quota.",
          );
        db()
          .prepare("INSERT OR REPLACE INTO delivery_pin VALUES (?,?,?,?,?,?,NULL)")
          .run(pinId(lease), JSON.stringify(lease), leaseRoot, pinFrom, target.revision, quota);
        return target;
      });
      return { cut: target, lease: lease! };
    } catch (error) {
      if (lease) authority(leaseRoot).delivery.release(lease);
      throw error;
    }
  };
  return {
    activate,
    prepare: async () => activate(),
    kick,
    latest,
    cut,
    eventAt,
    manifest,
    manifestPage,
    manifestEntry: entryAt,
    changes,
    content,
    waitForCut,
    pin,
    ledgerCut: () => options.readLedgerCut?.() ?? null,
    exactRevision: () => options.readRevision()?.revision ?? null,
    receiptBasis: (opId) => {
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
    },
    changeLog: () => {
      const result: ReplicaChangeLogEntry[] = [];
      for (const row of db().prepare("SELECT * FROM link ORDER BY to_revision").iterate()) {
        const sequence = changes(Number(row.from_revision), Number(row.to_revision));
        if (!sequence) continue;
        let cursor: readonly [number, number] | null = null;
        for (;;) {
          const page = sequence.page(cursor);
          for (const change of page.changes)
            result.push({ fromRevision: Number(row.from_revision), toRevision: Number(row.to_revision), change });
          if (page.done) break;
          cursor = page.cursor;
        }
      }
      return result;
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
    delivery: {
      manifestPage: async (revision, afterPath) => manifestPage(revision, afterPath),
      manifestEntry: async (revision, itemPath) => entryAt(revision, itemPath),
      changes: async (from, to) => changes(from, to),
      content: async (blob) => content(blob),
    },
    close: () => {
      closed = true;
      for (const rows of waiters.values())
        for (const row of rows) row.reject(new Error("replica cut source is closed"));
      waiters.clear();
      for (const store of authorities.values()) store.close();
      database?.close();
      database = null;
    },
  };
}
