import { READ_MODEL_SCHEMA_GENERATION, runtimeEventContentClaims } from "@harness-anything/kernel";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
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
import { writeFileDurably } from "../durable-file.ts";

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
export interface ReplicaCutSource {
  readonly activate: () => SnapshotCut | null;
  readonly prepare: () => Promise<SnapshotCut | null>;
  readonly delivery: {
    readonly manifest: (revision: number) => Promise<readonly FleetEntry[] | null>;
    readonly changes: (from: number, to: number) => Promise<readonly FleetDeltaChange[] | null>;
    readonly content: (blob: FleetBlob) => Promise<Uint8Array>;
  };
  readonly ledgerCut: () => LedgerCutIdentity | null;
  readonly exactRevision: () => number | null;
  readonly kick: () => void;
  readonly waitForCut: (revision: number) => Promise<SnapshotCut>;
  readonly latest: () => SnapshotCut | null;
  readonly cut: (revision: number) => SnapshotCut | null;
  readonly eventAt: (revision: number) => string | null;
  readonly receiptBasis: (opId: string) => { readonly event: CanonicalEventV1; readonly applied: boolean } | null;
  readonly manifest: (revision: number) => readonly FleetEntry[] | null;
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
  readonly monotonicNow?: () => number;
  /** The edge read model at the projection's current revision, or null while it is not ready. */
  readonly readEdgeReadModel?: () => {
    readonly sourceRevision: number;
    readonly rootThreshold: number;
    readonly rows: EdgeReadModelRows;
  } | null;
}

export function openReplicaCutSource(options: ReplicaCutSourceOptions): ReplicaCutSource {
  if (!/^[A-Za-z0-9_-]{1,96}$/u.test(options.repoId)) throw new Error("replica repo id is invalid");
  const root = path.join(options.localRoot, "replica", "repos", options.repoId, `g${READ_MODEL_SCHEMA_GENERATION}`),
    // A schema upgrade publishes a new derived namespace at the same canonical head.
    databasePath = path.join(root, "cuts.sqlite"),
    manifestRoot = path.join(root, "manifests", "sha256"),
    monotonicNow = options.monotonicNow ?? (() => performance.now());
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
      "CREATE TABLE IF NOT EXISTS cut (repo_id TEXT NOT NULL, revision INTEGER PRIMARY KEY, head_digest TEXT NOT NULL, manifest_digest TEXT NOT NULL, entry_count INTEGER NOT NULL, total_bytes INTEGER NOT NULL, event_occurred_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS change (repo_id TEXT NOT NULL, from_revision INTEGER NOT NULL, to_revision INTEGER NOT NULL, path TEXT NOT NULL, op TEXT NOT NULL, blob_sha256 TEXT, size INTEGER, media_type TEXT, PRIMARY KEY(repo_id, from_revision, to_revision, path));",
    );
    return database;
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
  const manifestPath = (digest: string) => path.join(manifestRoot, digest.slice(0, 2), digest);
  const manifest = (revision: number) => {
    const row = db().prepare("SELECT manifest_digest FROM cut WHERE revision = ?").get(revision) as
      | { readonly manifest_digest: string }
      | undefined;
    if (!row) return null;
    const bytes = readFileSync(manifestPath(row.manifest_digest), "utf8");
    if (sha256Text(bytes) !== row.manifest_digest)
      throw new Error(`replica manifest ${row.manifest_digest} is corrupt`);
    return JSON.parse(bytes) as FleetEntry[];
  };
  const writeManifest = (manifest: { readonly bytes: string; readonly digest: string }) => {
    const target = manifestPath(manifest.digest);
    if (existsSync(target)) {
      if (readFileSync(target, "utf8") !== manifest.bytes)
        throw new Error(`replica manifest CAS collision ${manifest.digest}`);
      return;
    }
    writeFileDurably(target, manifest.bytes);
  };
  const prune = (store: DatabaseSync) => {
    const retained = store
        .prepare("SELECT revision FROM cut ORDER BY revision DESC LIMIT 64")
        .all() as unknown as readonly { readonly revision: number }[],
      oldest = retained.at(-1)?.revision;
    if (oldest === undefined) return [] as string[];
    const digests = (
      store.prepare("SELECT DISTINCT manifest_digest FROM cut WHERE revision < ?").all(oldest) as unknown as readonly {
        readonly manifest_digest: string;
      }[]
    ).map((row) => row.manifest_digest);
    store.prepare("DELETE FROM cut WHERE revision < ?").run(oldest);
    store.prepare("DELETE FROM change WHERE from_revision < ?").run(oldest);
    return digests;
  };
  // Cut rows are inserted inside the caller's round transaction; manifest files
  // for pruned digests are unlinked only after that transaction commits, so a
  // rollback restores rows whose files are still on disk.
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
    insertCut.run(
      options.repoId,
      event.workspaceRevision,
      headDigest,
      digest,
      entries.length,
      entries.reduce((sum, entry) => sum + entry.blob.size, 0),
      event.occurredAt,
    );
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
    try {
      const pruned = body();
      store.exec("COMMIT");
      return pruned;
    } catch (error) {
      try {
        store.exec("ROLLBACK");
      } catch (rollbackError) {
        consumeKnownError(rollbackError);
      }
      throw error;
    }
  };
  const unlinkOrphanManifests = (store: DatabaseSync, digests: readonly string[]): void => {
    for (const orphan of digests)
      if (
        !store.prepare("SELECT 1 FROM cut WHERE manifest_digest = ? LIMIT 1").get(orphan) &&
        existsSync(manifestPath(orphan))
      )
        unlinkSync(manifestPath(orphan));
    if (digests.length === 0 || !existsSync(readModelBlobRoot)) return;
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
    for (const retained of store.prepare("SELECT revision FROM cut").all())
      for (const entry of manifest(Number(retained.revision)) ?? [])
        if (isReadModelPath(entry.path)) live.add(entry.blob.sha256);
    for (const name of readdirSync(readModelBlobRoot)) if (!live.has(name)) unlinkSync(readModelBlobPath(name));
  };
  const persistInitial = (event: CanonicalEventV1, entries: readonly FleetEntry[]): SnapshotCut => {
    const bytes = stableStringify(entries),
      digest = sha256Text(bytes),
      store = db();
    let cut!: SnapshotCut;
    const pruned = transact(store, () => {
      const persisted = persistCut(store, event, entries, null, digest);
      cut = persisted.cut;
      writeManifest({ bytes, digest });
      return persisted.pruned;
    });
    unlinkOrphanManifests(store, pruned);
    return cut;
  };
  const entriesFrom = (basis: ReplicaProjectionBasis) =>
    basis.documents
      .map(({ path: itemPath, blobSha256, size, mediaType }) => ({
        path: itemPath,
        blob: { sha256: blobSha256, size, mediaType },
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
  // The edge task read model rides the cut as derived entries under .read-model/: one file per task
  // row, so the existing delta protocol moves only changed rows. Its bytes are not canonical content
  // blobs; they live beside the cut store and are reclaimed with the cuts that reference them.
  const readModelBlobRoot = path.join(root, "read-model-blobs"),
    readModelBlobPath = (sha256: string) => path.join(readModelBlobRoot, sha256);
  const readModelEntry = (entryPath: string, text: string, mediaType: string): FleetEntry => {
    const body = Buffer.from(text),
      sha256 = sha256Bytes(body);
    if (!existsSync(readModelBlobPath(sha256))) writeFileDurably(readModelBlobPath(sha256), body);
    return { path: entryPath, blob: { sha256, size: body.byteLength, mediaType } };
  };
  const withReadModel = (entries: FleetEntry[], revision: number): FleetEntry[] => {
    const model = options.readEdgeReadModel?.();
    if (!options.readEdgeReadModel) return entries;
    if (!model || model.sourceRevision !== revision)
      throw new Error(`Read model is unavailable at revision ${revision}`);
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
        if (detail?.startsWith("artifact:runtime-result/")) requireResult(detail);
      }
      if (event.schema !== "agent-runtime-event/v1" || event.type !== "runtime_session_outcome_observed") continue;
      requireResult(event.payload.resultRef);
      if (event.payload.result === null) unavailable.add(event.payload.resultRef);
      for (const claim of runtimeEventContentClaims(event)) {
        const bytes = options.readContentBlob(claim.sha256);
        if (!bytes || bytes.byteLength !== claim.size || sha256Bytes(bytes) !== claim.sha256)
          throw new Error(`Runtime result ${claim.sha256} is unavailable at revision ${revision}`);
        if (!existsSync(readModelBlobPath(claim.sha256))) writeFileDurably(readModelBlobPath(claim.sha256), bytes);
        results.set(claim.sha256, {
          path: `.read-model/runtime-results/${claim.sha256}`,
          blob: { sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType },
        });
      }
    }
    for (const ref of requiredResults) {
      const digest = /^artifact:runtime-result\/sha256\/([a-f0-9]{64})$/u.exec(ref)?.[1];
      if (digest && !results.has(digest) && unavailable.has(ref) && options.readContentBlob(digest) === null) {
        unavailableEntries.push(
          readModelEntry(
            `.read-model/runtime-results-unavailable/${digest}`,
            stableStringify({ resultRef: ref, availability: "unavailable", downloadable: false }),
            "application/json",
          ),
        );
        continue;
      }
      if (!digest || !results.has(digest))
        throw new Error(`Runtime result ${ref} has no content claim at revision ${revision}`);
    }
    return [
      ...ciDetails,
      ...unavailableEntries,
      ...results.values(),
      ...entries.filter((entry) => !isReadModelPath(entry.path)),
      ...edgeReadModelEntries({
        sourceRevision: revision,
        rootThreshold: model.rootThreshold,
        rows: {
          ...model.rows,
          repository: model.rows.repository.map((row) => {
            if (row.table !== "runtime_session") return row;
            const session = JSON.parse(String(row.values.value_json)) as { resultRef?: string };
            if (!session.resultRef || !unavailable.has(session.resultRef)) return row;
            const digest = session.resultRef.split("/").at(-1)!;
            if (results.has(digest)) return row;
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
          }),
        },
      }).map((entry) => readModelEntry(entry.path, entry.text, "application/json")),
    ].sort((left, right) => left.path.localeCompare(right.path));
  };
  const documentDigest = (entries: readonly FleetEntry[]) =>
    fleetManifestDigest(entries.filter((entry) => !isReadModelPath(entry.path)));
  const nextEntries = (prior: readonly FleetEntry[], event: CanonicalEventV1) => {
    const entries = new Map(prior.map((entry) => [entry.path, entry]));
    for (const retirement of canonicalDocumentRetirements(event)) entries.delete(retirement.path);
    for (const claim of canonicalDocumentClaims(event))
      entries.set(claim.path, {
        path: claim.path,
        blob: { sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType },
      });
    return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
  };
  const settle = (cut: SnapshotCut) => {
    const rows = waiters.get(cut.revision);
    if (!rows) return;
    waiters.delete(cut.revision);
    for (const row of rows) row.resolve(cut);
  };
  const readSnapshot = options.withReadSnapshot ?? (<T>(read: () => T): T => read());
  const buildRound = () => {
    const initial = latest();
    if (!initial) {
      const basis = options.readBasis(null);
      if (basis.watermark === 0 || basis.watermark !== basis.sourceRevision || !basis.headEvent) return false;
      const first = persistInitial(basis.headEvent, withReadModel(entriesFrom(basis), basis.watermark));
      settle(first);
      return false;
    }
    const published = initial,
      basis = options.readBasis(published.revision),
      started = monotonicNow(),
      store = db();
    let entries = manifest(published.revision)!,
      current: SnapshotCut = published,
      processed = 0;
    const settled: SnapshotCut[] = [],
      pruned: string[] = [];
    // One transaction drains the whole round: each commit under the old
    // rollback journal paid its own journal fsync chain per event. Waiters are
    // settled only after the commit, so a rolled-back round resolves nobody.
    // Manifest files stay per-revision because delta offers address any
    // retained revision, not only round-final ones.
    transact(store, () => {
      for (const event of basis.events) {
        if (processed > 0 && monotonicNow() - started >= 100) break;
        if (event.workspaceRevision !== current.revision + 1)
          throw new Error(`replica cut gap after ${current.revision}`);
        const before = entries;
        entries = nextEntries(entries, event);
        if (event.workspaceRevision === basis.watermark) entries = withReadModel(entries, event.workspaceRevision);
        if (
          event.workspaceRevision === basis.watermark &&
          documentDigest(entries) !== documentDigest(entriesFrom(basis))
        )
          throw new Error(`replica manifest drift at revision ${event.workspaceRevision}`);
        const bytes = stableStringify(entries),
          digest = sha256Text(bytes),
          manifest = { bytes, digest };
        writeManifest(manifest);
        const persisted = persistCut(store, event, entries, { revision: current.revision, entries: before }, digest);
        current = persisted.cut;
        settled.push(persisted.cut);
        pruned.push(...persisted.pruned);
        processed += 1;
      }
      return pruned;
    });
    unlinkOrphanManifests(store, pruned);
    for (const cut of settled) settle(cut);
    return current.revision < basis.watermark;
  };
  const runRound = () => readSnapshot(buildRound);
  const waiters = new Map<
    number,
    Array<{ readonly resolve: (cut: SnapshotCut) => void; readonly reject: (error: unknown) => void }>
  >();
  const activateSnapshot = () => {
    active = true;
    const current = latest();
    if (current) {
      kick();
      return current;
    }
    const basis = options.readBasis(null),
      cut =
        basis.watermark > 0 && basis.watermark === basis.sourceRevision && basis.headEvent
          ? persistInitial(basis.headEvent, withReadModel(entriesFrom(basis), basis.watermark))
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
        if (runRound()) kick();
      } catch (error) {
        consumeKnownError(error);
        const pending = [...waiters.values()].flat();
        waiters.clear();
        for (const row of pending) row.reject(error);
      }
    });
  };
  const waitForCut = (revision: number) => {
    const row = cutFrom(
      db().prepare("SELECT * FROM cut WHERE revision = ?").get(revision) as Record<string, unknown> | undefined,
    );
    if (row) return Promise.resolve(row);
    const promise = new Promise<SnapshotCut>((resolve, reject) => {
      const rows = waiters.get(revision) ?? [];
      rows.push({ resolve, reject });
      waiters.set(revision, rows);
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
    const cuts = db()
      .prepare("SELECT revision FROM cut WHERE revision >= ? AND revision <= ? ORDER BY revision")
      .all(fromRevision, toRevision) as unknown as readonly { readonly revision: number }[];
    if (
      cuts.length !== toRevision - fromRevision + 1 ||
      cuts.some((cut, index) => cut.revision !== fromRevision + index)
    )
      return null;
    const folded = new Map<string, FleetDeltaChange>();
    for (const row of changeRows({ from: fromRevision, to: toRevision })) folded.set(row.change.path, row.change);
    return [...folded.values()].sort((left, right) => left.path.localeCompare(right.path));
  };
  const content = (blob: FleetBlob) => {
    const bytes = existsSync(readModelBlobPath(blob.sha256))
      ? readFileSync(readModelBlobPath(blob.sha256))
      : options.readContentBlob(blob.sha256);
    if (!bytes || bytes.byteLength !== blob.size || sha256Bytes(bytes) !== blob.sha256)
      throw new Error(`canonical content blob ${blob.sha256} is unavailable or corrupt`);
    return bytes;
  };
  return {
    activate,
    prepare: async () => activate(),
    delivery: {
      manifest: async (revision) => manifest(revision),
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
    changes,
    changeLog,
    content,
    close: () => {
      closed = true;
      for (const row of [...waiters.values()].flat()) row.reject(new Error("replica cut source is closed"));
      waiters.clear();
      database?.close();
      database = null;
    },
  };
}
