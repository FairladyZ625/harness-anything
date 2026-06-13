import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TaskId } from "../domain/index.ts";

export interface HarnessLayout {
  readonly rootDir: string;
  readonly authoredRoot: string;
  readonly standardsRoot: string;
  readonly contextRoot: string;
  readonly planningRoot: string;
  readonly tasksRoot: string;
  readonly legacyRoot: string;
  readonly legacyTasksRoot: string;
  readonly legacyDocsRoot: string;
  readonly legacyIndexPath: string;
  readonly legacyCollisionReportPath: string;
  readonly legacyRebuildGuidePath: string;
  readonly localRoot: string;
  readonly generatedRoot: string;
  readonly cacheRoot: string;
  readonly projectionPath: string;
  readonly writeJournalRoot: string;
  readonly journalPath: string;
  readonly watermarkPath: string;
  readonly payloadsRoot: string;
  readonly locksRoot: string;
  readonly claimsRoot: string;
}

const crockfordBase32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;

export function resolveHarnessLayout(rootDir: string): HarnessLayout {
  const resolvedRoot = path.resolve(rootDir);
  const authoredRoot = path.join(resolvedRoot, "harness");
  const legacyRoot = path.join(authoredRoot, "legacy");
  const localRoot = path.join(resolvedRoot, ".harness");
  const writeJournalRoot = path.join(localRoot, "write-journal");
  return {
    rootDir: resolvedRoot,
    authoredRoot,
    standardsRoot: path.join(authoredRoot, "standards"),
    contextRoot: path.join(authoredRoot, "context"),
    planningRoot: path.join(authoredRoot, "planning"),
    tasksRoot: path.join(authoredRoot, "planning", "tasks"),
    legacyRoot,
    legacyTasksRoot: path.join(legacyRoot, "tasks"),
    legacyDocsRoot: path.join(legacyRoot, "docs"),
    legacyIndexPath: path.join(legacyRoot, "index.json"),
    legacyCollisionReportPath: path.join(legacyRoot, "collision-report.json"),
    legacyRebuildGuidePath: path.join(legacyRoot, "rebuild-guide.md"),
    localRoot,
    generatedRoot: path.join(localRoot, "generated"),
    cacheRoot: path.join(localRoot, "cache"),
    projectionPath: path.join(localRoot, "cache", "projections.sqlite"),
    writeJournalRoot,
    journalPath: path.join(writeJournalRoot, "writes.jsonl"),
    watermarkPath: path.join(writeJournalRoot, "watermark.json"),
    payloadsRoot: path.join(writeJournalRoot, "payloads"),
    locksRoot: path.join(localRoot, "locks"),
    claimsRoot: path.join(localRoot, "adopt-claims")
  };
}

export function generateTaskId(now: Date = new Date()): TaskId {
  const timestamp = encodeBase32(now.getTime(), 10);
  const entropy = encodeRandomBase32(16);
  return `task_${timestamp}${entropy}`;
}

export function isGeneratedTaskId(value: string): boolean {
  return taskIdPattern.test(value);
}

export function slugifyTaskTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 72);
  return slug.length > 0 ? slug : "task";
}

export function validateTaskIdSyntax(taskId: TaskId): void {
  if (taskId.length === 0 || taskId.includes("/") || taskId.includes("..")) {
    throw new Error(`invalid task id: ${taskId}`);
  }
}

export function taskPackagePath(rootDir: string, taskId: TaskId): string {
  validateTaskIdSyntax(taskId);
  const existing = findTaskPackagePath(rootDir, taskId);
  return existing ?? path.join(resolveHarnessLayout(rootDir).tasksRoot, taskId);
}

export function createTaskPackagePath(rootDir: string, taskId: TaskId, slug?: string): string {
  validateTaskIdSyntax(taskId);
  const suffix = slug ? `-${normalizeTaskSlug(slug)}` : "";
  return path.join(resolveHarnessLayout(rootDir).tasksRoot, `${taskId}${suffix}`);
}

export function taskDocumentPath(rootDir: string, taskId: TaskId, documentPath: string): string {
  const safePath = normalizeRelativeDocumentPath(documentPath);
  return path.join(taskPackagePath(rootDir, taskId), safePath);
}

export function listTaskIndexPaths(rootDir: string): ReadonlyArray<string> {
  const tasksRoot = resolveHarnessLayout(rootDir).tasksRoot;
  if (!existsSync(tasksRoot)) return [];
  return readdirSync(tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(tasksRoot, entry.name, "INDEX.md"))
    .filter((indexPath) => existsSync(indexPath))
    .sort();
}

export function findTaskPackagePath(rootDir: string, taskId: TaskId): string | null {
  const tasksRoot = resolveHarnessLayout(rootDir).tasksRoot;
  const exact = path.join(tasksRoot, taskId, "INDEX.md");
  if (existsSync(exact)) return path.dirname(exact);
  for (const indexPath of listTaskIndexPaths(rootDir)) {
    const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8")) ?? "";
    if (readScalar(frontmatter, "task_id") === taskId) return path.dirname(indexPath);
  }
  return null;
}

export function findTaskIdByExternalRef(rootDir: string, engine: string, ref: string): TaskId | null {
  for (const indexPath of listTaskIndexPaths(rootDir)) {
    const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8")) ?? "";
    if (readScalar(frontmatter, "  engine") === engine && readScalar(frontmatter, "  ref") === ref) {
      return (readScalar(frontmatter, "task_id") || path.basename(path.dirname(indexPath))) as TaskId;
    }
  }
  return null;
}

export function readFrontmatter(body: string): string | null {
  return body.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? null;
}

export function readScalar(frontmatter: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return frontmatter.match(new RegExp(`^${escaped}:[ \\t]*(.*)$`, "mu"))?.[1]?.trim() ?? "";
}

export function normalizeRelativeDocumentPath(value: string): string {
  if (path.isAbsolute(value)) throw new Error(`absolute paths are not allowed: ${value}`);
  const normalized = path.normalize(value);
  if (normalized.startsWith("..") || normalized === ".") {
    throw new Error(`path must stay inside task package: ${value}`);
  }
  return normalized;
}

function normalizeTaskSlug(value: string): string {
  const normalized = slugifyTaskTitle(value);
  if (normalized.includes("/") || normalized.includes("..")) {
    throw new Error(`invalid task slug: ${value}`);
  }
  return normalized;
}

function encodeRandomBase32(length: number): string {
  const bytes = randomBytes(length);
  let output = "";
  for (const byte of bytes) {
    output += crockfordBase32[byte & 31];
  }
  return output;
}

function encodeBase32(value: number, width: number): string {
  let remaining = Math.max(0, Math.floor(value));
  let output = "";
  do {
    output = `${crockfordBase32[remaining % 32]}${output}`;
    remaining = Math.floor(remaining / 32);
  } while (remaining > 0);
  return output.padStart(width, "0").slice(-width);
}
