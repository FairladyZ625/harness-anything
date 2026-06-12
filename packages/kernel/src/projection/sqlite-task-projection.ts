import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { CloseoutReadiness, DomainStatus, PackageDisposition } from "../domain/index.ts";
import { findEntityRefs, isDomainStatus, isPackageDisposition, isTerminalStatus } from "../domain/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";

export type ProjectionFreshness = "fresh" | "stale-but-usable" | "unavailable-no-cache";
export type ProjectionSource = "local-document" | "external-engine" | "snapshot-cache";
export type ProjectionCanonicalStatus = DomainStatus | "unknown";
export type CoordinationStatus = "open" | "blocked" | "in_review" | "terminal" | "unknown";
export type ProjectionWarningCode =
  | "projection_missing"
  | "projection_stale"
  | "projection_tampered"
  | "source_malformed"
  | "duplicate_task_id"
  | "duplicate_external_binding"
  | "generated_tracked"
  | "binding_tampered"
  | "conflict_marker_present"
  | "dangling_entity_ref"
  | "relation_cycle_detected";

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
  readonly severity?: "warning" | "hard-fail";
  readonly repairHint?: string;
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
  readonly postMerge?: boolean;
}

interface ProjectionMeta {
  readonly sourceHash: string;
  readonly rowsHash: string;
}

const projectionVersion = "task-projection/v1";

export function defaultTaskProjectionPath(rootDir: string): string {
  return resolveHarnessLayout(rootDir).projectionPath;
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
  const postMergeWarnings = options.postMerge ? runPostMergeChecks(rootDir) : [];
  const warnings = [...result.warnings, ...postMergeWarnings];
  return {
    ok: warnings.every((warning) => warning.code !== "projection_tampered" && warning.code !== "source_malformed" && warning.severity !== "hard-fail"),
    projectionPath,
    rows: result.rows,
    warnings
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
    const insertRow = db.prepare("INSERT OR REPLACE INTO task_projection (task_id, row_json) VALUES (?, ?)");
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
  const tasksDir = resolveHarnessLayout(rootDir).tasksRoot;
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
  return frontmatter.match(new RegExp(`^${escaped}:[ \\t]*(.*)$`, "mu"))?.[1]?.trim() ?? "";
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
  const taskDir = path.join(resolveHarnessLayout(rootDir).tasksRoot, taskId);
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

function runPostMergeChecks(rootDir: string): ReadonlyArray<ProjectionWarning> {
  const source = readMarkdownSource(rootDir);
  const warnings: ProjectionWarning[] = [];
  warnings.push(...findDuplicateTaskIds(rootDir, source.entries));
  warnings.push(...findDuplicateExternalBindings(source.entries));
  warnings.push(...findTrackedGeneratedFiles(rootDir));
  warnings.push(...findTamperedBindings(source.entries));
  warnings.push(...findConflictMarkers(rootDir));
  warnings.push(...findDanglingEntityRefs(rootDir, source.entries));
  warnings.push(...findRelationCycles(source.entries));
  return warnings;
}

function hardFail(code: ProjectionWarningCode, message: string, repairHint: string): ProjectionWarning {
  return {
    code,
    message,
    severity: "hard-fail",
    repairHint
  };
}

function findDuplicateTaskIds(rootDir: string, entries: ReadonlyArray<TaskSourceEntry>): ReadonlyArray<ProjectionWarning> {
  const seen = new Map<string, string>();
  const warnings: ProjectionWarning[] = [];
  for (const entry of entries) {
    const taskId = readScalar(entry.frontmatter, "task_id") || entry.taskId;
    const source = sourcePath(rootDir, entry.indexPath);
    const previous = seen.get(taskId);
    if (previous) {
      warnings.push(hardFail(
        "duplicate_task_id",
        `Duplicate task_id ${taskId} in ${previous} and ${source}.`,
        "Regenerate one task package with a new random task_<ULID> identity; do not hand-edit IDs to merge packages."
      ));
    } else {
      seen.set(taskId, source);
    }
  }
  return warnings;
}

function findDuplicateExternalBindings(entries: ReadonlyArray<TaskSourceEntry>): ReadonlyArray<ProjectionWarning> {
  const seen = new Map<string, string>();
  const warnings: ProjectionWarning[] = [];
  for (const entry of entries) {
    const engine = readScalar(entry.frontmatter, "  engine");
    const ref = readScalar(entry.frontmatter, "  ref");
    if (ref.length === 0) continue;
    const key = `${engine}:${ref}`;
    const taskId = readScalar(entry.frontmatter, "task_id") || entry.taskId;
    const previous = seen.get(key);
    if (previous) {
      warnings.push(hardFail(
        "duplicate_external_binding",
        `External binding ${key} is used by ${previous} and ${taskId}.`,
        "Keep exactly one package for each external engine/ref binding and relink or remove the duplicate package."
      ));
    } else {
      seen.set(key, taskId);
    }
  }
  return warnings;
}

function findTrackedGeneratedFiles(rootDir: string): ReadonlyArray<ProjectionWarning> {
  try {
    const output = execFileSync("git", ["-C", rootDir, "ls-files", "--", ".harness", ".journal", ".projection.sqlite", ".adopt-claims"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (output.length === 0) return [];
    return [hardFail(
      "generated_tracked",
      "Generated local harness files are tracked by git.",
      "Remove .harness/, legacy .journal/, legacy .projection.sqlite, and legacy .adopt-claims/ files from git; rebuild generated projections locally."
    )];
  } catch {
    return [];
  }
}

function findTamperedBindings(entries: ReadonlyArray<TaskSourceEntry>): ReadonlyArray<ProjectionWarning> {
  const warnings: ProjectionWarning[] = [];
  for (const entry of entries) {
    const engine = readScalar(entry.frontmatter, "  engine");
    const bindingCreatedAt = readScalar(entry.frontmatter, "  bindingCreatedAt");
    const stored = readScalar(entry.frontmatter, "  bindingFingerprint");
    if (engine.length === 0 || bindingCreatedAt.length === 0 || stored.length === 0) continue;
    const ref = nullIfEmpty(readScalar(entry.frontmatter, "  ref"));
    const expected = `sha256:${stablePayloadHash({ engine, ref, bindingCreatedAt })}`;
    if (stored !== expected) {
      const taskId = readScalar(entry.frontmatter, "task_id") || entry.taskId;
      warnings.push(hardFail(
        "binding_tampered",
        `Lifecycle binding fingerprint mismatch for ${taskId}.`,
        "Do not mutate lifecycle identity fields in place; restore the original binding or create a fresh task/adoption package."
      ));
    }
  }
  return warnings;
}

function findConflictMarkers(rootDir: string): ReadonlyArray<ProjectionWarning> {
  const layout = resolveHarnessLayout(rootDir);
  const roots = [layout.authoredRoot, path.join(layout.rootDir, "AGENTS.md"), path.join(layout.rootDir, "CLAUDE.md")];
  for (const candidate of roots.flatMap((entry) => listTextFiles(entry))) {
    const body = readFileSync(candidate, "utf8");
    if (/^<<<<<<<[^\n]*\n[\s\S]*?^=======$[\s\S]*?^>>>>>>>[^\n]*$/mu.test(body)) {
      return [hardFail(
        "conflict_marker_present",
        `Git conflict marker found in ${sourcePath(rootDir, candidate)}.`,
        "Resolve merge conflict markers before running post-merge checks again."
      )];
    }
  }
  return [];
}

function findDanglingEntityRefs(rootDir: string, entries: ReadonlyArray<TaskSourceEntry>): ReadonlyArray<ProjectionWarning> {
  const knownTaskIds = new Set(entries.map((entry) => readScalar(entry.frontmatter, "task_id") || entry.taskId));
  const warnings: ProjectionWarning[] = [];
  const files = listTextFiles(resolveHarnessLayout(rootDir).authoredRoot);
  for (const filePath of files) {
    const body = readFileSync(filePath, "utf8");
    for (const ref of findEntityRefs(body)) {
      if (ref.externalHarness) continue;
      if (ref.id.length > 0 && !knownTaskIds.has(ref.id)) {
        warnings.push(hardFail(
          "dangling_entity_ref",
          `Dangling task reference task/${ref.id} in ${sourcePath(rootDir, filePath)}.`,
          "Update the reference to an existing task package or remove the stale relation."
        ));
        return warnings;
      }
    }
  }
  return warnings;
}

function findRelationCycles(entries: ReadonlyArray<TaskSourceEntry>): ReadonlyArray<ProjectionWarning> {
  const graph = new Map<string, string[]>();
  for (const entry of entries) {
    const taskId = readScalar(entry.frontmatter, "task_id") || entry.taskId;
    const packageBody = listTextFiles(path.dirname(entry.indexPath))
      .map((filePath) => readFileSync(filePath, "utf8"))
      .join("\n");
    const targets = [...packageBody.matchAll(/target:\s*((?:[A-Za-z][A-Za-z0-9_-]*:)?task\/[A-Za-z0-9_-]+)/gu)]
      .flatMap((match) => {
        const ref = findEntityRefs(match[1] ?? "")[0];
        return ref && !ref.externalHarness ? [ref.id] : [];
      });
    graph.set(taskId, targets);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function visit(taskId: string): string[] | null {
    if (visiting.has(taskId)) return stack.slice(stack.indexOf(taskId)).concat(taskId);
    if (visited.has(taskId)) return null;
    visiting.add(taskId);
    stack.push(taskId);
    for (const target of graph.get(taskId) ?? []) {
      if (!graph.has(target)) continue;
      const cycle = visit(target);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(taskId);
    visited.add(taskId);
    return null;
  }

  for (const taskId of graph.keys()) {
    const cycle = visit(taskId);
    if (cycle) {
      return [hardFail(
        "relation_cycle_detected",
        `Task relation cycle detected: ${cycle.join(" -> ")}.`,
        "Break the cyclic task relation before merging authored planning docs."
      )];
    }
  }
  return [];
}

function listTextFiles(inputPath: string): ReadonlyArray<string> {
  if (!existsSync(inputPath)) return [];
  const stat = statSync(inputPath);
  if (stat.isFile()) return isTextLikePath(inputPath) ? [inputPath] : [];
  if (!stat.isDirectory()) return [];
  const files: string[] = [];
  for (const entry of readdirSync(inputPath, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    files.push(...listTextFiles(path.join(inputPath, entry.name)));
  }
  return files;
}

function isTextLikePath(filePath: string): boolean {
  return /\.(md|markdown|txt|ya?ml|json)$/iu.test(filePath);
}

function nullIfEmpty(value: string): string | null {
  return value.length === 0 ? null : value;
}

function stablePayloadHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
