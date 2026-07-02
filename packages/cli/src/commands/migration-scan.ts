import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256Text } from "../../../kernel/src/integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../../../kernel/src/layout/index.ts";
import { resolveHarnessLayout } from "../../../kernel/src/layout/index.ts";
import type { LegacyIndex, LegacyIndexEntry } from "../../../kernel/src/schemas/registry.ts";

export interface LegacyScanEntry extends LegacyIndexEntry {
  readonly forwardPath?: string;
}

export interface LegacyScanReport {
  readonly schema: "legacy-intake-scan/v1";
  readonly strategy: "legacy-intake";
  readonly legacyRoot: "harness/legacy";
  readonly sourceRoot: string;
  readonly entries: ReadonlyArray<LegacyScanEntry>;
  readonly summary: LegacyIndex["summary"];
  readonly deprecatedAliases: ReadonlyArray<string>;
}

export function buildScanReport(rootInput: HarnessLayoutInput, sourcePath: string): LegacyScanReport {
  const rootDir = resolveHarnessLayout(rootInput).rootDir;
  const sourceRoot = path.resolve(rootDir, sourcePath);
  const entries = [
    ...collectLegacyTasks(rootDir, sourceRoot),
    ...collectLegacyDocs(rootInput, sourceRoot)
  ];
  const summary = summarize(entries);
  return {
    schema: "legacy-intake-scan/v1",
    strategy: "legacy-intake",
    legacyRoot: "harness/legacy",
    sourceRoot: normalizeSlashes(path.relative(rootDir, sourceRoot) || "."),
    entries,
    summary,
    deprecatedAliases: ["migrate-plan", "migrate-structure", "migrate-run", "migrate-verify"]
  };
}

export function renderIntakePlan(report: LegacyScanReport): string {
  const lines = [
    "# Legacy Intake Plan",
    "",
    `Source root: ${report.sourceRoot}`,
    `Entries: ${report.summary.entryCount}`,
    "",
    "| ID | Title | Category | Source | Stored | Forward | Treatment |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.entries.map((entry) => `| ${entry.id} | ${escapeMarkdownTableCell(entry.title ?? "")} | ${entry.category} | ${entry.sourcePath} | ${entry.storedPath} | ${entry.forwardPath ?? ""} | ${entry.recommendedTreatment} |`),
    ""
  ];
  return lines.join("\n");
}

export function summarize(entries: ReadonlyArray<LegacyIndexEntry>): LegacyIndex["summary"] {
  return {
    entryCount: entries.length,
    taskCount: entries.filter((entry) => entry.category === "task").length,
    docCount: entries.filter((entry) => entry.category === "doc").length,
    rebuildRequiredCount: entries.filter((entry) => entry.recommendedTreatment === "rebuild-required").length
  };
}

export function stripScanOnlyFields(entry: LegacyScanEntry): LegacyIndexEntry {
  const { forwardPath: _forwardPath, ...legacyEntry } = entry;
  return legacyEntry;
}

export function copyForwardDocs(rootDir: string, report: LegacyScanReport): void {
  const sourceRoot = path.resolve(rootDir, report.sourceRoot);
  for (const entry of report.entries) {
    if (!entry.forwardPath) continue;
    if (!isSafeRelativePath(entry.forwardPath)) continue;
    const source = path.join(sourceRoot, entry.sourcePath);
    const target = path.resolve(rootDir, entry.forwardPath);
    if (!isPathInside(rootDir, target) || existsSync(target)) continue;
    copySource(source, target);
  }
}

function collectLegacyTasks(rootDir: string, sourceRoot: string): ReadonlyArray<LegacyScanEntry> {
  const rootTasks = listDirectories(path.join(sourceRoot, "docs/09-PLANNING/TASKS"))
    .filter((name) => !name.startsWith("_"))
    .map((name) => taskEntry(sourceRoot, `docs/09-PLANNING/TASKS/${name}`, `harness/legacy/tasks/${name}`));
  const moduleTasksRoot = path.join(sourceRoot, "docs/09-PLANNING/MODULES");
  const moduleTasks = listDirectories(moduleTasksRoot).flatMap((moduleKey) => {
    if (moduleKey.startsWith("_")) return [];
    return listDirectories(path.join(moduleTasksRoot, moduleKey, "TASKS"))
      .filter((name) => !name.startsWith("_"))
      .map((name) => taskEntry(sourceRoot, `docs/09-PLANNING/MODULES/${moduleKey}/TASKS/${name}`, `harness/legacy/tasks/modules/${moduleKey}/${name}`));
  });
  const v2 = isSamePath(rootDir, sourceRoot) ? [] : collectV2Tasks(sourceRoot);
  return uniqueEntries([...rootTasks, ...moduleTasks, ...v2]);
}

function collectV2Tasks(sourceRoot: string): ReadonlyArray<LegacyScanEntry> {
  if (!hasExplicitHarnessConfig(sourceRoot)) return [];
  let layout: ReturnType<typeof resolveHarnessLayout>;
  try {
    layout = resolveHarnessLayout(sourceRoot);
  } catch {
    return [];
  }
  const entries: LegacyScanEntry[] = [];
  if (isPathInside(sourceRoot, layout.tasksRoot)) {
    entries.push(...listDirectories(layout.tasksRoot)
      .filter((name) => !name.startsWith("_"))
      .map((name) => taskEntry(sourceRoot, normalizeSlashes(path.relative(sourceRoot, path.join(layout.tasksRoot, name))), `harness/legacy/tasks/${name}`)));
  }
  const modulesRoot = path.join(layout.planningRoot, "modules");
  if (isPathInside(sourceRoot, modulesRoot)) {
    for (const moduleKey of listDirectories(modulesRoot)) {
      if (moduleKey.startsWith("_")) continue;
      const moduleTasksRoot = path.join(modulesRoot, moduleKey, "tasks");
      entries.push(...listDirectories(moduleTasksRoot)
        .filter((name) => !name.startsWith("_"))
        .map((name) => taskEntry(sourceRoot, normalizeSlashes(path.relative(sourceRoot, path.join(moduleTasksRoot, name))), `harness/legacy/tasks/modules/${moduleKey}/${name}`)));
    }
  }
  return entries;
}

function collectLegacyDocs(rootInput: HarnessLayoutInput, sourceRoot: string): ReadonlyArray<LegacyScanEntry> {
  const rootDir = resolveHarnessLayout(rootInput).rootDir;
  const docsRoot = path.join(sourceRoot, "docs");
  const docsEntries = walkFiles(docsRoot)
    .map((filePath) => normalizeSlashes(path.relative(sourceRoot, filePath)))
    .flatMap((relativePath) => safeDocEntry(rootDir, sourceRoot, relativePath));
  if (!hasExplicitHarnessConfig(sourceRoot)) return docsEntries;
  if (isSamePath(rootDir, sourceRoot)) return docsEntries;
  let layout: ReturnType<typeof resolveHarnessLayout>;
  try {
    layout = resolveHarnessLayout(sourceRoot);
  } catch {
    return docsEntries;
  }
  const authoredDocRoots = [
    { root: layout.contextRoot, forwardRoot: resolveHarnessLayout(rootInput).contextRoot },
    { root: layout.standardsRoot, forwardRoot: resolveHarnessLayout(rootInput).standardsRoot }
  ];
  const authoredEntries = authoredDocRoots.flatMap(({ root, forwardRoot }) => {
    if (!isPathInside(sourceRoot, root)) return [];
    return walkFiles(root)
      .map((filePath) => normalizeSlashes(path.relative(sourceRoot, filePath)))
      .flatMap((relativePath) => safeAuthoredDocEntry(rootDir, sourceRoot, relativePath, forwardRoot, root));
  });
  return uniqueEntries([...docsEntries, ...authoredEntries]);
}

function taskEntry(sourceRoot: string, sourcePath: string, storedPath: string): LegacyIndexEntry {
  const fullPath = path.join(sourceRoot, sourcePath);
  const title = readTitle(fullPath) ?? path.basename(sourcePath);
  const status = readDetectedStatus(fullPath);
  return {
    id: legacyId(sourcePath),
    category: "task",
    sourcePath,
    storedPath,
    sourceDigest: digestPath(fullPath),
    title,
    detectedStatus: status ? { raw: status, confidence: "medium" } : { raw: "unknown", confidence: "low" },
    evidencePointers: evidencePointers(fullPath, storedPath),
    recommendedTreatment: status === "done" || status === "cancelled" ? "preserve" : "rebuild-required",
    humanReviewRequired: true
  };
}

function docEntry(sourceRoot: string, sourcePath: string, storedPath: string, forwardPath?: string): LegacyScanEntry {
  const fullPath = path.join(sourceRoot, sourcePath);
  return {
    id: legacyId(sourcePath),
    category: "doc",
    sourcePath,
    storedPath,
    sourceDigest: digestPath(fullPath),
    title: path.basename(sourcePath),
    evidencePointers: [],
    recommendedTreatment: "preserve",
    humanReviewRequired: false,
    forwardPath
  };
}

function evidencePointers(fullPath: string, storedPath: string): LegacyIndexEntry["evidencePointers"] {
  if (!statSync(fullPath).isDirectory()) return [];
  return ["progress.md", "review.md"]
    .filter((fileName) => existsSync(path.join(fullPath, fileName)))
    .map((fileName) => ({
      kind: fileName === "review.md" ? "review" as const : "progress" as const,
      path: `${storedPath}/${fileName}`,
      label: fileName
    }));
}

function safeDocEntry(rootDir: string, sourceRoot: string, relativePath: string): ReadonlyArray<LegacyScanEntry> {
  if (!isSafeDocPath(relativePath)) return [];
  const targetLayout = resolveHarnessLayout(rootDir);
  const forwardPath = forwardPathForDocsPath(rootDir, targetLayout, relativePath);
  return [docEntry(sourceRoot, relativePath, `harness/legacy/docs/${relativePath.replace(/^docs\//u, "")}`, forwardPath)];
}

function safeAuthoredDocEntry(
  rootDir: string,
  sourceRoot: string,
  relativePath: string,
  forwardRoot: string,
  sourceAuthoredRoot: string
): ReadonlyArray<LegacyScanEntry> {
  if (!isSafeDocPath(relativePath, false)) return [];
  const relWithinAuthoredRoot = normalizeSlashes(path.relative(sourceAuthoredRoot, path.join(sourceRoot, relativePath)));
  const forwardPath = normalizeSlashes(path.relative(rootDir, path.join(forwardRoot, relWithinAuthoredRoot)));
  return [docEntry(sourceRoot, relativePath, `harness/legacy/docs/${relativePath}`, forwardPath.startsWith("..") ? undefined : forwardPath)];
}

function isSafeDocPath(relativePath: string, requireDocsPrefix = true): boolean {
  if (requireDocsPrefix && !relativePath.startsWith("docs/")) return false;
  if (isGeneratedOrVendorPath(relativePath)) return false;
  if (!/\.(?:md|mdx|txt|json|ya?ml)$/u.test(relativePath)) return false;
  if (/^docs\/09-PLANNING\/TASKS\//u.test(relativePath)) return false;
  if (/^docs\/09-PLANNING\/MODULES\/[^/]+\/TASKS\//u.test(relativePath)) return false;
  return true;
}

function forwardPathForDocsPath(rootDir: string, targetLayout: ReturnType<typeof resolveHarnessLayout>, relativePath: string): string | undefined {
  const mappings: ReadonlyArray<readonly [RegExp, string]> = [
    [/^docs\/11-REFERENCE\/(.+)$/u, targetLayout.standardsRoot],
    [/^docs\/10-ARCHITECTURE\/(.+)$/u, path.join(targetLayout.contextRoot, "architecture")],
    [/^docs\/context\/(.+)$/u, targetLayout.contextRoot],
    [/^docs\/architecture\/(.+)$/u, path.join(targetLayout.contextRoot, "architecture")]
  ];
  for (const [pattern, targetRoot] of mappings) {
    const match = pattern.exec(relativePath);
    if (!match) continue;
    const forwardPath = normalizeSlashes(path.relative(rootDir, path.join(targetRoot, match[1])));
    return forwardPath.startsWith("..") ? undefined : forwardPath;
  }
  return undefined;
}

function hasExplicitHarnessConfig(sourceRoot: string): boolean {
  return existsSync(path.join(sourceRoot, "harness", "harness.yaml"))
    || existsSync(path.join(sourceRoot, ".harness-private", "coding-agent-harness", "harness.yaml"));
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/gu, "\\|");
}

function uniqueEntries(entries: ReadonlyArray<LegacyScanEntry>): ReadonlyArray<LegacyScanEntry> {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.category}:${entry.sourcePath}:${entry.storedPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isSafeRelativePath(relativePath: string): boolean {
  return relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = path.relative(parent, candidate);
  return relativePath === "" || isSafeRelativePath(relativePath);
}

function isSamePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

export function copySource(source: string, target: string): void {
  const linkStats = lstatSync(source);
  if (linkStats.isSymbolicLink()) return;
  const stats = statSync(source);
  if (stats.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      copySource(path.join(source, entry.name), path.join(target, entry.name));
    }
    return;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(source));
}

function walkFiles(directory: string): ReadonlyArray<string> {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) {
      if (isGeneratedOrVendorPath(entry.name)) return [];
      return walkFiles(entryPath);
    }
    return [entryPath];
  }).sort();
}

function isGeneratedOrVendorPath(relativePath: string): boolean {
  const normalized = normalizeSlashes(relativePath);
  const segments = normalized.split("/");
  return segments.includes("node_modules")
    || segments.includes(".git")
    || segments.includes(".next")
    || segments.includes(".turbo")
    || segments.includes("dist")
    || segments.includes("build")
    || segments.includes("coverage")
    || normalized === ".harness/generated"
    || normalized.startsWith(".harness/generated/")
    || normalized === "harness/legacy"
    || normalized.startsWith("harness/legacy/");
}

function listDirectories(directory: string): ReadonlyArray<string> {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readTitle(directory: string): string | undefined {
  const indexPath = path.join(directory, "INDEX.md");
  const taskPlanPath = path.join(directory, "task_plan.md");
  const body = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : existsSync(taskPlanPath) ? readFileSync(taskPlanPath, "utf8") : "";
  return body.match(/^title:\s*(.+)$/mu)?.[1]?.trim() ?? body.match(/^#\s+(.+)$/mu)?.[1]?.trim();
}

function readDetectedStatus(directory: string): string | undefined {
  const indexPath = path.join(directory, "INDEX.md");
  if (!existsSync(indexPath)) return undefined;
  const body = readFileSync(indexPath, "utf8");
  return body.match(/^status:\s*(.+)$/mu)?.[1]?.trim();
}

function digestPath(targetPath: string): `sha256:${string}` {
  const hash = createHash("sha256");
  const stats = statSync(targetPath);
  if (stats.isDirectory()) {
    for (const filePath of walkFiles(targetPath)) {
      hash.update(normalizeSlashes(path.relative(targetPath, filePath)));
      hash.update("\0");
      hash.update(readFileSync(filePath));
      hash.update("\0");
    }
  } else {
    hash.update(readFileSync(targetPath));
  }
  return `sha256:${hash.digest("hex")}`;
}

function legacyId(sourcePath: string): string {
  const digest = sha256Text(sourcePath).slice(0, 12);
  return `legacy_${digest}`;
}

function normalizeSlashes(value: string): string {
  return value.split(path.sep).join("/");
}
