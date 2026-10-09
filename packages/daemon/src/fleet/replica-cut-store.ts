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
  readonly readSequence: (from: number | null) => ReplicaSequenceRead | null;
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
      CREATE TABLE IF NOT EXISTS retention_total (revision INTEGER PRIMARY KEY, bytes INTEGER NOT NULL);`);
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
  const manifestPage = (revision: number, offset: number): ReplicaManifestPage | null => {
    if (!cut(revision)) return null;
    const target = db().prepare("SELECT root_revision FROM cut WHERE revision=?").get(revision)!;
    const rows = db()
      .prepare(
        `SELECT entry_json FROM entry e WHERE revision<=? AND revision>=? AND (end_revision IS NULL OR end_revision>?) AND entry_json IS NOT NULL ORDER BY path LIMIT 129 OFFSET ?`,
      )
      .all(revision, target.root_revision, revision, offset);
    return {
      entries: rows.slice(0, 128).map((row) => JSON.parse(String(row.entry_json)) as FleetEntry),
      done: rows.length <= 128,
    };
  };
  const manifest = (revision: number): FleetEntry[] | null => {
    if (!cut(revision)) return null;
    const entries: FleetEntry[] = [];
    for (;;) {
      const page = manifestPage(revision, entries.length)!;
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
  const countRetention = (deltas: Map<string, { size: number; refs: number }>, blob: FleetBlob, refs: number) => {
    const delta = deltas.get(blob.sha256);
    if (delta) delta.refs += refs;
    else deltas.set(blob.sha256, { size: blob.size, refs });
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
    const retired = store
      .prepare("SELECT DISTINCT blob_sha256 FROM entry WHERE end_revision<=? AND blob_sha256 IS NOT NULL")
      .all(oldest);
    store.prepare("DELETE FROM entry WHERE end_revision<=?").run(oldest);
    for (const row of retired)
      store
        .prepare("DELETE FROM content WHERE sha256=? AND NOT EXISTS (SELECT 1 FROM entry WHERE blob_sha256=?)")
        .run(row.blob_sha256, row.blob_sha256);
  };
  const waiters = new Map<number, Set<{ resolve: (cut: SnapshotCut) => void; reject: (error: unknown) => void }>>();
  const publish = () => {
    const capturedFrom = latest();
    let sequence = options.readSequence(capturedFrom?.revision ?? null);
    const full = !capturedFrom || !sequence;
    if (!sequence && capturedFrom) sequence = options.readSequence(null);
    if (!sequence) return capturedFrom;
    const captured = sequence;
    const result = transact(() => {
      const current = latest();
      if (current && current.revision >= captured.to.revision) return current;
      const prior = full ? null : current;
      const sequence = captured;
      const retention = new Map<string, { size: number; refs: number }>();
      if (!prior && current) for (const entry of manifest(current.revision)!) countRetention(retention, entry.blob, -1);
      if (!prior) db().prepare("UPDATE entry SET end_revision=? WHERE end_revision IS NULL").run(sequence.to.revision);
      let digest = prior?.manifest.digest ?? "0".repeat(64),
        count = prior?.manifest.entryCount ?? 0,
        total = prior?.manifest.totalBytes ?? 0;
      for (const change of sequence.changes) {
        const before = prior && entryAt(prior.revision, change.path);
        if (before) {
          countRetention(retention, before.blob, -1);
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
          if (body) db().prepare("INSERT OR IGNORE INTO content VALUES (?,?)").run(blob.sha256, body);
          entry = { path: change.path, blob };
          countRetention(retention, blob, 1);
          digest = updateReplicaManifestDigest(digest, entry);
          count++;
          total += blob.size;
        }
        db()
          .prepare("UPDATE entry SET end_revision=? WHERE path=? AND end_revision IS NULL")
          .run(sequence.to.revision, change.path);
        db()
          .prepare("INSERT INTO entry VALUES (?,?,?,NULL,?)")
          .run(sequence.to.revision, change.path, entry ? stableStringify(entry) : null, entry?.blob.sha256 ?? null);
      }
      const rootRevision = prior
        ? Number(db().prepare("SELECT root_revision FROM cut WHERE revision=?").get(prior.revision)!.root_revision)
        : sequence.to.revision;
      db()
        .prepare("INSERT INTO cut VALUES (?,?,?,?,?,?,?)")
        .run(sequence.to.revision, sequence.to.headDigest, digest, count, total, sequence.to.occurredAt, rootRevision);
      if (prior) db().prepare("INSERT INTO link VALUES (?,?)").run(sequence.to.revision, prior.revision);
      accountRetention(db(), sequence.to.revision, current?.revision ?? null, retention);
      prune();
      return latest();
    });
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
  const changes = (from: number, to: number): FleetDeltaChange[] | null => {
    if (!cut(from) || !cut(to) || from > to) return null;
    let reached = from;
    for (const row of db()
      .prepare("SELECT * FROM link WHERE to_revision>? AND to_revision<=? ORDER BY to_revision")
      .iterate(from, to)) {
      if (Number(row.from_revision) !== reached) return null;
      reached = Number(row.to_revision);
    }
    if (reached !== to) return null;
    const result = new Map<string, FleetDeltaChange>();
    for (const row of db()
      .prepare("SELECT path,entry_json FROM entry WHERE revision>? AND revision<=? ORDER BY revision,path")
      .iterate(from, to)) {
      const entry = row.entry_json ? (JSON.parse(String(row.entry_json)) as FleetEntry) : null;
      result.set(String(row.path), entry ? { op: "put", ...entry } : { op: "delete", path: String(row.path) });
    }
    return [...result.values()];
  };
  const content = (blob: FleetBlob) => {
    const row = db().prepare("SELECT bytes FROM content WHERE sha256=?").get(blob.sha256);
    const bytes = row ? Buffer.from(row.bytes as Uint8Array) : options.readContentBlob(blob.sha256);
    if (!bytes || bytes.byteLength !== blob.size || sha256Bytes(bytes) !== blob.sha256)
      throw new Error(`canonical content blob ${blob.sha256} is unavailable or corrupt`);
    return bytes;
  };
  const waitForCut = (revision: number, signal?: AbortSignal): Promise<SnapshotCut> => {
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
  const pin = async (key: ReplicaDeliveryKey, holderId: string, from: number | null, quota: number, leaseRoot: string) => {
    active = true;
    if (from !== null) publish();
    let lease: ReplicaDeliveryLease | null = null;
    try {
      const target = transact(() => {
        // Publication precedes the lease: only active delivery work consumes its unchanged TTL.
        lease = authority(leaseRoot).delivery.claim(key, holderId, Date.now(), 30_000);
        if (!lease) throw new FleetFault("replica_delivery_busy", "This node/repository already has an active delivery lease", true);
        const target = latest();
        if (!target) throw new FleetFault("replica_pending", "No checkpoint is published.");
        const pinFrom = from !== null && changes(from, target.revision) !== null ? from : target.revision;
        let oldest = pinFrom;
        for (const pin of db().prepare("SELECT * FROM delivery_pin").all()) {
          const held = JSON.parse(String(pin.lease_json)) as ReplicaDeliveryLease;
          if (live(held, String(pin.lease_root))) oldest = Math.min(oldest, Number(pin.from_revision));
        }
        if (retainedBytes(db(), oldest) > quota)
          throw new FleetFault("replica_quota_insufficient", "Shared checkpoint content exceeds delivery retention quota.");
        db().prepare("INSERT OR REPLACE INTO delivery_pin VALUES (?,?,?,?,?,?,NULL)")
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
      for (const row of db().prepare("SELECT * FROM link ORDER BY to_revision").iterate())
        for (const change of changes(Number(row.from_revision), Number(row.to_revision)) ?? [])
          result.push({ fromRevision: Number(row.from_revision), toRevision: Number(row.to_revision), change });
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
      manifestPage: async (revision, offset) => manifestPage(revision, offset),
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
