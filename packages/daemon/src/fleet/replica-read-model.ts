import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyEdgeReadModelEntry,
  canonicalJson,
  classifyTextualArtifactPath,
  consumeKnownError,
  createEdgeReadModelTables,
  docByteLength,
  deleteEdgeReadModelEntry,
  DOC_POLICY_ID,
  INITIAL_SETTINGS_V1,
  isReadModelPath,
  parseEdgeReadModelMeta,
  RAW_ARTIFACT_MEDIA_TYPE,
  RAW_ARTIFACT_POLICY_ID,
  READ_MODEL_META_PATH,
  repositorySettings,
  SETTINGS_ID,
  sha256Bytes,
  type DocumentState,
  type EdgeReadModelMeta,
  type EdgeReadModelRows,
  type RepositorySettingsV1,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import { writeFileDurably } from "../durable-file.ts";
import type { FleetMirrorView } from "../fleet-edge-mirror.ts";
import { resolveTaskRootThreshold } from "../task-wip-settings.ts";

/** The edge view's materialized read model and its last center head confirmation, beside current.json. */
const READ_MODEL_FILE = "read-model.sqlite";
const HEAD_CONFIRMATION_FILE = "head-confirmation.json";
const READ_DENIED_FILE = "read-denied.json";

/** The center side: what one cut publishes for the edge read model. */
export function centerEdgeReadModel(projection: TaskProjectionQueries): {
  readonly sourceRevision: number;
  readonly rootThreshold: number;
  readonly rows: EdgeReadModelRows;
} | null {
  const read = projection.readEdgeReadModel();
  if (read.status !== "ready") return null;
  const projected = read.rows.entities.find(
    (row) => row.entityKind === "settings" && row.entityId === SETTINGS_ID,
  )?.valueJson;
  const settings = repositorySettings(
    projected === undefined ? INITIAL_SETTINGS_V1 : (JSON.parse(projected) as RepositorySettingsV1),
  );
  return {
    sourceRevision: read.sourceRevision,
    rootThreshold: resolveTaskRootThreshold({ tasks: settings.tasks }).threshold,
    rows: read.rows,
  };
}

export interface HeadConfirmation {
  readonly headRevision: number;
  readonly confirmedAt: number;
}

/** Every successful pull, with or without new bytes, is the center confirming its head now. */
export function recordHeadConfirmation(viewDir: string, headRevision: number, confirmedAt = Date.now()): void {
  writeFileDurably(path.join(viewDir, HEAD_CONFIRMATION_FILE), JSON.stringify({ headRevision, confirmedAt }));
  rmSync(path.join(viewDir, READ_DENIED_FILE), { force: true });
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
    return Number.isSafeInteger(value.headRevision) && Number.isSafeInteger(value.confirmedAt) ? value : null;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

export interface EdgeReadModel {
  readonly db: DatabaseSync;
  readonly meta: EdgeReadModelMeta;
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
  try {
    return synchronize(file, view, casRoot);
  } catch (error) {
    consumeKnownError(error);
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  }
  try {
    return synchronize(file, view, casRoot);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

function synchronize(file: string, view: FleetMirrorView, casRoot: string): EdgeReadModel | null {
  const metaBlob = view.entries.get(READ_MODEL_META_PATH);
  if (!metaBlob) return null;
  const blob = (sha256: string) => {
    const bytes = readFileSync(path.join(casRoot, sha256.slice(0, 2), sha256));
    if (sha256Bytes(bytes) !== sha256) throw new Error(`read model blob ${sha256} is corrupt`);
    return bytes;
  };
  const meta = parseEdgeReadModelMeta(blob(metaBlob.sha256).toString("utf8"));
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    createEdgeReadModelTables(db);
    db.exec(
      `CREATE TABLE IF NOT EXISTS read_model_row (entry_path TEXT PRIMARY KEY, blob_sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS read_model_cut (id INTEGER PRIMARY KEY CHECK(id = 1), manifest_digest TEXT NOT NULL);`,
    );
    const synced = db.prepare("SELECT manifest_digest FROM read_model_cut WHERE id = 1").get() as
      | { readonly manifest_digest: string }
      | undefined;
    if (synced?.manifest_digest !== view.manifestDigest) {
      const loaded = new Map(
        (
          db.prepare("SELECT entry_path, blob_sha256 FROM read_model_row").all() as unknown as readonly {
            readonly entry_path: string;
            readonly blob_sha256: string;
          }[]
        ).map((row) => [row.entry_path, row.blob_sha256]),
      );
      const upsertRow = db.prepare("INSERT OR REPLACE INTO read_model_row(entry_path, blob_sha256) VALUES (?, ?)"),
        forgetRow = db.prepare("DELETE FROM read_model_row WHERE entry_path = ?"),
        upsertDocument = db.prepare(
          "INSERT OR REPLACE INTO document(path, workspace_revision, value_json) VALUES (?, ?, ?)",
        ),
        forgetDocument = db.prepare("DELETE FROM document WHERE path = ?");
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const [entryPath, entry] of view.entries)
          if (entryPath !== READ_MODEL_META_PATH) {
            if (loaded.get(entryPath) === entry.sha256) continue;
            if (isReadModelPath(entryPath)) applyEdgeReadModelEntry(db, entryPath, blob(entry.sha256).toString("utf8"));
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
          }
        for (const entryPath of loaded.keys())
          if (!view.entries.has(entryPath)) {
            if (isReadModelPath(entryPath)) deleteEdgeReadModelEntry(db, entryPath);
            else forgetDocument.run(entryPath);
            forgetRow.run(entryPath);
          }
        db.prepare("INSERT OR REPLACE INTO read_model_cut(id, manifest_digest) VALUES (1, ?)").run(view.manifestDigest);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    return { db, meta };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Marks every view of `repoId` under `viewRoot` as refused by the center. */
export function recordRepoReadDenied(viewRoot: string, repoId: string): void {
  const views = path.join(viewRoot, "repos", repoId, "views");
  if (!existsSync(views)) return;
  for (const view of readdirSync(views, { withFileTypes: true }))
    if (view.isDirectory()) recordReadDenied(path.join(views, view.name));
}
