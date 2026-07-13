#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateArchitectureInitReport } from "../architecture/contracts/architecture-operation-reports.mjs";

const contextPath = process.env.HARNESS_SCRIPT_CONTEXT;
const resultPath = process.env.HARNESS_SCRIPT_RESULT;
if (!contextPath || !resultPath) throw new Error("HARNESS_SCRIPT_CONTEXT and HARNESS_SCRIPT_RESULT are required");

const context = JSON.parse(readFileSync(contextPath, "utf8"));
const assetRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const architectureRoot = path.join(context.outputRoot, "architecture");
const assets = [
  ["templates/repository.architecture.manifest/en-US.md", "architecture-manifest.json"],
  ["templates/repository.architecture.likec4.config/en-US.md", "model/likec4.config.json"],
  ["templates/repository.architecture.likec4.specification/en-US.md", "model/specification.c4"],
  ["templates/repository.architecture.likec4.model/en-US.md", "model/model.c4"],
  ["templates/repository.architecture.likec4.view.landscape/en-US.md", "model/views/landscape.c4"],
  ["templates/repository.architecture.likec4.view.write-path/en-US.md", "model/views/write-path.c4"],
  ["templates/repository.architecture.likec4.view.runtime/en-US.md", "model/views/runtime.c4"]
].map(([source, target]) => ({
  sourcePath: path.join(assetRoot, source),
  relativeTarget: target,
  targetPath: path.join(architectureRoot, ...target.split("/")),
  body: readFileSync(path.join(assetRoot, source), "utf8")
}));

if (context.taskId) {
  writeResult(false, {
    schema: "architecture-init-report/v1",
    status: "invalid",
    created: [],
    unchanged: [],
    conflicts: [],
    issues: [{
      code: "architecture_init_task_not_allowed",
      path: "taskId",
      message: "Architecture init targets repository context and must be run without --task."
    }],
    nextActions: ["Rerun architecture-init without --task."]
  });
  process.exit(0);
}

const outputRootKind = filesystemKind(context.outputRoot);
const architectureRootKind = filesystemKind(architectureRoot);
const declaredArchitectureRootAliases = declaredPortableRootAliases(context, context.outputRoot, architectureRoot);
const rootConflictKind = outputRootKind !== "missing" && outputRootKind !== "directory"
  ? `output-root-${outputRootKind}`
  : architectureRootKind !== "missing" && architectureRootKind !== "directory"
    ? `architecture-root-${architectureRootKind}`
    : null;
const architectureRootAliases = rootConflictKind
  ? []
  : [...new Set(declaredArchitectureRootAliases)].sort();
const existingEntries = rootConflictKind || architectureRootAliases.length > 0
  ? []
  : collectExistingEntries(architectureRoot);
const conflicts = rootConflictKind
  ? assets.map((asset) => ({
    path: repositoryRelative(context.paths.rootDir, asset.targetPath),
    reason: rootConflictKind,
    existingAliases: [repositoryRelative(
      context.paths.rootDir,
      rootConflictKind.startsWith("output-root-") ? context.outputRoot : architectureRoot
    )],
    remediation: "Replace the symlink or non-directory parent with a regular repository directory; initialization never follows authored output symlinks."
  }))
  : architectureRootAliases.length > 0
    ? assets.map((asset) => rootAliasConflict(asset, architectureRootAliases))
    : [];
const unchanged = [];
const missing = [];
for (const asset of rootConflictKind || architectureRootAliases.length > 0 ? [] : assets) {
  const aliases = aliasesForTarget(existingEntries, asset.relativeTarget);
  if (aliases.length > 0) {
    conflicts.push(conflict(asset, "portable-path-collision", aliases));
    continue;
  }
  const parentConflict = firstParentConflict(architectureRoot, asset.relativeTarget);
  if (parentConflict) {
    conflicts.push(conflict(asset, parentConflict.reason, [parentConflict.path]));
    continue;
  }
  const kind = filesystemKind(asset.targetPath);
  if (kind === "missing") {
    missing.push(asset);
  } else if (kind === "file" && readFileSync(asset.targetPath, "utf8") === asset.body) {
    unchanged.push(repositoryRelative(context.paths.rootDir, asset.targetPath));
  } else {
    conflicts.push(conflict(asset, kind === "file" ? "content-differs" : `existing-${kind}`, []));
  }
}

if (conflicts.length > 0) {
  writeResult(false, {
    schema: "architecture-init-report/v1",
    status: "conflict",
    created: [],
    unchanged: unchanged.sort(),
    conflicts: conflicts.sort((left, right) => left.path.localeCompare(right.path)),
    issues: [],
    nextActions: [
      "Review or migrate every conflicting path, then rerun architecture-init.",
      "Harness did not overwrite or partially materialize any architecture asset."
    ]
  });
  process.exit(0);
}

const created = [];
for (const asset of missing) {
  mkdirSync(path.dirname(asset.targetPath), { recursive: true });
  writeFileSync(asset.targetPath, asset.body, "utf8");
  created.push(repositoryRelative(context.paths.rootDir, asset.targetPath));
}
writeResult(true, {
  schema: "architecture-init-report/v1",
  status: created.length > 0 ? "initialized" : "unchanged",
  created: created.sort(),
  unchanged: unchanged.sort(),
  conflicts: [],
  issues: [],
  nextActions: created.length > 0
    ? ["Replace every draft placeholder with repository evidence before running architecture-snapshot."]
    : []
}, created);

function collectExistingEntries(root) {
  if (!existsSync(root)) return [];
  const entries = [];
  walk(root, "");
  return entries;

  function walk(directory, relativeDirectory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      entries.push(relativePath);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path.join(directory, entry.name), relativePath);
    }
  }
}

function aliasesForTarget(entries, relativeTarget) {
  const targetParts = relativeTarget.split("/");
  const targetPrefixes = targetParts.map((_, index) => targetParts.slice(0, index + 1).join("/"));
  const exactPrefixes = new Set(targetPrefixes);
  const portablePrefixes = new Set(targetPrefixes.map(portableKey));
  return entries
    .filter((entry) => portablePrefixes.has(portableKey(entry)) && !exactPrefixes.has(entry))
    .sort();
}

function declaredPortableRootAliases(value, parent, expectedPath) {
  const aliases = [
    ...(Array.isArray(value?.declaredScopeConflicts?.read) ? value.declaredScopeConflicts.read : []),
    ...(Array.isArray(value?.declaredScopeConflicts?.write) ? value.declaredScopeConflicts.write : [])
  ];
  const expectedName = path.basename(expectedPath);
  return aliases.filter((alias) =>
    typeof alias === "string" &&
    path.resolve(path.dirname(alias)) === path.resolve(parent) &&
    path.basename(alias) !== expectedName &&
    portableKey(path.basename(alias)) === portableKey(expectedName)
  );
}

function firstParentConflict(root, relativeTarget) {
  const parts = relativeTarget.split("/").slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const kind = filesystemKind(current);
    if (kind === "missing") return null;
    if (kind !== "directory") return {
      reason: `parent-${kind}`,
      path: path.relative(architectureRoot, current).split(path.sep).join("/")
    };
  }
  return null;
}

function conflict(asset, reason, aliases) {
  return {
    path: repositoryRelative(context.paths.rootDir, asset.targetPath),
    reason,
    existingAliases: aliases.map((entry) => repositoryRelative(context.paths.rootDir, path.join(architectureRoot, ...entry.split("/")))),
    remediation: "Review or migrate the existing path; initialization never overwrites authored architecture content."
  };
}

function rootAliasConflict(asset, aliases) {
  return {
    path: repositoryRelative(context.paths.rootDir, asset.targetPath),
    reason: "portable-path-collision",
    existingAliases: aliases.map((alias) => repositoryRelative(context.paths.rootDir, alias)),
    remediation: "Review or migrate the portable-equivalent architecture root; initialization never creates case- or normalization-variant authored roots."
  };
}

function filesystemKind(filePath) {
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch {
    return "missing";
  }
}

function portableKey(value) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function repositoryRelative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function writeResult(ok, report, produced = []) {
  const validation = validateArchitectureInitReport(report);
  if (!validation.ok) throw new Error(`Invalid architecture-init-report/v1: ${validation.issues.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`);
  writeFileSync(resultPath, JSON.stringify({
    schema: "script-result/v1",
    ok,
    report,
    produced
  }), "utf8");
}
