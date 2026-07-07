import { existsSync } from "node:fs";
import path from "node:path";
import type { CloseoutReadiness } from "../domain/index.ts";
import { isDomainStatus, isPackageDisposition, isPriorityTier, isTaskWorkKind, isTerminalStatus } from "../domain/index.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { readFrontmatter, readNestedScalar, readScalar } from "../markdown/frontmatter.ts";
import type { ProjectionCanonicalStatus, CoordinationStatus, ProjectionWarning, TaskFieldExtensionProjection, TaskProjectionRow } from "./types.ts";
import { readDirIfPresent, readDirNamesIfPresent, readTextFileIfPresent, statPathIfPresent } from "./toctou-safe-fs.ts";

export function readMarkdownSource(rootInput: HarnessLayoutInput): {
  readonly entries: ReadonlyArray<TaskSourceEntry>;
  readonly hash: string;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
} {
  const source = readTaskProjectionSource(rootInput);
  return {
    entries: source.entries,
    hash: hashText(JSON.stringify(source.sourceInputs)),
    warnings: source.warnings
  };
}

export function readTaskProjectionSourceHashInputs(rootInput: HarnessLayoutInput): ReadonlyArray<TaskProjectionSourceHashInput> {
  return readTaskProjectionSource(rootInput).sourceInputs;
}

function readTaskProjectionSource(rootInput: HarnessLayoutInput): {
  readonly entries: ReadonlyArray<TaskSourceEntry>;
  readonly sourceInputs: ReadonlyArray<TaskProjectionSourceHashInput>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
} {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  const tasksDir = layout.tasksRoot;
  if (!existsSync(tasksDir)) {
    return { entries: [], sourceInputs: [], warnings: [] };
  }

  const warnings: ProjectionWarning[] = [];
  const entries: TaskSourceEntry[] = [];
  const taskEntries = readDirNamesIfPresent(tasksDir);
  if (taskEntries === null) return { entries: [], sourceInputs: [], warnings: [] };
  for (const name of taskEntries.sort()) {
    const indexPath = path.join(tasksDir, name, "INDEX.md");
    if (!existsSync(indexPath)) continue;
    const body = readTextFileIfPresent(indexPath);
    if (body === null) continue;
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
        source: "source-package",
        severity: "hard-fail",
        message: error instanceof Error ? error.message : `Malformed task package: ${name}`,
        repairHint: "Restore valid task-package/v2 frontmatter before running projection reads or post-merge checks."
      });
    }
  }

  return {
    entries,
    sourceInputs: [
      ...entries.map((entry) => ({
        kind: "task-index",
        taskId: entry.taskId,
        sourcePath: sourcePath(rootDir, entry.indexPath),
        body: entry.body
      })),
      ...readRelationGraphSourceInputs(rootDir, layout, entries)
    ],
    warnings
  };
}

export interface TaskSourceEntry {
  readonly taskId: string;
  readonly indexPath: string;
  readonly body: string;
  readonly frontmatter: string;
}

export interface TaskProjectionSourceHashInput {
  readonly kind: string;
  readonly sourcePath: string;
  readonly body: string;
}

export function taskEntryToRow(
  rootInput: HarnessLayoutInput,
  entry: TaskSourceEntry,
  fieldExtensions: ReadonlyArray<TaskFieldExtensionProjection> = []
): TaskProjectionRow {
  const rootDir = resolveHarnessLayout(rootInput).rootDir;
  const rawStatus = readScalar(entry.frontmatter, "  status") || "unknown";
  const canonicalStatus = isDomainStatus(rawStatus) ? rawStatus : "unknown";
  const rawDisposition = readScalar(entry.frontmatter, "packageDisposition") || "active";
  const packageDisposition = isPackageDisposition(rawDisposition) ? rawDisposition : "active";
  const lifecycleEngine = readScalar(entry.frontmatter, "  engine") || "local";
  const source = sourcePath(rootDir, entry.indexPath);
  const taskDir = path.dirname(entry.indexPath);
  return {
    schema: "sqlite-task-row/v1",
    taskId: readScalar(entry.frontmatter, "task_id") || entry.taskId,
    title: readScalar(entry.frontmatter, "title") || entry.taskId,
    ...readParent(entry.frontmatter),
    canonicalStatus,
    coordinationStatus: coordinationStatus(canonicalStatus),
    rawStatus,
    packageDisposition,
    closeoutReadiness: closeoutReadiness(rootInput, entry.taskId, canonicalStatus),
    lifecycleEngine,
    freshness: canonicalStatus === "unknown" || !isPackageDisposition(rawDisposition) ? "stale-but-usable" : "fresh",
    updatedAt: (statPathIfPresent(entry.indexPath)?.mtime ?? new Date(0)).toISOString(),
    source: lifecycleEngine === "local" ? "local-document" : "external-engine",
    sourcePath: source,
    ...readExtensionMetadata(entry.frontmatter),
    ...readFieldExtensions(entry.frontmatter, fieldExtensions),
    ...readTaskMetadata(entry.frontmatter),
    ...readModuleMetadata(taskDir),
    hasLessonCandidates: existsSync(path.join(taskDir, "lesson_candidates.md")),
    ...readCreatedBy(entry.frontmatter)
  };
}

function parseFrontmatter(body: string): string {
  const frontmatter = readFrontmatter(body);
  if (!frontmatter) throw new Error("INDEX.md missing frontmatter");
  return frontmatter;
}

function readCreatedBy(frontmatter: string): { readonly createdBy?: { readonly name: string; readonly email: string } } {
  const block = frontmatter.match(/^createdBy:\n((?:[ \t]+[^\n]*\n?)*)/mu)?.[1];
  if (!block) return {};
  const name = readNestedScalar(block, "name");
  const email = readNestedScalar(block, "email");
  return name && email ? { createdBy: { name, email } } : {};
}

function readParent(frontmatter: string): { readonly parentTaskId?: string } {
  const parentTaskId = readScalar(frontmatter, "parent");
  return parentTaskId ? { parentTaskId } : {};
}

function readExtensionMetadata(frontmatter: string): { readonly vertical?: string; readonly preset?: string; readonly profile?: string } {
  const vertical = readScalar(frontmatter, "vertical");
  const preset = readScalar(frontmatter, "preset");
  const profile = readScalar(frontmatter, "profile");
  return {
    ...(vertical ? { vertical } : {}),
    ...(preset ? { preset } : {}),
    ...(profile ? { profile } : {})
  };
}

function readFieldExtensions(
  frontmatter: string,
  extensions: ReadonlyArray<TaskFieldExtensionProjection>
): { readonly fieldExtensions?: Readonly<Record<string, string | null>> } {
  if (extensions.length === 0) return {};
  const values = Object.fromEntries(extensions.map((extension) => {
    const rawValue = readScalar(frontmatter, extension.field);
    return [
      extension.field,
      extension.values.includes(rawValue) ? rawValue : extension.default
    ];
  }));
  return Object.values(values).some((value) => value !== null) ? { fieldExtensions: values } : {};
}

function readTaskMetadata(frontmatter: string): Pick<TaskProjectionRow, "workKind" | "riskTier" | "urgency"> {
  const workKind = readScalar(frontmatter, "workKind");
  const riskTier = readScalar(frontmatter, "riskTier");
  const urgency = readScalar(frontmatter, "urgency");
  return {
    ...(isTaskWorkKind(workKind) ? { workKind } : {}),
    ...(isPriorityTier(riskTier) ? { riskTier } : {}),
    ...(isPriorityTier(urgency) ? { urgency } : {})
  };
}

function readModuleMetadata(taskDir: string): { readonly moduleKey?: string; readonly moduleTitle?: string } {
  const modulePath = path.join(taskDir, "module.md");
  if (!existsSync(modulePath)) return {};
  const body = readTextFileIfPresent(modulePath);
  if (body === null) return {};
  const moduleKey = body.match(/^Module key:[ \t]*(.+)$/mu)?.[1]?.trim() ?? "";
  const moduleTitle = body.match(/^Module title:[ \t]*(.+)$/mu)?.[1]?.trim() ?? "";
  return {
    ...(moduleKey ? { moduleKey } : {}),
    ...(moduleTitle ? { moduleTitle } : {})
  };
}

function readRelationGraphSourceInputs(
  rootDir: string,
  layout: ReturnType<typeof resolveHarnessLayout>,
  entries: ReadonlyArray<TaskSourceEntry>
): ReadonlyArray<{ readonly kind: string; readonly sourcePath: string; readonly body: string }> {
  const taskDocumentInputs = entries
    .flatMap((entry) => [
      { kind: "task-facts", path: path.join(path.dirname(entry.indexPath), layout.factDocumentName) },
      { kind: "task-module", path: path.join(path.dirname(entry.indexPath), "module.md") },
      { kind: "task-review", path: path.join(path.dirname(entry.indexPath), "review.md") },
      { kind: "task-closeout", path: path.join(path.dirname(entry.indexPath), "closeout.md") }
    ])
    .filter((input) => existsSync(input.path))
    .flatMap((input) => {
      const body = readTextFileIfPresent(input.path);
      return body === null
        ? []
        : [{
          kind: input.kind,
          sourcePath: sourcePath(rootDir, input.path),
          body
        }];
    });
  const decisionInputs = listDecisionDocuments(layout.decisionsRoot)
    .flatMap((decisionPath) => {
      const body = readTextFileIfPresent(decisionPath);
      return body === null
        ? []
        : [{
          kind: "decision-document",
          sourcePath: sourcePath(rootDir, decisionPath),
          body
        }];
    });
  return [...taskDocumentInputs, ...decisionInputs].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}

function listDecisionDocuments(decisionsRoot: string): ReadonlyArray<string> {
  if (!existsSync(decisionsRoot)) return [];
  const stat = statPathIfPresent(decisionsRoot);
  if (stat === null) return [];
  if (stat.isFile()) return path.basename(decisionsRoot) === "decision.md" ? [decisionsRoot] : [];
  if (!stat.isDirectory()) return [];
  const entries = readDirIfPresent(decisionsRoot);
  if (entries === null) return [];
  return entries
    .filter((entry) => entry.name !== ".git" && entry.name !== "node_modules")
    .flatMap((entry) => listDecisionDocuments(path.join(decisionsRoot, entry.name)))
    .sort();
}

function coordinationStatus(status: ProjectionCanonicalStatus): CoordinationStatus {
  if (status === "unknown") return "unknown";
  if (status === "blocked") return "blocked";
  if (status === "in_review") return "in_review";
  return isTerminalStatus(status) ? "terminal" : "open";
}

function closeoutReadiness(rootInput: HarnessLayoutInput, taskId: string, status: ProjectionCanonicalStatus): CloseoutReadiness {
  if (status === "unknown") return "missing";
  if (!isTerminalStatus(status) && status !== "in_review") return "not_required";
  const taskDir = path.join(resolveHarnessLayout(rootInput).tasksRoot, taskId);
  if (existsSync(path.join(taskDir, "closeout.md"))) return "ready";
  return "missing";
}

export function sourcePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

export function hashExactRows(rows: ReadonlyArray<TaskProjectionRow>): string {
  return hashText(JSON.stringify([...rows].sort(compareRows).map(canonicalTaskProjectionRow)));
}

export function hashTaskProjectionRows(rows: ReadonlyArray<TaskProjectionRow>): string {
  return hashText(JSON.stringify([...rows].sort(compareRows).map((row) => canonicalTaskProjectionRow({
    ...row,
    updatedAt: "<derived-from-source-mtime>"
  }))));
}

function hashText(text: string): string {
  return `sha256:${sha256Text(text)}`;
}

export function compareRows(a: TaskProjectionRow, b: TaskProjectionRow): number {
  return a.taskId.localeCompare(b.taskId);
}

function canonicalTaskProjectionRow(row: TaskProjectionRow): TaskProjectionRow {
  return {
    schema: row.schema,
    taskId: row.taskId,
    title: row.title,
    ...(row.parentTaskId ? { parentTaskId: row.parentTaskId } : {}),
    canonicalStatus: row.canonicalStatus,
    coordinationStatus: row.coordinationStatus,
    rawStatus: row.rawStatus,
    packageDisposition: row.packageDisposition,
    closeoutReadiness: row.closeoutReadiness,
    lifecycleEngine: row.lifecycleEngine,
    freshness: row.freshness,
    updatedAt: row.updatedAt,
    source: row.source,
    sourcePath: row.sourcePath,
    ...(row.vertical ? { vertical: row.vertical } : {}),
    ...(row.preset ? { preset: row.preset } : {}),
    ...(row.profile ? { profile: row.profile } : {}),
    ...(row.workKind ? { workKind: row.workKind } : {}),
    ...(row.riskTier ? { riskTier: row.riskTier } : {}),
    ...(row.urgency ? { urgency: row.urgency } : {}),
    ...(row.moduleKey ? { moduleKey: row.moduleKey } : {}),
    ...(row.moduleTitle ? { moduleTitle: row.moduleTitle } : {}),
    ...(row.hasLessonCandidates === undefined ? {} : { hasLessonCandidates: row.hasLessonCandidates }),
    ...(row.createdBy ? { createdBy: { name: row.createdBy.name, email: row.createdBy.email } } : {}),
    ...(row.fieldExtensions ? { fieldExtensions: sortRecord(row.fieldExtensions) } : {})
  };
}

function sortRecord(record: Readonly<Record<string, string | null>>): Readonly<Record<string, string | null>> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}
