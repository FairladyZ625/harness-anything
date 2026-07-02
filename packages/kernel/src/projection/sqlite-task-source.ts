import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { CloseoutReadiness } from "../domain/index.ts";
import { isDomainStatus, isPackageDisposition, isTerminalStatus } from "../domain/index.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { readFrontmatter, readNestedScalar, readScalar } from "../markdown/frontmatter.ts";
import type { ProjectionCanonicalStatus, CoordinationStatus, ProjectionWarning, TaskProjectionRow } from "./types.ts";

export function readMarkdownSource(rootDir: string): {
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
        source: "source-package",
        severity: "hard-fail",
        message: error instanceof Error ? error.message : `Malformed task package: ${name}`,
        repairHint: "Restore valid task-package/v2 frontmatter before running projection reads or post-merge checks."
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

export interface TaskSourceEntry {
  readonly taskId: string;
  readonly indexPath: string;
  readonly body: string;
  readonly frontmatter: string;
}

export function taskEntryToRow(rootDir: string, entry: TaskSourceEntry): TaskProjectionRow {
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
    canonicalStatus,
    coordinationStatus: coordinationStatus(canonicalStatus),
    rawStatus,
    packageDisposition,
    closeoutReadiness: closeoutReadiness(rootDir, entry.taskId, canonicalStatus),
    lifecycleEngine,
    freshness: canonicalStatus === "unknown" || !isPackageDisposition(rawDisposition) ? "stale-but-usable" : "fresh",
    updatedAt: statSync(entry.indexPath).mtime.toISOString(),
    source: lifecycleEngine === "local" ? "local-document" : "external-engine",
    sourcePath: source,
    ...readExtensionMetadata(entry.frontmatter),
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

function readModuleMetadata(taskDir: string): { readonly moduleKey?: string; readonly moduleTitle?: string } {
  const modulePath = path.join(taskDir, "module.md");
  if (!existsSync(modulePath)) return {};
  const body = readFileSync(modulePath, "utf8");
  const moduleKey = body.match(/^Module key:[ \t]*(.+)$/mu)?.[1]?.trim() ?? "";
  const moduleTitle = body.match(/^Module title:[ \t]*(.+)$/mu)?.[1]?.trim() ?? "";
  return {
    ...(moduleKey ? { moduleKey } : {}),
    ...(moduleTitle ? { moduleTitle } : {})
  };
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
  if (existsSync(path.join(taskDir, "closeout.md"))) return "ready";
  return "missing";
}

export function sourcePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

export function hashExactRows(rows: ReadonlyArray<TaskProjectionRow>): string {
  return hashText(JSON.stringify([...rows].sort(compareRows)));
}

export function hashTaskProjectionRows(rows: ReadonlyArray<TaskProjectionRow>): string {
  return hashText(JSON.stringify([...rows].sort(compareRows).map((row) => ({
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
