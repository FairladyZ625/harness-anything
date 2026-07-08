import { randomBytes } from "node:crypto";
import path from "node:path";
import { resolveEntityRootForLayout } from "./entity-root-resolver.ts";
import type { EntityRootIntent, EntityRootResolution } from "./entity-root-resolver.ts";
import type { TaskId } from "../domain/index.ts";
import { localLayoutFileSystem } from "../local/local-layout-file-system.ts";
import { readFrontmatter, readScalar } from "../markdown/frontmatter.ts";
import { normalizeRelativeDocumentPath } from "./portable-path.ts";

export { readFrontmatter, readScalar } from "../markdown/frontmatter.ts";
export {
  assertNoPortablePathCollisions,
  findPortablePathCollisions,
  normalizeRelativeDocumentPath
} from "./portable-path.ts";
export type { EntityRootIntent, EntityRootResolution } from "./entity-root-resolver.ts";

export interface HarnessLayout {
  readonly rootDir: string;
  readonly configPath?: string;
  readonly authoredRoot: string;
  readonly standardsRoot: string;
  readonly contextRoot: string;
  readonly tasksRoot: string;
  readonly decisionsRoot: string;
  readonly sessionsRoot: string;
  readonly adrRoot: string;
  readonly milestonesRoot: string;
  readonly legacyRoot: string;
  readonly legacyTasksRoot: string;
  readonly legacyDocsRoot: string;
  readonly legacyIndexPath: string;
  readonly legacyCollisionReportPath: string;
  readonly legacyRebuildGuidePath: string;
  readonly localRoot: string;
  readonly generatedRoot: string;
  readonly runtimeEventLedgerRoot: string;
  readonly cacheRoot: string;
  readonly projectionPath: string;
  readonly writeJournalRoot: string;
  readonly journalPath: string;
  readonly watermarkPath: string;
  readonly payloadsRoot: string;
  readonly locksRoot: string;
  readonly claimsRoot: string;
  readonly factDocumentName: "facts.md";
  readonly taskPackagePath: (taskId: TaskId) => string;
  readonly createTaskPackagePath: (taskId: TaskId, slug?: string) => string;
  readonly taskDocumentPath: (taskId: TaskId, documentPath: string) => string;
  readonly taskFactDocumentPath: (taskId: TaskId) => string;
  readonly decisionPackagePath: (decisionId: string) => string;
  readonly decisionDocumentPath: (decisionId: string) => string;
  readonly sessionDocumentPath: (sessionId: string) => string;
  readonly runtimeEventLedgerPath: (sessionId: string) => string;
}

const crockfordBase32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;
const defaultAuthoredRoot = "harness";
const defaultLocalRoot = ".harness";
const layoutFileSystem = localLayoutFileSystem;

export interface HarnessLayoutOverrides {
  readonly authoredRoot?: string;
}

export interface HarnessRuntimeContext {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
}

export type HarnessLayoutInput = string | HarnessRuntimeContext;

interface HarnessConfigLocation {
  readonly path: string;
  readonly projectRoot: string;
  readonly structureBase?: string;
}

interface HarnessLayoutConfig {
  readonly authoredRoot?: string;
  readonly localRoot?: string;
  readonly tasksRoot?: string;
  readonly generatedRoot?: string;
}

interface HarnessLayoutSettings {
  readonly resolvedRoot: string;
  readonly configPath?: string;
  readonly authoredRootSetting: string;
  readonly localRootSetting: string;
  readonly tasksRootSetting?: string;
  readonly generatedRootSetting?: string;
}

export function createHarnessRuntimeContext(
  rootDir: string,
  layoutOverrides?: HarnessLayoutOverrides
): HarnessRuntimeContext {
  return {
    rootDir: path.resolve(rootDir),
    ...(layoutOverrides && layoutOverrides.authoredRoot ? { layoutOverrides } : {})
  };
}

export function harnessRuntimeRoot(input: HarnessLayoutInput): string {
  return typeof input === "string" ? path.resolve(input) : input.rootDir;
}

export function resolveHarnessLayout(input: HarnessLayoutInput): HarnessLayout {
  return buildHarnessLayout(resolveHarnessLayoutSettings(input));
}

export function resolveEntityRoot(
  input: HarnessLayoutInput,
  ref: string | Parameters<typeof resolveEntityRootForLayout>[1],
  intent?: EntityRootIntent
): EntityRootResolution {
  return resolveEntityRootForLayout(resolveHarnessLayout(input), ref, intent);
}

function resolveHarnessLayoutSettings(input: HarnessLayoutInput): HarnessLayoutSettings {
  const rootDir = harnessRuntimeRoot(input);
  const { projectRoot, configPath, config } = resolveProjectRootAndConfig(rootDir);
  const authoredRootSetting = layoutInputOverrides(input).authoredRoot
    ?? config.authoredRoot
    ?? defaultAuthoredRoot;
  return {
    resolvedRoot: projectRoot,
    configPath,
    authoredRootSetting,
    localRootSetting: config.localRoot ?? defaultLocalRoot,
    tasksRootSetting: config.tasksRoot,
    generatedRootSetting: config.generatedRoot
  };
}

function layoutInputOverrides(input: HarnessLayoutInput): HarnessLayoutOverrides {
  return typeof input === "string" ? {} : input.layoutOverrides ?? {};
}

function buildHarnessLayout(settings: HarnessLayoutSettings): HarnessLayout {
  const { resolvedRoot, authoredRootSetting, localRootSetting, tasksRootSetting, generatedRootSetting } = settings;
  const authoredRoot = resolveRootRelativePath(resolvedRoot, authoredRootSetting, "layout.authoredRoot");
  const legacyRoot = path.join(authoredRoot, "legacy");
  const localRoot = resolveRootRelativePath(resolvedRoot, localRootSetting, "layout.localRoot");
  const tasksRoot = tasksRootSetting
    ? resolveRootRelativePath(resolvedRoot, tasksRootSetting, "tasks.root")
    : path.join(authoredRoot, "tasks");
  const decisionsRoot = path.join(authoredRoot, "decisions");
  const sessionsRoot = path.join(authoredRoot, "sessions");
  const adrRoot = path.join(authoredRoot, "adr");
  const milestonesRoot = path.join(authoredRoot, "milestones");
  const generatedRoot = generatedRootSetting
    ? resolveRootRelativePath(resolvedRoot, generatedRootSetting, "structure.generatedRoot")
    : path.join(localRoot, "generated");
  const writeJournalRoot = path.join(localRoot, "write-journal");
  const factDocumentName = "facts.md";
  return {
    rootDir: resolvedRoot,
    configPath: settings.configPath,
    authoredRoot,
    standardsRoot: path.join(authoredRoot, "standards"),
    contextRoot: path.join(authoredRoot, "context"),
    tasksRoot,
    decisionsRoot,
    sessionsRoot,
    adrRoot,
    milestonesRoot,
    legacyRoot,
    legacyTasksRoot: path.join(legacyRoot, "tasks"),
    legacyDocsRoot: path.join(legacyRoot, "docs"),
    legacyIndexPath: path.join(legacyRoot, "index.json"),
    legacyCollisionReportPath: path.join(legacyRoot, "collision-report.json"),
    legacyRebuildGuidePath: path.join(legacyRoot, "rebuild-guide.md"),
    localRoot,
    generatedRoot,
    runtimeEventLedgerRoot: path.join(generatedRoot, "runtime-events"),
    cacheRoot: path.join(localRoot, "cache"),
    projectionPath: path.join(localRoot, "cache", "projections.sqlite"),
    writeJournalRoot,
    journalPath: path.join(writeJournalRoot, "writes.jsonl"),
    watermarkPath: path.join(writeJournalRoot, "watermark.json"),
    payloadsRoot: path.join(writeJournalRoot, "payloads"),
    locksRoot: path.join(localRoot, "locks"),
    claimsRoot: path.join(localRoot, "adopt-claims"),
    factDocumentName,
    taskPackagePath: (taskId) => {
      validateTaskIdSyntax(taskId);
      return findTaskPackagePathInTasksRoot(tasksRoot, taskId) ?? path.join(tasksRoot, taskId);
    },
    createTaskPackagePath: (taskId, slug) => {
      validateTaskIdSyntax(taskId);
      const suffix = slug ? `-${normalizeTaskSlug(slug)}` : "";
      return path.join(tasksRoot, `${taskId}${suffix}`);
    },
    taskDocumentPath: (taskId, documentPath) => {
      const safePath = normalizeRelativeDocumentPath(documentPath);
      return path.join(findTaskPackagePathInTasksRoot(tasksRoot, taskId) ?? path.join(tasksRoot, taskId), safePath);
    },
    taskFactDocumentPath: (taskId) => {
      validateTaskIdSyntax(taskId);
      return path.join(findTaskPackagePathInTasksRoot(tasksRoot, taskId) ?? path.join(tasksRoot, taskId), factDocumentName);
    },
    decisionPackagePath: (decisionId) => {
      const safeDecisionId = normalizeEntityRootSegment(decisionId, "decision id");
      return path.join(decisionsRoot, `decision-${safeDecisionId}`);
    },
    decisionDocumentPath: (decisionId) => {
      const safeDecisionId = normalizeEntityRootSegment(decisionId, "decision id");
      return path.join(decisionsRoot, `decision-${safeDecisionId}`, "decision.md");
    },
    sessionDocumentPath: (sessionId) => {
      const safeSessionId = normalizeEntityRootSegment(sessionId, "session id");
      return path.join(sessionsRoot, `${safeSessionId}.md`);
    },
    runtimeEventLedgerPath: (sessionId) => {
      const safeSessionId = normalizeEntityRootSegment(sessionId, "session id");
      return path.join(generatedRoot, "runtime-events", `${safeSessionId}.jsonl`);
    }
  };
}

function resolveProjectRootAndConfig(rootDir: string): {
  readonly projectRoot: string;
  readonly configPath?: string;
  readonly config: HarnessLayoutConfig;
} {
  const startingRoot = path.resolve(rootDir);
  const discovery = findHarnessConfigLocation(startingRoot);
  if (!discovery.location) return { projectRoot: discovery.boundaryRoot ?? startingRoot, config: {} };
  return {
    projectRoot: discovery.location.projectRoot,
    configPath: discovery.location.path,
    config: readLayoutConfig(discovery.location)
  };
}

interface HarnessConfigDiscovery {
  readonly location?: HarnessConfigLocation;
  readonly boundaryRoot?: string;
}

function findHarnessConfigLocation(startingRoot: string): HarnessConfigDiscovery {
  let current = startingRoot;
  while (true) {
    const publicCandidate = path.join(current, defaultAuthoredRoot, "harness.yaml");
    if (layoutFileSystem.exists(publicCandidate)) return { location: { path: publicCandidate, projectRoot: current } };
    const privateRoot = path.join(current, ".harness-private");
    const privateCandidate = path.join(privateRoot, "coding-agent-harness", "harness.yaml");
    if (layoutFileSystem.exists(privateCandidate)) {
      return { location: { path: privateCandidate, projectRoot: current, structureBase: ".harness-private" } };
    }
    const selfHostLocation = findSelfHostConfigLocation(current);
    if (selfHostLocation) return { location: selfHostLocation };
    if (layoutFileSystem.exists(path.join(current, ".git"))) return { boundaryRoot: current };
    const parent = path.dirname(current);
    if (parent === current) return {};
    current = parent;
  }
}

function findSelfHostConfigLocation(current: string): HarnessConfigLocation | undefined {
  const configPath = path.join(current, "harness.yaml");
  if (!layoutFileSystem.exists(configPath)) return undefined;
  const parent = path.dirname(current);
  if (parent === current) return undefined;
  if (path.basename(current) === defaultAuthoredRoot) {
    return { path: configPath, projectRoot: parent };
  }
  if (path.basename(current) === "coding-agent-harness" && path.basename(parent) === ".harness-private") {
    return { path: configPath, projectRoot: path.dirname(parent), structureBase: ".harness-private" };
  }
  return undefined;
}

function readLayoutConfig(location: HarnessConfigLocation): HarnessLayoutConfig {
  const lines = layoutFileSystem.readText(location.path).split(/\r?\n/u);
  let section: "layout" | "tasks" | "structure" | undefined;
  let authoredRoot: string | undefined;
  let localRoot: string | undefined;
  let tasksRoot: string | undefined;
  let generatedRoot: string | undefined;

  for (const rawLine of lines) {
    const withoutComment = rawLine.replace(/\s+#.*$/u, "");
    if (!withoutComment.trim()) continue;
    const topLevel = /^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/u.exec(withoutComment);
    if (topLevel) {
      section = topLevel[1] === "layout" || topLevel[1] === "tasks" || topLevel[1] === "structure" ? topLevel[1] : undefined;
      continue;
    }
    const nested = /^  ([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/u.exec(withoutComment);
    if (!nested || !section) continue;
    const [, key, rawValue = ""] = nested;
    const value = unquoteScalar(rawValue.trim());
    if (!value) continue;
    if (section === "layout" && key === "authoredRoot") authoredRoot = value;
    if (section === "layout" && key === "localRoot") localRoot = value;
    if (section === "tasks" && key === "root") tasksRoot = value;
    if (section === "structure" && key === "harnessRoot") authoredRoot = structureRelativePath(location, value);
    if (section === "structure" && key === "tasksRoot") tasksRoot = structureRelativePath(location, value);
    if (section === "structure" && key === "generatedRoot") generatedRoot = structureRelativePath(location, value);
  }

  return { authoredRoot, localRoot, tasksRoot, generatedRoot };
}

function structureRelativePath(location: HarnessConfigLocation, value: string): string {
  return location.structureBase ? path.join(location.structureBase, value) : value;
}

function resolveRootRelativePath(rootDir: string, value: string, field: string): string {
  const normalized = path.normalize(value);
  if (path.isAbsolute(value) || normalized === "." || normalized.startsWith("..") || normalized.includes(`..${path.sep}`)) {
    throw new Error(`${field} must be a relative path inside the project root: ${value}`);
  }
  return path.join(rootDir, normalized);
}

function unquoteScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
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

export function taskPackagePath(input: HarnessLayoutInput, taskId: TaskId): string {
  return resolveHarnessLayout(input).taskPackagePath(taskId);
}

export function createTaskPackagePath(input: HarnessLayoutInput, taskId: TaskId, slug?: string): string {
  return resolveHarnessLayout(input).createTaskPackagePath(taskId, slug);
}

export function taskDocumentPath(input: HarnessLayoutInput, taskId: TaskId, documentPath: string): string {
  return resolveHarnessLayout(input).taskDocumentPath(taskId, documentPath);
}

export function listTaskIndexPaths(input: HarnessLayoutInput): ReadonlyArray<string> {
  return listTaskIndexPathsInTasksRoot(resolveHarnessLayout(input).tasksRoot);
}

function listTaskIndexPathsInTasksRoot(tasksRoot: string): ReadonlyArray<string> {
  if (!layoutFileSystem.exists(tasksRoot)) return [];
  return layoutFileSystem.readDirents(tasksRoot)
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(tasksRoot, entry.name, "INDEX.md"))
    .filter((indexPath) => layoutFileSystem.exists(indexPath))
    .sort();
}

export function findTaskPackagePath(input: HarnessLayoutInput, taskId: TaskId): string | null {
  return findTaskPackagePathInTasksRoot(resolveHarnessLayout(input).tasksRoot, taskId);
}

function findTaskPackagePathInTasksRoot(tasksRoot: string, taskId: TaskId): string | null {
  validateTaskIdSyntax(taskId);
  const exact = path.join(tasksRoot, taskId, "INDEX.md");
  if (layoutFileSystem.exists(exact)) return path.dirname(exact);
  for (const indexPath of listTaskIndexPathsInTasksRoot(tasksRoot)) {
    const frontmatter = readFrontmatter(layoutFileSystem.readText(indexPath)) ?? "";
    if (readScalar(frontmatter, "task_id") === taskId) return path.dirname(indexPath);
  }
  return null;
}

export function findTaskIdByExternalRef(input: HarnessLayoutInput, engine: string, ref: string): TaskId | null {
  for (const indexPath of listTaskIndexPaths(input)) {
    const frontmatter = readFrontmatter(layoutFileSystem.readText(indexPath)) ?? "";
    if (readScalar(frontmatter, "  engine") === engine && readScalar(frontmatter, "  ref") === ref) {
      return (readScalar(frontmatter, "task_id") || path.basename(path.dirname(indexPath))) as TaskId;
    }
  }
  return null;
}

function normalizeTaskSlug(value: string): string {
  const normalized = slugifyTaskTitle(value);
  if (normalized.includes("/") || normalized.includes("..")) {
    throw new Error(`invalid task slug: ${value}`);
  }
  return normalized;
}

function normalizeEntityRootSegment(value: string, label: string): string {
  const normalized = normalizeRelativeDocumentPath(value);
  if (normalized !== value || normalized.includes("/")) {
    throw new Error(`${label} must be a portable single path segment: ${value}`);
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
