import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  consumeKnownError,
  deleteTaskReadModelRow,
  parseTaskReadModelMeta,
  sha256Bytes,
  TASK_INDEX_TABLES_SQL,
  TASK_READ_MODEL_META_PATH,
  TASK_READ_MODEL_PREFIX,
  upsertTaskReadModelRow,
  type TaskProjectionQueries,
  type TaskReadModelMeta,
  type TaskReadModelRow,
} from "@harness-anything/kernel";
import { writeFileDurably } from "../durable-file.ts";
import type { FleetMirrorView } from "../fleet-edge-mirror.ts";
import { projectedTaskSettings, resolveTaskRootThreshold } from "../task-wip-settings.ts";

/** The edge view's materialized task read model and its last center head confirmation, beside current.json. */
const TASKS_READ_MODEL_FILE = "tasks-read-model.sqlite";
const HEAD_CONFIRMATION_FILE = "head-confirmation.json";
const READ_DENIED_FILE = "read-denied.json";

/** The center side: what one cut publishes for the edge task read model. */
export function centerTaskReadModel(projection: TaskProjectionQueries): {
  readonly sourceRevision: number;
  readonly rootThreshold: number;
  readonly rows: readonly TaskReadModelRow[];
} | null {
  const read = projection.readTaskReadModel();
  if (read.status !== "ready") return null;
  return {
    sourceRevision: read.sourceRevision,
    rootThreshold: resolveTaskRootThreshold(projectedTaskSettings(projection)).threshold,
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
  rmSync(path.join(viewDir, TASKS_READ_MODEL_FILE), { force: true });
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

export interface EdgeTaskReadModel {
  readonly db: DatabaseSync;
  readonly meta: TaskReadModelMeta;
}

/**
 * Opens the view's task read model synchronized to its current cut. The SQLite file is a cache of the
 * cut's published rows: it is brought up to the cut by row-blob difference from the verified local CAS,
 * and any damage is repaired by deleting it and rebuilding from the same CAS. Null means the current cut
 * carries no task read model (or its bytes are missing locally), which only a pull can fix.
 */
export function openEdgeTaskReadModel(view: FleetMirrorView, casRoot: string): EdgeTaskReadModel | null {
  const file = path.join(view.viewDir, TASKS_READ_MODEL_FILE);
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

function synchronize(file: string, view: FleetMirrorView, casRoot: string): EdgeTaskReadModel | null {
  const metaBlob = view.entries.get(TASK_READ_MODEL_META_PATH);
  if (!metaBlob) return null;
  const blob = (sha256: string) => {
    const bytes = readFileSync(path.join(casRoot, sha256.slice(0, 2), sha256));
    if (sha256Bytes(bytes) !== sha256) throw new Error(`task read model blob ${sha256} is corrupt`);
    return bytes.toString("utf8");
  };
  const meta = parseTaskReadModelMeta(blob(metaBlob.sha256));
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    db.exec(
      `${TASK_INDEX_TABLES_SQL}
      CREATE TABLE IF NOT EXISTS read_model_row (task_id TEXT PRIMARY KEY, blob_sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS read_model_cut (id INTEGER PRIMARY KEY CHECK(id = 1), manifest_digest TEXT NOT NULL);`,
    );
    const synced = db.prepare("SELECT manifest_digest FROM read_model_cut WHERE id = 1").get() as
      | { readonly manifest_digest: string }
      | undefined;
    if (synced?.manifest_digest !== view.manifestDigest) {
      const published = new Map(
          [...view.entries]
            .filter(([entryPath]) => entryPath.startsWith(TASK_READ_MODEL_PREFIX))
            .map(([entryPath, entry]) => [
              entryPath.slice(TASK_READ_MODEL_PREFIX.length, -".json".length),
              entry.sha256,
            ]),
        ),
        loaded = new Map(
          (
            db.prepare("SELECT task_id, blob_sha256 FROM read_model_row").all() as unknown as readonly {
              readonly task_id: string;
              readonly blob_sha256: string;
            }[]
          ).map((row) => [row.task_id, row.blob_sha256]),
        );
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const [taskId, sha256] of published)
          if (loaded.get(taskId) !== sha256) {
            if (upsertTaskReadModelRow(db, blob(sha256)) !== taskId)
              throw new Error("task read model row path mismatch");
            db.prepare("INSERT OR REPLACE INTO read_model_row(task_id, blob_sha256) VALUES (?, ?)").run(taskId, sha256);
          }
        for (const taskId of loaded.keys())
          if (!published.has(taskId)) {
            deleteTaskReadModelRow(db, taskId);
            db.prepare("DELETE FROM read_model_row WHERE task_id = ?").run(taskId);
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
