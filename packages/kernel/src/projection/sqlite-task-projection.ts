import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { CloseoutReadiness, DomainStatus, PackageDisposition } from "../domain/index.ts";
import { isDomainStatus, isPackageDisposition, isTerminalStatus } from "../domain/index.ts";

export type ProjectionFreshness = "fresh" | "stale-but-usable" | "unavailable-no-cache";
export type ProjectionSource = "local-document" | "external-engine" | "snapshot-cache";
export type ProjectionCanonicalStatus = DomainStatus | "unknown";
export type CoordinationStatus = "open" | "blocked" | "in_review" | "terminal" | "unknown";
export type ProjectionWarningCode = "projection_missing" | "projection_stale" | "projection_tampered" | "source_malformed";

export interface TaskProjectionRow {
  readonly schema: "sqlite-task-row/v1";
  readonly taskId: string;
  readonly title: string;
  readonly canonicalStatus: ProjectionCanonicalStatus;
  readonly coordinationStatus: CoordinationStatus;
  readonly rawStatus: string;
  readonly packageDisposition: PackageDisposition;
  readonly closeoutReadiness: CloseoutReadiness;
  readonly lifecycleEngine: string;
  readonly freshness: ProjectionFreshness;
  readonly updatedAt: string;
  readonly source: ProjectionSource;
  readonly sourcePath: string;
}

export interface ProjectionWarning {
  readonly code: ProjectionWarningCode;
  readonly message: string;
}

export interface ProjectionReadResult {
  readonly rows: ReadonlyArray<TaskProjectionRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}

export interface ProjectionCheckResult extends ProjectionReadResult {
  readonly ok: boolean;
  readonly projectionPath: string;
}

export interface TaskProjectionOptions {
  readonly rootDir: string;
  readonly projectionPath?: string;
}

interface ProjectionMeta {
  readonly sourceHash: string;
  readonly rowsHash: string;
}

const projectionVersion = "task-projection/v1";

export function defaultTaskProjectionPath(rootDir: string): string {
  return path.join(path.resolve(rootDir), ".projection.sqlite");
}

export function rebuildTaskProjection(options: TaskProjectionOptions): ProjectionReadResult {
  const rootDir = path.resolve(options.rootDir);
  const projectionPath = options.projectionPath ? path.resolve(options.projectionPath) : defaultTaskProjectionPath(rootDir);
  const source = readMarkdownSource(rootDir);
  const rows = source.entries.map((entry) => taskEntryToRow(rootDir, entry)).sort(compareRows);
  const rowsHash = hashRows(rows);
  writeProjectionDatabase(projectionPath, rows, {
    sourceHash: source.hash,
    rowsHash
  });
  return {
    rows,
    warnings: source.warnings
  };
}

export function readTaskProjection(options: TaskProjectionOptions): ProjectionReadResult {
  const rootDir = path.resolve(options.rootDir);
  const projectionPath = options.projectionPath ? path.resolve(options.projectionPath) : defaultTaskProjectionPath(rootDir);
  const source = readMarkdownSource(rootDir);
  const warnings = [...source.warnings];

  if (!existsSync(projectionPath)) {
    warnings.push({ code: "projection_missing", message: "Projection cache was missing and has been rebuilt." });
    const rebuilt = rebuildTaskProjection({ rootDir, projectionPath });
    return { rows: rebuilt.rows, warnings };
  }

  const existing = tryReadProjectionDatabase(projectionPath);
  if (!existing.ok) {
    warnings.push({ code: "projection_tampered", message: "Projection cache could not be read and has been rebuilt from markdown." });
    const rebuilt = rebuildTaskProjection({ rootDir, projectionPath });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }

  if (existing.meta.sourceHash !== source.hash) {
    warnings.push({ code: "projection_stale", message: "Projection cache was stale and has been rebuilt from markdown." });
    const rebuilt = rebuildTaskProjection({ rootDir, projectionPath });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }

  const actualRowsHash = hashRows(existing.rows);
  if (existing.meta.rowsHash !== actualRowsHash) {
    warnings.push({ code: "projection_tampered", message: "Projection rows no longer match their recorded hash." });
    const rebuilt = rebuildTaskProjection({ rootDir, projectionPath });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }

  return {
    rows: [...existing.rows].sort(compareRows),
    warnings
  };
}

export function checkTaskProjection(options: TaskProjectionOptions): ProjectionCheckResult {
  const rootDir = path.resolve(options.rootDir);
  const projectionPath = options.projectionPath ? path.resolve(options.projectionPath) : defaultTaskProjectionPath(rootDir);
  const result = readTaskProjection({ rootDir, projectionPath });
  return {
    ok: result.warnings.every((warning) => warning.code !== "projection_tampered" && warning.code !== "source_malformed"),
    projectionPath,
    rows: result.rows,
    warnings: result.warnings
  };
}

function writeProjectionDatabase(projectionPath: string, rows: ReadonlyArray<TaskProjectionRow>, meta: ProjectionMeta): void {
  mkdirSync(path.dirname(projectionPath), { recursive: true });
  const tempPath = `${projectionPath}.${process.pid}.${Date.now()}.tmp`;
  rmSync(tempPath, { force: true });
  const db = new DatabaseSync(tempPath);
  try {
    db.exec([
      "PRAGMA journal_mode = DELETE",
      "CREATE TABLE projection_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      [
        "CREATE TABLE task_projection (",
        "  task_id TEXT PRIMARY KEY,",
        "  row_json TEXT NOT NULL",
        ")"
      ].join("\n")
    ].join(";\n"));
    const insertMeta = db.prepare("INSERT INTO projection_meta (key, value) VALUES (?, ?)");
    insertMeta.run("version", projectionVersion);
    insertMeta.run("sourceHash", meta.sourceHash);
    insertMeta.run("rowsHash", meta.rowsHash);
    const insertRow = db.prepare("INSERT INTO task_projection (task_id, row_json) VALUES (?, ?)");
    for (const row of rows) {
      insertRow.run(row.taskId, JSON.stringify(row));
    }
  } finally {
    db.close();
  }
  renameSync(tempPath, projectionPath);
}

function readProjectionDatabase(projectionPath: string): { readonly rows: ReadonlyArray<TaskProjectionRow>; readonly meta: ProjectionMeta } {
  const db = new DatabaseSync(projectionPath, { readOnly: true });
  try {
    const metaRows = db.prepare("SELECT key, value FROM projection_meta").all() as unknown as ReadonlyArray<{ key: string; value: string }>;
    const meta = new Map(metaRows.map((row) => [row.key, row.value]));
    const rowRecords = db.prepare("SELECT row_json FROM task_projection ORDER BY task_id").all() as unknown as ReadonlyArray<{ row_json: string }>;
    return {
      meta: {
        sourceHash: meta.get("sourceHash") ?? "",
        rowsHash: meta.get("rowsHash") ?? ""
      },
      rows: rowRecords.map((record) => JSON.parse(record.row_json) as TaskProjectionRow)
    };
  } finally {
    db.close();
  }
}

function tryReadProjectionDatabase(
  projectionPath: string
): { readonly ok: true; readonly rows: ReadonlyArray<TaskProjectionRow>; readonly meta: ProjectionMeta } | { readonly ok: false } {
  try {
    return {
      ok: true,
      ...readProjectionDatabase(projectionPath)
    };
  } catch {
    return { ok: false };
  }
}

function readMarkdownSource(rootDir: string): {
  readonly entries: ReadonlyArray<TaskSourceEntry>;
  readonly hash: string;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
} {
  const tasksDir = path.join(rootDir, "tasks");
  if (!existsSync(tasksDir)) {
    return { entries: [], hash: hashText("[]"), warnings: [] };
  }

  const warnings: ProjectionWarning[] = [];
  const entries: TaskSourceEntry[] = [];
  for (const name of readdirSync(tasksDir).sort()) {
    const indexPath = path.join(tasksDir, name, "INDEX.md");
    if (!existsSync(indexPath)) continue;
    const body = readFileSync(indexPath, "utf8");
    try {
      entries.push({
        taskId: name,
        indexPath,
        body,
        frontmatter: parseFrontmatter(body)
      });
    } catch (error) {
      warnings.push({
        code: "source_malformed",
        message: error instanceof Error ? error.message : `Malformed task package: ${name}`
      });
    }
  }

  return {
    entries,
    hash: hashText(JSON.stringify(entries.map((entry) => ({
      taskId: entry.taskId,
      sourcePath: sourcePath(rootDir, entry.indexPath),
      body: entry.body
    })))),
    warnings
  };
}

interface TaskSourceEntry {
  readonly taskId: string;
  readonly indexPath: string;
  readonly body: string;
  readonly frontmatter: string;
}

function taskEntryToRow(rootDir: string, entry: TaskSourceEntry): TaskProjectionRow {
  const rawStatus = readScalar(entry.frontmatter, "  status") || "unknown";
  const canonicalStatus = isDomainStatus(rawStatus) ? rawStatus : "unknown";
  const rawDisposition = readScalar(entry.frontmatter, "packageDisposition") || "active";
  const packageDisposition = isPackageDisposition(rawDisposition) ? rawDisposition : "active";
  const lifecycleEngine = readScalar(entry.frontmatter, "  engine") || "local";
  const source = sourcePath(rootDir, entry.indexPath);
  return {
    schema: "sqlite-task-row/v1",
    taskId: readScalar(entry.frontmatter, "task_id") || entry.taskId,
    title: readScalar(entry.frontmatter, "title") || entry.taskId,
    canonicalStatus,
    coordinationStatus: coordinationStatus(canonicalStatus),
    rawStatus,
    packageDisposition,
    closeoutReadiness: closeoutReadiness(rootDir, entry.taskId, canonicalStatus),
    lifecycleEngine,
    freshness: canonicalStatus === "unknown" || !isPackageDisposition(rawDisposition) ? "stale-but-usable" : "fresh",
    updatedAt: statSync(entry.indexPath).mtime.toISOString(),
    source: lifecycleEngine === "local" ? "local-document" : "external-engine",
    sourcePath: source
  };
}

function parseFrontmatter(body: string): string {
  const frontmatter = body.match(/^---\n([\s\S]*?)\n---/u)?.[1];
  if (!frontmatter) throw new Error("INDEX.md missing frontmatter");
  return frontmatter;
}

function readScalar(frontmatter: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return frontmatter.match(new RegExp(`^${escaped}:\\s*(.*)$`, "mu"))?.[1]?.trim() ?? "";
}

function coordinationStatus(status: ProjectionCanonicalStatus): CoordinationStatus {
  if (status === "unknown") return "unknown";
  if (status === "blocked") return "blocked";
  if (status === "in_review") return "in_review";
  return isTerminalStatus(status) ? "terminal" : "open";
}

function closeoutReadiness(rootDir: string, taskId: string, status: ProjectionCanonicalStatus): CloseoutReadiness {
  if (status === "unknown") return "missing";
  if (!isTerminalStatus(status) && status !== "in_review") return "not_required";
  const taskDir = path.join(rootDir, "tasks", taskId);
  if (existsSync(path.join(taskDir, "walkthrough.md")) || existsSync(path.join(taskDir, "closeout.md"))) return "ready";
  return "missing";
}

function sourcePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function hashRows(rows: ReadonlyArray<TaskProjectionRow>): string {
  return hashText(JSON.stringify([...rows].sort(compareRows)));
}

function hashText(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function compareRows(a: TaskProjectionRow, b: TaskProjectionRow): number {
  return a.taskId.localeCompare(b.taskId);
}
