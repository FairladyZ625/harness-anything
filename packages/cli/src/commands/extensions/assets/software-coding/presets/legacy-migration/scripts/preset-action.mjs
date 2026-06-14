#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const contextPath = process.env.HARNESS_PRESET_CONTEXT;
if (!contextPath) throw new Error("HARNESS_PRESET_CONTEXT is required");
const context = JSON.parse(readFileSync(contextPath, "utf8"));
const artifactsDir = path.join(context.outputRoot, "artifacts");
mkdirSync(artifactsDir, { recursive: true });

const scan = selectScan(context.paths.rootDir);
const report = {
  schema: "legacy-migration-preset-plan/v1",
  taskId: context.taskId,
  scan,
  guidance: [
    "Legacy Intake preserves old evidence under harness/legacy.",
    "Safe authored context and standards may be forwarded into the active harness tree.",
    "Active task packages are rebuilt by explicit follow-up tasks; the plan does not promise unattended conversion."
  ]
};
writeFileSync(path.join(artifactsDir, "legacy-migration-plan.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(path.join(artifactsDir, "legacy-migration-plan.md"), renderPlan(scan), "utf8");
writeFileSync(path.join(artifactsDir, "preset-result.json"), `${JSON.stringify({ ok: true, rows: scan.entries.length, report }, null, 2)}\n`, "utf8");

function selectScan(rootDir) {
  const rootScan = buildScan(rootDir, ".");
  if (rootScan.entries.length > 0) return rootScan;
  const childScan = listCandidateRoots(rootDir)
    .map((sourcePath) => buildScan(rootDir, sourcePath))
    .find((scan) => scan.entries.length > 0);
  return childScan ?? rootScan;
}

function buildScan(rootDir, sourcePath) {
  const sourceRoot = path.resolve(rootDir, sourcePath);
  const entries = uniqueEntries([
    ...collectOldTasks(sourceRoot),
    ...collectV2Tasks(sourceRoot),
    ...collectDocs(rootDir, sourceRoot)
  ]);
  return {
    schema: "legacy-intake-scan/v1",
    strategy: "legacy-intake",
    legacyRoot: "harness/legacy",
    sourceRoot: toSlash(path.relative(rootDir, sourceRoot) || "."),
    entries,
    summary: summarize(entries),
    deprecatedAliases: ["migrate-plan", "migrate-structure", "migrate-run", "migrate-verify"]
  };
}

function collectOldTasks(sourceRoot) {
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
  return [...rootTasks, ...moduleTasks];
}

function collectV2Tasks(sourceRoot) {
  const privateRoot = path.join(sourceRoot, ".harness-private/coding-agent-harness");
  const publicRoot = path.join(sourceRoot, "harness");
  const authoredRoot = existsSync(path.join(privateRoot, "harness.yaml")) ? privateRoot : existsSync(path.join(publicRoot, "harness.yaml")) ? publicRoot : undefined;
  if (!authoredRoot) return [];
  const tasksRoot = path.join(authoredRoot, "planning/tasks");
  const moduleRoot = path.join(authoredRoot, "planning/modules");
  const rootTasks = listDirectories(tasksRoot)
    .filter((name) => !name.startsWith("_"))
    .map((name) => taskEntry(sourceRoot, toSlash(path.relative(sourceRoot, path.join(tasksRoot, name))), `harness/legacy/tasks/${name}`));
  const moduleTasks = listDirectories(moduleRoot).flatMap((moduleKey) => {
    if (moduleKey.startsWith("_")) return [];
    const moduleTasksRoot = path.join(moduleRoot, moduleKey, "tasks");
    return listDirectories(moduleTasksRoot)
      .filter((name) => !name.startsWith("_"))
      .map((name) => taskEntry(sourceRoot, toSlash(path.relative(sourceRoot, path.join(moduleTasksRoot, name))), `harness/legacy/tasks/modules/${moduleKey}/${name}`));
  });
  return [...rootTasks, ...moduleTasks];
}

function collectDocs(rootDir, sourceRoot) {
  const docsEntries = walkFiles(path.join(sourceRoot, "docs"))
    .map((filePath) => toSlash(path.relative(sourceRoot, filePath)))
    .filter((relativePath) => isSafeDocPath(relativePath, true))
    .map((relativePath) => docEntry(sourceRoot, relativePath, `harness/legacy/docs/${relativePath.replace(/^docs\//u, "")}`, forwardPathForOldDoc(relativePath)));
  const privateRoot = path.join(sourceRoot, ".harness-private/coding-agent-harness");
  const publicRoot = path.join(sourceRoot, "harness");
  const authoredRoot = existsSync(path.join(privateRoot, "harness.yaml")) ? privateRoot : existsSync(path.join(publicRoot, "harness.yaml")) ? publicRoot : undefined;
  if (!authoredRoot) return docsEntries;
  const authoredDocs = [
    ...collectAuthoredDocs(rootDir, sourceRoot, path.join(authoredRoot, "context"), "harness/context"),
    ...collectAuthoredDocs(rootDir, sourceRoot, path.join(authoredRoot, "standards"), "harness/standards")
  ];
  return uniqueEntries([...docsEntries, ...authoredDocs]);
}

function collectAuthoredDocs(rootDir, sourceRoot, sourceDocRoot, forwardRoot) {
  return walkFiles(sourceDocRoot)
    .map((filePath) => toSlash(path.relative(sourceRoot, filePath)))
    .filter((relativePath) => isSafeDocPath(relativePath, false))
    .map((relativePath) => {
      const relWithinRoot = toSlash(path.relative(sourceDocRoot, path.join(sourceRoot, relativePath)));
      return docEntry(sourceRoot, relativePath, `harness/legacy/docs/${relativePath}`, `${forwardRoot}/${relWithinRoot}`);
    });
}

function taskEntry(sourceRoot, sourcePath, storedPath) {
  const fullPath = path.join(sourceRoot, sourcePath);
  const status = readDetectedStatus(fullPath);
  return {
    id: legacyId(sourcePath),
    category: "task",
    sourcePath,
    storedPath,
    sourceDigest: digestPath(fullPath),
    title: readTitle(fullPath) ?? path.basename(sourcePath),
    detectedStatus: status ? { raw: status, confidence: "medium" } : { raw: "unknown", confidence: "low" },
    evidencePointers: evidencePointers(fullPath, storedPath),
    recommendedTreatment: status === "done" || status === "cancelled" ? "preserve" : "rebuild-required",
    humanReviewRequired: true
  };
}

function docEntry(sourceRoot, sourcePath, storedPath, forwardPath) {
  return {
    id: legacyId(sourcePath),
    category: "doc",
    sourcePath,
    storedPath,
    sourceDigest: digestPath(path.join(sourceRoot, sourcePath)),
    title: path.basename(sourcePath),
    evidencePointers: [],
    recommendedTreatment: "preserve",
    humanReviewRequired: false,
    forwardPath
  };
}

function renderPlan(scan) {
  return [
    "# Legacy Intake Plan",
    "",
    `Source root: ${scan.sourceRoot}`,
    `Entries: ${scan.summary.entryCount}`,
    "",
    "| ID | Title | Category | Source | Stored | Forward | Treatment |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...scan.entries.map((entry) => `| ${entry.id} | ${escapeCell(entry.title ?? "")} | ${entry.category} | ${entry.sourcePath} | ${entry.storedPath} | ${entry.forwardPath ?? ""} | ${entry.recommendedTreatment} |`),
    ""
  ].join("\n");
}

function forwardPathForOldDoc(relativePath) {
  const mappings = [
    [/^docs\/11-REFERENCE\/(.+)$/u, "harness/standards"],
    [/^docs\/10-ARCHITECTURE\/(.+)$/u, "harness/context/architecture"],
    [/^docs\/context\/(.+)$/u, "harness/context"],
    [/^docs\/architecture\/(.+)$/u, "harness/context/architecture"]
  ];
  for (const [pattern, targetRoot] of mappings) {
    const match = pattern.exec(relativePath);
    if (match) return `${targetRoot}/${match[1]}`;
  }
  return undefined;
}

function evidencePointers(fullPath, storedPath) {
  if (!statSync(fullPath).isDirectory()) return [];
  return ["progress.md", "review.md", "walkthrough.md"]
    .filter((fileName) => existsSync(path.join(fullPath, fileName)))
    .map((fileName) => ({
      kind: fileName === "review.md" ? "review" : fileName === "walkthrough.md" ? "walkthrough" : "progress",
      path: `${storedPath}/${fileName}`,
      label: fileName
    }));
}

function listCandidateRoots(rootDir) {
  const roots = new Set();
  for (const readScope of context.readScopes ?? []) {
    const candidate = candidateRootFromReadScope(rootDir, readScope);
    if (candidate && candidate !== ".") roots.add(candidate);
  }
  return [...roots]
    .sort()
    .filter((sourcePath) => existsSync(path.join(rootDir, sourcePath, "docs"))
      || existsSync(path.join(rootDir, sourcePath, "harness/harness.yaml"))
      || existsSync(path.join(rootDir, sourcePath, ".harness-private/coding-agent-harness/harness.yaml")));
}

function candidateRootFromReadScope(rootDir, readScope) {
  const relativePath = toSlash(path.relative(rootDir, readScope));
  if (!relativePath || relativePath.startsWith("../")) return ".";
  const segments = relativePath.split("/");
  const markerIndex = segments.findIndex((segment) => segment === "docs" || segment === "harness" || segment === ".harness-private");
  if (markerIndex <= 0) return ".";
  return segments.slice(0, markerIndex).join("/");
}

function isSafeDocPath(relativePath, requireDocsPrefix) {
  if (requireDocsPrefix && !relativePath.startsWith("docs/")) return false;
  if (!/\.(?:md|mdx|txt|json|ya?ml)$/u.test(relativePath)) return false;
  if (/^docs\/09-PLANNING\/TASKS\//u.test(relativePath)) return false;
  if (/^docs\/09-PLANNING\/MODULES\/[^/]+\/TASKS\//u.test(relativePath)) return false;
  return true;
}

function summarize(entries) {
  return {
    entryCount: entries.length,
    taskCount: entries.filter((entry) => entry.category === "task").length,
    docCount: entries.filter((entry) => entry.category === "doc").length,
    rebuildRequiredCount: entries.filter((entry) => entry.recommendedTreatment === "rebuild-required").length
  };
}

function uniqueEntries(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.category}:${entry.sourcePath}:${entry.storedPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function walkFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return walkFiles(entryPath);
    if (!entry.isFile()) return [];
    return [entryPath];
  }).sort();
}

function listDirectories(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function readTitle(directory) {
  const indexPath = path.join(directory, "INDEX.md");
  const taskPlanPath = path.join(directory, "task_plan.md");
  const body = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : existsSync(taskPlanPath) ? readFileSync(taskPlanPath, "utf8") : "";
  return body.match(/^title:\s*(.+)$/mu)?.[1]?.trim() ?? body.match(/^#\s+(.+)$/mu)?.[1]?.trim();
}

function readDetectedStatus(directory) {
  const indexPath = path.join(directory, "INDEX.md");
  if (!existsSync(indexPath)) return undefined;
  return readFileSync(indexPath, "utf8").match(/^status:\s*(.+)$/mu)?.[1]?.trim();
}

function digestPath(targetPath) {
  if (lstatSync(targetPath).isSymbolicLink()) {
    return `sha256:${createHash("sha256").update("symlink-skipped").digest("hex")}`;
  }
  const hash = createHash("sha256");
  const stats = statSync(targetPath);
  if (stats.isDirectory()) {
    for (const filePath of walkFiles(targetPath)) {
      hash.update(toSlash(path.relative(targetPath, filePath)));
      hash.update("\0");
      hash.update(readFileSync(filePath));
      hash.update("\0");
    }
  } else {
    hash.update(readFileSync(targetPath));
  }
  return `sha256:${hash.digest("hex")}`;
}

function legacyId(sourcePath) {
  return `legacy_${createHash("sha256").update(sourcePath).digest("hex").slice(0, 12)}`;
}

function escapeCell(value) {
  return value.replace(/\|/gu, "\\|");
}

function toSlash(value) {
  return value.split(path.sep).join("/");
}
