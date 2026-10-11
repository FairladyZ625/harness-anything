import type { EdgeReaderProfile } from "@harness-anything/kernel";
import { readReplicaHealth, recordReplicaHealth, replicaFailure } from "./replica-health.ts";
import type { FleetCut, FleetEntry, FleetDeltaChange } from "./contract.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  consumeKnownError,
  updateReplicaManifestDigest,
  applyEdgeReadModelEntry,
  canonicalJson,
  classifyTextualArtifactPath,
  createEdgeReadModelTables,
  docByteLength,
  deleteEdgeReadModelEntry,
  DOC_POLICY_ID,
  isReadModelPath,
  parseEdgeReadModelMeta,
  RAW_ARTIFACT_MEDIA_TYPE,
  RAW_ARTIFACT_POLICY_ID,
  READ_MODEL_META_PATH,
  sha256Bytes,
  type DocumentState,
  type EdgeReadModelMeta,
} from "@harness-anything/kernel";
import { writeFileDurably } from "../durable-file.ts";
import type { FleetMirrorView } from "../fleet-edge-mirror.ts";

/** The edge view's materialized read model and its last center head confirmation, beside current.json. */
const READ_MODEL_FILE = "read-model.sqlite";
const HEAD_CONFIRMATION_FILE = "head-confirmation.json";
const READ_DENIED_FILE = "read-denied.json";

export interface HeadConfirmation {
  readonly headRevision: number;
  readonly headDigest: string;
  readonly confirmedAt: number;
}

/** Record the actual known ledger head, independently of the delivered checkpoint revision. */
export function recordHeadConfirmation(viewDir: string, cut: FleetCut, confirmedAt = Date.now()): void {
  writeFileDurably(
    path.join(viewDir, HEAD_CONFIRMATION_FILE),
    JSON.stringify({ headRevision: cut.revision, headDigest: cut.headDigest, confirmedAt }),
  );
  rmSync(path.join(viewDir, READ_DENIED_FILE), { force: true });
  recordReplicaHealth(viewDir, { syncFailure: null });
}

/**
 * The center refused this node's owner the repository: already-delivered rows stop answering locally
 * until a later pull is admitted again. Revocation therefore takes effect at the next sync attempt.
 */
export function recordReadDenied(viewDir: string, deniedAt = Date.now()): void {
  writeFileDurably(path.join(viewDir, READ_DENIED_FILE), JSON.stringify({ deniedAt }));
  rmSync(path.join(viewDir, READ_MODEL_FILE), { force: true });
}

export function isReadDenied(viewDir: string): boolean {
  return existsSync(path.join(viewDir, READ_DENIED_FILE));
}

export function readHeadConfirmation(viewDir: string): HeadConfirmation | null {
  try {
    const value = JSON.parse(readFileSync(path.join(viewDir, HEAD_CONFIRMATION_FILE), "utf8")) as HeadConfirmation;
    if (
      !Number.isSafeInteger(value.headRevision) ||
      value.headRevision < 0 ||
      typeof value.headDigest !== "string" ||
      !value.headDigest ||
      !Number.isSafeInteger(value.confirmedAt)
    )
      throw new Error("Replica head confirmation is malformed");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      consumeKnownError(error);
      return null;
    }
    throw error;
  }
}

export interface EdgeReadModel {
  readonly db: DatabaseSync;
  readonly meta: EdgeReadModelMeta & {
    readonly readerProfile: EdgeReaderProfile | null;
    readonly authorizationShapeDigest: string;
  };
}

/**
 * Opens the view's read model synchronized to its current cut. The SQLite file is a cache of the
 * cut's published rows: it is brought up to the cut by row-blob difference from the verified local
 * CAS — read-model row files into their tables, ledger document entries into the document table —
 * and any damage is repaired by deleting it and rebuilding from the same CAS. Null means the
 * current cut carries no read model (or its bytes are missing locally), which only a pull can fix.
 */
export function openEdgeReadModel(view: FleetMirrorView, casRoot: string): EdgeReadModel | null {
  const file = path.join(view.viewDir, READ_MODEL_FILE);
  const metaBlob = view.entries.get(READ_MODEL_META_PATH);
  if (!metaBlob) {
    recordReplicaHealth(view.viewDir, {
      modelFailure: { code: "replica_model_absent", message: "Current cut carries no read model" },
    });
    return null;
  }
  let meta: EdgeReadModelMeta;
  try {
    const bytes = readFileSync(path.join(casRoot, metaBlob.sha256.slice(0, 2), metaBlob.sha256));
    if (sha256Bytes(bytes) !== metaBlob.sha256) throw new Error(`read model blob ${metaBlob.sha256} is corrupt`);
    meta = parseEdgeReadModelMeta(bytes.toString("utf8"));
  } catch (error) {
    // Deleting SQLite cannot repair the cut's incompatible or missing CAS
    // metadata. Keep the failure visible and leave cache rebuilding alone.
    consumeKnownError(error);
    recordReplicaHealth(view.viewDir, { modelFailure: replicaFailure(error, "read_model_rebuild_failed") });
    return null;
  }
  const open = () => {
    const model = synchronize(file, view, casRoot, meta);
    try {
      recordReplicaHealth(view.viewDir, {
        modelFailure: model ? null : { code: "replica_model_absent", message: "Current cut carries no read model" },
      });
      return model;
    } catch (error) {
      model?.db.close();
      throw error;
    }
  };
  try {
    return open();
  } catch (error) {
    consumeKnownError(error);
    recordReplicaHealth(view.viewDir, {
      rebuildCount: readReplicaHealth(view.viewDir).rebuildCount + 1,
      modelFailure: replicaFailure(error, "read_model_rebuild_failed"),
    });
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  }
  try {
    return open();
  } catch (error) {
    consumeKnownError(error);
    recordReplicaHealth(view.viewDir, { modelFailure: replicaFailure(error, "read_model_rebuild_failed") });
    return null;
  }
}

function synchronize(file: string, view: FleetMirrorView, casRoot: string, meta: EdgeReadModelMeta): EdgeReadModel {
  const blob = (sha256: string) => {
    const bytes = readFileSync(path.join(casRoot, sha256.slice(0, 2), sha256));
    if (sha256Bytes(bytes) !== sha256) throw new Error(`read model blob ${sha256} is corrupt`);
    return bytes;
  };
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    createEdgeReadModelTables(db);
    db.exec(
      `CREATE TABLE IF NOT EXISTS read_model_row (entry_path TEXT PRIMARY KEY, blob_sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS read_model_cut (id INTEGER PRIMARY KEY CHECK(id = 1), manifest_digest TEXT NOT NULL, revision INTEGER NOT NULL, generation INTEGER NOT NULL);`,
    );
    const synced = db.prepare("SELECT * FROM read_model_cut WHERE id = 1").get() as
      | { readonly manifest_digest: string; readonly revision: number; readonly generation: number }
      | undefined;
    if (synced?.manifest_digest !== view.manifestDigest) {
      const changed = synced
        ? edgeChangedPaths(
            view.viewDir,
            { revision: synced.revision, schemaGeneration: synced.generation },
            { revision: view.revision, schemaGeneration: view.schemaGeneration, headDigest: view.headDigest },
          )
        : null;
      const full = changed === null ? new Map(view.entries) : null;
      const paths = changed ?? [
        ...new Set([
          ...full!.keys(),
          ...db
            .prepare("SELECT entry_path FROM read_model_row")
            .all()
            .map((row) => String(row.entry_path)),
        ]),
      ];
      const loaded = db.prepare("SELECT blob_sha256 FROM read_model_row WHERE entry_path=?");
      const upsertRow = db.prepare("INSERT OR REPLACE INTO read_model_row(entry_path, blob_sha256) VALUES (?, ?)"),
        forgetRow = db.prepare("DELETE FROM read_model_row WHERE entry_path = ?"),
        upsertDocument = db.prepare(
          "INSERT OR REPLACE INTO document(path, workspace_revision, value_json) VALUES (?, ?, ?)",
        ),
        forgetDocument = db.prepare("DELETE FROM document WHERE path = ?");
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const entryPath of paths) {
          if (entryPath === READ_MODEL_META_PATH) continue;
          const entry = (full ?? view.entries).get(entryPath);
          if (entry) {
            if (loaded.get(entryPath)?.blob_sha256 === entry.sha256) continue;
            if (
              entryPath.startsWith(".read-model/runtime-results/") ||
              entryPath.startsWith(".read-model/runtime-results-unavailable/") ||
              entryPath.startsWith(".read-model/ci-details/")
            )
              blob(entry.sha256);
            else if (isReadModelPath(entryPath))
              applyEdgeReadModelEntry(db, entryPath, blob(entry.sha256).toString("utf8"));
            else {
              // Ledger documents ride the cut as content entries; their projected DocumentState is
              // rebuilt here from the same bytes the mirror materializes, so decision and closeout
              // reads resolve bodies exactly as the center's own queries do.
              // An artifact's bytes decided text versus raw when the center wrote it; the cut carries
              // that verdict as the entry's media type, so the path alone cannot re-decide it here.
              const policyId =
                entry.mediaType === RAW_ARTIFACT_MEDIA_TYPE
                  ? RAW_ARTIFACT_POLICY_ID
                  : (classifyTextualArtifactPath(entryPath)?.policyId ?? DOC_POLICY_ID);
              const bytes = blob(entry.sha256),
                state: DocumentState = {
                  path: entryPath as DocumentState["path"],
                  blobSha256: entry.sha256,
                  body:
                    policyId === RAW_ARTIFACT_POLICY_ID ? "" : new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                  size: docByteLength(entry.size),
                  mediaType: entry.mediaType,
                  policyId,
                  workspaceRevision: view.revision,
                };
              upsertDocument.run(entryPath, view.revision, canonicalJson(state));
            }
            upsertRow.run(entryPath, entry.sha256);
          } else {
            if (
              entryPath.startsWith(".read-model/runtime-results/") ||
              entryPath.startsWith(".read-model/runtime-results-unavailable/") ||
              entryPath.startsWith(".read-model/ci-details/")
            ) {
              /* CAS entries are retained with their cut. */
            } else if (isReadModelPath(entryPath)) deleteEdgeReadModelEntry(db, entryPath);
            else forgetDocument.run(entryPath);
            forgetRow.run(entryPath);
          }
        }
        db.prepare("INSERT OR REPLACE INTO read_model_cut VALUES (1, ?, ?, ?)").run(
          view.manifestDigest,
          view.revision,
          view.schemaGeneration,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    return {
      db,
      meta: {
        ...meta,
        readerProfile: view.readerProfile,
        authorizationShapeDigest: view.authorizationShapeDigest,
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** A refused node may revoke only its own repository view; other nodes retain their grants. */
export function recordNodeReadDenied(viewRoot: string, repoId: string, nodeId: string): void {
  const views = path.join(viewRoot, "repos", repoId, "views");
  if (!existsSync(views)) return;
  for (const view of readdirSync(views, { withFileTypes: true }))
    if (view.isDirectory() && view.name === nodeId) recordReadDenied(path.join(views, view.name));
}

export interface EdgeManifestHeader {
  readonly cut: FleetCut;
  readonly schemaGeneration: number;
  readonly manifestDigest: string;
}

/** One durable sparse index per repository, shared by its independently published views. */
export function withEdgeManifest<T>(viewDir: string, read: (db: DatabaseSync, viewId: string) => T): T {
  return withEdgeRepository(path.dirname(path.dirname(viewDir)), (db) => read(db, path.basename(viewDir)));
}

function withEdgeRepository<T>(repo: string, read: (db: DatabaseSync) => T): T {
  mkdirSync(repo, { recursive: true });
  const db = new DatabaseSync(path.join(repo, "manifests.sqlite"));
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS edge_cut (view_id TEXT NOT NULL, revision INTEGER NOT NULL, generation INTEGER NOT NULL,
        root_revision INTEGER NOT NULL, header TEXT NOT NULL, PRIMARY KEY(view_id,revision,generation));
      CREATE TABLE IF NOT EXISTS edge_entry (view_id TEXT NOT NULL, path TEXT NOT NULL, revision INTEGER NOT NULL,
        generation INTEGER NOT NULL, end_revision INTEGER, blob_json TEXT, sha256 TEXT,
        PRIMARY KEY(view_id,path,revision,generation));
      CREATE INDEX IF NOT EXISTS edge_entry_revision ON edge_entry(view_id,generation,revision);
      CREATE INDEX IF NOT EXISTS edge_entry_end ON edge_entry(view_id,generation,end_revision);
      CREATE INDEX IF NOT EXISTS edge_entry_blob ON edge_entry(sha256);
      CREATE TABLE IF NOT EXISTS edge_content (sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS edge_content_usage (id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS edge_orphan (sha256 TEXT PRIMARY KEY);
      CREATE TRIGGER IF NOT EXISTS edge_content_added AFTER INSERT ON edge_content BEGIN
        UPDATE edge_content_usage SET bytes=bytes+NEW.size WHERE id=1;
        INSERT OR IGNORE INTO edge_orphan SELECT NEW.sha256 WHERE NOT EXISTS
          (SELECT 1 FROM edge_entry WHERE sha256=NEW.sha256);
      END;
      CREATE TRIGGER IF NOT EXISTS edge_content_removed AFTER DELETE ON edge_content
        BEGIN UPDATE edge_content_usage SET bytes=bytes-OLD.size WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS edge_content_adopt AFTER INSERT ON edge_entry
        WHEN NEW.sha256 IS NOT NULL BEGIN DELETE FROM edge_orphan WHERE sha256=NEW.sha256; END;
      CREATE TABLE IF NOT EXISTS materialized_cut (view_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
        generation INTEGER NOT NULL, manifest_digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS materialized_base (view_id TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT,
        dirty INTEGER NOT NULL, PRIMARY KEY(view_id,path));
      CREATE INDEX IF NOT EXISTS materialized_dirty ON materialized_base(view_id,dirty);`);
    if (!db.prepare("SELECT 1 FROM edge_content_usage WHERE id=1").get()) {
      // One inventory when creating the index, including CAS left by an older cache generation.
      // Thereafter rename/delete owners maintain the counter; reopening never recounts the CAS.
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT INTO edge_content_usage VALUES (1,0)").run();
        const cas = path.join(repo, "cas", "sha256");
        if (existsSync(cas))
          for (const prefix of readdirSync(cas))
            for (const sha of readdirSync(path.join(cas, prefix))) {
              db.prepare("INSERT INTO edge_content VALUES (?,?)").run(sha, statSync(path.join(cas, prefix, sha)).size);
            }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    return read(db);
  } finally {
    db.close();
  }
}

function cutRoot(db: DatabaseSync, viewId: string, cut: FleetCut): number | null {
  const row = db
    .prepare("SELECT root_revision FROM edge_cut WHERE view_id=? AND revision=? AND generation=?")
    .get(viewId, cut.revision, cut.schemaGeneration);
  return row ? Number(row.root_revision) : null;
}
function entryAt(db: DatabaseSync, viewId: string, cut: FleetCut, root: number, entryPath: string): FleetEntry | null {
  const row = db
    .prepare(
      `SELECT blob_json FROM edge_entry INDEXED BY sqlite_autoindex_edge_entry_1 WHERE view_id=? AND path=? AND generation=?
    AND revision>=? AND revision<=? ORDER BY revision DESC LIMIT 1`,
    )
    .get(viewId, entryPath, cut.schemaGeneration, root, cut.revision);
  return row?.blob_json ? { path: entryPath, blob: JSON.parse(String(row.blob_json)) as FleetEntry["blob"] } : null;
}

/** Transport validation and all entry replacements commit before the current pointer is published. */
export function commitEdgeManifest(
  viewDir: string,
  header: EdgeManifestHeader,
  from: FleetCut | null,
  changes: readonly FleetDeltaChange[],
): void {
  withEdgeManifest(viewDir, (db, viewId) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const retained = db
        .prepare("SELECT header FROM edge_cut WHERE view_id=? AND revision=? AND generation=?")
        .get(viewId, header.cut.revision, header.schemaGeneration);
      if (retained) {
        if (String(retained.header) !== JSON.stringify(header)) throw new Error("immutable snapshot identity conflict");
        db.exec("COMMIT");
        return;
      }
      const root = from ? cutRoot(db, viewId, from) : header.cut.revision;
      if (root === null) throw new Error("snapshot_required: current manifest missing");
      let digest = "0".repeat(64);
      if (from) {
        const prior = db
          .prepare("SELECT header FROM edge_cut WHERE view_id=? AND revision=? AND generation=?")
          .get(viewId, from.revision, from.schemaGeneration)!;
        digest = (JSON.parse(String(prior.header)) as EdgeManifestHeader).manifestDigest;
      } else {
        db.prepare(
          "UPDATE edge_entry SET end_revision=? WHERE view_id=? AND generation=? AND end_revision IS NULL",
        ).run(header.cut.revision, viewId, header.schemaGeneration);
      }
      const seen = new Set<string>();
      for (const change of changes) {
        // A repeated wire path would otherwise cancel its XOR contribution and make the
        // declared state ambiguous. The center writer cannot validate received wire bytes.
        if (seen.has(change.path)) throw new Error("duplicate manifest path");
        seen.add(change.path);
        const before = from ? entryAt(db, viewId, from, root, change.path) : null;
        if (before) digest = updateReplicaManifestDigest(digest, before);
        if (change.op === "put") digest = updateReplicaManifestDigest(digest, { path: change.path, blob: change.blob });
        // A snapshot already retired the previous state above. Only a delta
        // replaces one path; the revision/end indexes would scan the whole cut.
        if (from)
          db.prepare(
            `UPDATE edge_entry INDEXED BY sqlite_autoindex_edge_entry_1 SET end_revision=?
            WHERE view_id=? AND path=? AND generation=? AND end_revision IS NULL`,
          ).run(header.cut.revision, viewId, change.path, header.schemaGeneration);
        db.prepare("INSERT INTO edge_entry VALUES (?,?,?,?,NULL,?,?)").run(
          viewId,
          change.path,
          header.cut.revision,
          header.schemaGeneration,
          change.op === "put" ? JSON.stringify(change.blob) : null,
          change.op === "put" ? change.blob.sha256 : null,
        );
      }
      if (digest !== header.manifestDigest) throw new Error("result manifest mismatch");
      db.prepare("INSERT INTO edge_cut VALUES (?,?,?,?,?)").run(
        viewId,
        header.cut.revision,
        header.schemaGeneration,
        root,
        JSON.stringify(header),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}

export function readEdgeManifestHeader(file: string): EdgeManifestHeader {
  return JSON.parse(readFileSync(file, "utf8")) as EdgeManifestHeader;
}
export function readEdgeManifestEntries(file: string): FleetEntry[] {
  const header = readEdgeManifestHeader(file),
    viewDir = path.dirname(path.dirname(path.dirname(file)));
  return readEntriesAt(viewDir, header.cut);
}
function readEntriesAt(viewDir: string, cut: FleetCut): FleetEntry[] {
  return withEdgeManifest(viewDir, (db, viewId) => {
    const root = cutRoot(db, viewId, cut);
    if (root === null) throw new Error("snapshot_required: manifest is not retained");
    return db
      .prepare(
        `SELECT path,blob_json FROM edge_entry WHERE view_id=? AND generation=? AND revision>=?
      AND revision<=? AND (end_revision IS NULL OR end_revision>?) AND blob_json IS NOT NULL ORDER BY path`,
      )
      .all(viewId, cut.schemaGeneration, root, cut.revision, cut.revision)
      .map((row) => ({ path: String(row.path), blob: JSON.parse(String(row.blob_json)) as FleetEntry["blob"] }));
  });
}

/** Path lookups stay indexed; only callers explicitly enumerating the complete state load all rows. */
export function edgeManifestEntries(viewDir: string, cut: FleetCut): ReadonlyMap<string, FleetEntry["blob"]> | null {
  const file = path.join(viewDir, "cuts", `${cut.revision}-g${cut.schemaGeneration}`, "manifest.json");
  if (!existsSync(file)) return null;
  const all = () => new Map(readEntriesAt(viewDir, cut).map((entry) => [entry.path, entry.blob]));
  const get = (key: string) =>
    withEdgeManifest(viewDir, (db, viewId) => {
      const root = cutRoot(db, viewId, cut);
      return root === null ? undefined : entryAt(db, viewId, cut, root, key)?.blob;
    });
  return {
    get,
    has: (key) => get(key) !== undefined,
    get size() {
      return all().size;
    },
    entries: () => all().entries(),
    keys: () => all().keys(),
    values: () => all().values(),
    [Symbol.iterator]: () => all()[Symbol.iterator](),
    forEach: (callback, thisArg) => all().forEach(callback, thisArg),
  };
}

/** Null requires a full rebuild: the consumer's base is outside the retained local sequence. */
export function edgeChangedPaths(
  viewDir: string,
  from: { revision: number; schemaGeneration: number },
  to: FleetCut,
): string[] | null {
  if (from.revision === to.revision && from.schemaGeneration === to.schemaGeneration) return [];
  if (from.schemaGeneration !== to.schemaGeneration) return null;
  return withEdgeManifest(viewDir, (db, viewId) => {
    const root = cutRoot(db, viewId, to),
      priorRoot = cutRoot(db, viewId, { ...to, ...from });
    if (root === null || priorRoot !== root) return null;
    return db
      .prepare(`SELECT DISTINCT path FROM edge_entry WHERE view_id=? AND generation=? AND revision>? AND revision<=?`)
      .all(viewId, to.schemaGeneration, from.revision, to.revision)
      .map((row) => String(row.path));
  });
}

/** Roll back only this view's unpublished suffix; other views share the content index. */
export function discardUnpublishedEdgeManifests(viewDir: string, current: FleetCut | null): string[] {
  return withEdgeManifest(viewDir, (db, viewId) => {
    const revision = current?.revision ?? -1,
      generation = current?.schemaGeneration ?? -1,
      suffix = "view_id=? AND (revision>? OR (revision=? AND generation>?))",
      parameters = [viewId, revision, revision, generation];
    db.exec("BEGIN IMMEDIATE");
    try {
      const retired = db.prepare(`DELETE FROM edge_entry WHERE ${suffix} RETURNING sha256`).all(...parameters);
      const cuts = db.prepare(`DELETE FROM edge_cut WHERE ${suffix} RETURNING revision,generation`).all(...parameters);
      db.prepare("UPDATE edge_entry SET end_revision=NULL WHERE view_id=? AND end_revision>?").run(viewId, revision);
      for (const sha of new Set(retired.filter((row) => row.sha256 !== null).map((row) => String(row.sha256))))
        if (!db.prepare("SELECT 1 FROM edge_entry WHERE sha256=? LIMIT 1").get(sha))
          db.prepare("INSERT OR IGNORE INTO edge_orphan VALUES (?)").run(sha);
      db.exec("COMMIT");
      return cuts.map((row) => `${row.revision}-g${row.generation}`);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}

/** Pruning visits retired versions, then tests only their blobs against the shared index. */
export function pruneEdgeManifests(viewDir: string): string[] {
  return withEdgeManifest(viewDir, (db, viewId) => {
    const keep = db
      .prepare(
        "SELECT revision,generation FROM edge_cut WHERE view_id=? ORDER BY revision DESC,generation DESC LIMIT 64",
      )
      .all(viewId);
    if (keep.length < 64)
      return db
        .prepare("SELECT sha256 FROM edge_orphan")
        .all()
        .map((row) => String(row.sha256));
    const oldest = Number(keep.at(-1)!.revision),
      generation = Number(keep.at(-1)!.generation);
    db.exec("BEGIN IMMEDIATE");
    try {
      const retired = [
        ...db
          .prepare("DELETE FROM edge_entry WHERE view_id=? AND generation<? RETURNING sha256")
          .all(viewId, generation),
        ...db
          .prepare("DELETE FROM edge_entry WHERE view_id=? AND generation=? AND end_revision<=? RETURNING sha256")
          .all(viewId, generation, oldest),
      ];
      db.prepare("DELETE FROM edge_entry WHERE view_id=? AND generation=? AND revision<? AND blob_json IS NULL").run(
        viewId,
        generation,
        oldest,
      );
      db.prepare("DELETE FROM edge_cut WHERE view_id=? AND (revision<? OR (revision=? AND generation<?))").run(
        viewId,
        oldest,
        oldest,
        generation,
      );
      const released = [...new Set(retired.filter((row) => row.sha256 !== null).map((row) => String(row.sha256)))];
      for (const sha of released)
        if (!db.prepare("SELECT 1 FROM edge_entry WHERE sha256=? LIMIT 1").get(sha))
          db.prepare("INSERT OR IGNORE INTO edge_orphan VALUES (?)").run(sha);
      db.exec("COMMIT");
      return db
        .prepare("SELECT sha256 FROM edge_orphan")
        .all()
        .map((row) => String(row.sha256));
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}

/** Indexed package lookup: a task operation does not enumerate other tasks' documents. */
export function edgeManifestPaths(viewDir: string, cut: FleetCut, prefix: string): string[] {
  return withEdgeManifest(viewDir, (db, viewId) => {
    const root = cutRoot(db, viewId, cut);
    if (root === null) return [];
    return db
      .prepare(
        `SELECT path FROM edge_entry WHERE view_id=? AND path>=? AND path<? AND generation=?
      AND revision>=? AND revision<=? AND (end_revision IS NULL OR end_revision>?) AND blob_json IS NOT NULL`,
      )
      .all(viewId, prefix, `${prefix}\u{10ffff}`, cut.schemaGeneration, root, cut.revision, cut.revision)
      .map((row) => String(row.path));
  });
}

/** A shared CAS object is readable only when this view's retained cut names it. */
export function edgeManifestBlob(viewDir: string, cut: FleetCut, sha256: string): FleetEntry["blob"] | null {
  return withEdgeManifest(viewDir, (db, viewId) => {
    const root = cutRoot(db, viewId, cut);
    if (root === null) return null;
    const row = db
      .prepare(
        `SELECT blob_json FROM edge_entry INDEXED BY edge_entry_blob WHERE sha256=? AND view_id=? AND generation=?
      AND revision>=? AND revision<=? AND (end_revision IS NULL OR end_revision>?) LIMIT 1`,
      )
      .get(sha256, viewId, cut.schemaGeneration, root, cut.revision, cut.revision);
    return row ? (JSON.parse(String(row.blob_json)) as FleetEntry["blob"]) : null;
  });
}

/** Verified content can outlive an interrupted transfer before any entry adopts it. */
export function edgeContentBytes(repo: string): number {
  return withEdgeRepository(repo, (db) =>
    Number(db.prepare("SELECT bytes FROM edge_content_usage WHERE id=1").get()!.bytes),
  );
}

export function markEdgeContent(viewDir: string, sha: string, size: number): void {
  withEdgeManifest(viewDir, (db) => {
    // Reserve before the CAS rename. A crash can overcount an orphan until collection,
    // but can never hide durable content from the quota on restart.
    db.prepare("INSERT OR IGNORE INTO edge_content VALUES (?,?)").run(sha, size);
  });
}
export function forgetEdgeContent(viewDir: string, released: readonly string[], compact = false): void {
  withEdgeManifest(viewDir, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const content = db.prepare("DELETE FROM edge_content WHERE sha256=?"),
        orphan = db.prepare("DELETE FROM edge_orphan WHERE sha256=?");
      for (const sha of released) {
        content.run(sha);
        orphan.run(sha);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    // Deleted first-snapshot rows must release disk space, not consume the next pull's quota.
    if (compact) db.exec("VACUUM");
  });
}
