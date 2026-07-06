#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const contextPath = process.env.HARNESS_SCRIPT_CONTEXT ?? process.env.HARNESS_PRESET_CONTEXT;
if (!contextPath) throw new Error("HARNESS_SCRIPT_CONTEXT or HARNESS_PRESET_CONTEXT is required");

const context = readJson(contextPath);
const paths = context.paths ?? {};
const inputs = context.inputs ?? {};
const rootDir = paths.rootDir;
const outputRoot = context.outputRoot;
const coordinationTaskId = inputs.coordinationTaskId && inputs.coordinationTaskId !== "{{taskId}}"
  ? inputs.coordinationTaskId
  : context.taskId;

if (!rootDir) throw new Error("context.paths.rootDir is required");
if (!outputRoot) throw new Error("context.outputRoot is required");
if (!coordinationTaskId) throw new Error("coordinationTaskId input or task context is required");

const artifactsDir = path.join(outputRoot, "artifacts");
mkdirSync(artifactsDir, { recursive: true });

const packageJson = readJson(path.join(rootDir, "package.json"));
const manifest = readJson(path.join(rootDir, "tools", "gate-manifest.json"));
const allowlists = readAllowlists(path.join(rootDir, "tools", "gate-allowlists"));
const knownDebt = await readKnownDebt(path.join(rootDir, "tools", "kernel-import-boundary-known-debt.mjs"));
const eslintBoundary = readEslintBoundary(path.join(rootDir, "eslint.config.mjs"));
const checkGateSurface = readCheckGateSurface(path.join(rootDir, "tools", "check-gate-surface.mjs"));
const importGraph = readImportGraph(rootDir);
const fileInventory = readFileInventory(rootDir);
const previousSnapshot = readPreviousSnapshot({
  rootDir,
  tasksRoot: paths.tasksRoot,
  currentTaskId: coordinationTaskId,
  explicitPath: inputs.previousSnapshot
});

const manifestSummary = summarizeManifest(manifest);
const checkDiff = summarizeCheckDiff(packageJson, manifest);
const trends = comparePrevious(previousSnapshot, { allowlists, importGraph, fileInventory, manifestSummary });
const snapshot = {
  schema: "gate-architecture-retro-snapshot/v1",
  generatedAt: new Date().toISOString(),
  presetId: context.presetId ?? "gate-architecture-retrospective",
  entrypoint: context.entrypoint ?? "gather",
  coordinationTaskId,
  dataSources: {
    gateManifest: "tools/gate-manifest.json",
    gateAllowlists: "tools/gate-allowlists/*.json",
    kernelImportKnownDebt: "tools/kernel-import-boundary-known-debt.mjs",
    eslintConfig: "eslint.config.mjs",
    gateSurfaceChecker: "tools/check-gate-surface.mjs",
    packageScripts: "package.json:scripts.check + scripts.check:pr",
    importInventory: "packages/**/*.{ts,tsx,js,mjs} + tools/**/*.mjs",
    previousSnapshot: previousSnapshot ? previousSnapshot.sourcePath : null
  },
  git: {
    head: null,
    note: "Preset sandbox does not execute git; compare fileInventory/importGraph against previous snapshot instead."
  },
  gateManifest: manifestSummary,
  gatePassRate: {
    source: "manifest-declared execution surfaces, not live command execution",
    honestBoundary: "Run npm run check:pr and npm run check separately and paste command/output evidence into artifacts/gate-retro.analysis.md before making a rot accusation.",
    prRequiredTierRate: ratio(manifestSummary.tiers["pr-required"] ?? 0, manifestSummary.gateCount),
    checkPrScriptCoverageRate: ratio(checkDiff.checkPrGateIds.length, manifestSummary.nonAggregateGateCount),
    fullCheckScriptCoverageRate: ratio(checkDiff.checkGateIds.length, manifestSummary.nonAggregateGateCount)
  },
  allowlists,
  knownDebt,
  eslintBoundary,
  checkGateSurface,
  checkDiff,
  importGraph,
  fileInventory,
  trends,
  analysisRequirements: {
    adr0022D6Checklist: [
      "Is the evidence about a boundary gate or only local-consistency?",
      "Did the review use an AST import layer, import graph, or equivalent graph tool for graph invariants?",
      "Is the gate authority external to the gate implementation?",
      "Does every boundary finding have a documented bypass fixture?"
    ],
    defectPatterns: [
      "regex guarding a graph invariant",
      "self-referential authority",
      "authority rewritable in the same PR",
      "ADR text without enforcement code",
      "enforcement surface drift"
    ],
    hardRule: "Every rot accusation must include reproducible command and output evidence. The 171-to-162 baseline correction is the warning example: unsupported impressions do not count."
  },
  output: {
    snapshotJson: "artifacts/gate-retro.snapshot.json",
    snapshotSummary: "artifacts/gate-retro.snapshot.md",
    analysisScaffold: "artifacts/gate-retro.analysis.scaffold.md",
    finalAnalysis: "artifacts/gate-retro.analysis.md"
  }
};

const snapshotPath = path.join(artifactsDir, "gate-retro.snapshot.json");
const summaryPath = path.join(artifactsDir, "gate-retro.snapshot.md");
writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
writeFileSync(summaryPath, renderSummary(snapshot), "utf8");
writeFileSync(path.join(artifactsDir, "preset-result.json"), `${JSON.stringify({
  schema: "script-result/v1",
  ok: true,
  rows: manifestSummary.gateCount,
  report: {
    schema: "gate-architecture-retro-gather-report/v1",
    coordinationTaskId,
    snapshotPath: toRelative(rootDir, snapshotPath),
    summaryPath: toRelative(rootDir, summaryPath),
    summary: {
      gates: manifestSummary.gateCount,
      boundaryGates: manifestSummary.categories.boundary ?? 0,
      allowlistEntries: allowlists.summary.totalEntries,
      knownDebtEntries: knownDebt.summary.entries,
      importEdges: importGraph.summary.edges,
      newFilesSincePreviousSnapshot: trends.fileInventory.added.length
    }
  },
  produced: ["artifacts/gate-retro.snapshot.json", "artifacts/gate-retro.snapshot.md"]
}, null, 2)}\n`, "utf8");

function summarizeManifest(input) {
  const gates = Array.isArray(input.gates) ? input.gates : [];
  const categories = countBy(gates, (gate) => gate.category ?? "unknown");
  const tiers = countBy(gates, (gate) => gate.tier ?? "unknown");
  const boundary = gates.filter((gate) => gate.category === "boundary");
  return {
    schema: input.schema ?? null,
    authorityBasis: input.authorityBasis ?? [],
    gateCount: gates.length,
    nonAggregateGateCount: gates.filter((gate) => !gate.aggregate).length,
    categories,
    tiers,
    boundaryGateIds: boundary.map((gate) => gate.id).sort(),
    boundaryWithoutBypassFixture: boundary.filter((gate) => gate.bypassFixtureRequired !== true).map((gate) => gate.id).sort(),
    allowlistLocations: gates.flatMap((gate) => {
      const location = gate.allowlistPolicy?.location;
      return location ? [{ gateId: gate.id, location }] : [];
    }),
    protectedSurfaceGates: gates.filter((gate) => gate.changeControl?.requiresGovernanceEvidence === true).map((gate) => gate.id).sort(),
    surfaces: input.surfaces ?? {}
  };
}

function summarizeCheckDiff(pkg, input) {
  const scripts = pkg.scripts ?? {};
  const checkCommands = splitShellAndList(scripts.check ?? "");
  const checkPrCommands = splitShellAndList(scripts["check:pr"] ?? "");
  const commandToGateIds = new Map();
  for (const gate of Array.isArray(input.gates) ? input.gates : []) {
    if (!gate.command) continue;
    if (!commandToGateIds.has(gate.command)) commandToGateIds.set(gate.command, []);
    commandToGateIds.get(gate.command).push(gate.id);
  }
  const checkGateIds = mapCommands(checkCommands, commandToGateIds);
  const checkPrGateIds = mapCommands(checkPrCommands, commandToGateIds);
  return {
    packageScripts: { check: scripts.check ?? "", checkPr: scripts["check:pr"] ?? "" },
    checkCommands,
    checkPrCommands,
    checkGateIds,
    checkPrGateIds,
    onlyInCheck: checkGateIds.filter((id) => !checkPrGateIds.includes(id)),
    onlyInCheckPr: checkPrGateIds.filter((id) => !checkGateIds.includes(id)),
    commandOnlyInCheck: checkCommands.filter((command) => !checkPrCommands.includes(command)),
    commandOnlyInCheckPr: checkPrCommands.filter((command) => !checkCommands.includes(command))
  };
}

function readAllowlists(dir) {
  const files = existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith(".json")).sort()
    : [];
  const gates = [];
  let totalEntries = 0;
  for (const file of files) {
    const relative = `tools/gate-allowlists/${file}`;
    const raw = readJson(path.join(dir, file));
    const sections = flattenEntryTree(raw.entries ?? {});
    const entryCount = sections.reduce((sum, section) => sum + section.count, 0);
    totalEntries += entryCount;
    gates.push({
      path: relative,
      schema: raw.schema ?? null,
      gateId: raw.gateId ?? path.basename(file, ".json"),
      entryCount,
      sections
    });
  }
  return {
    summary: { files: files.length, totalEntries },
    gates
  };
}

async function readKnownDebt(filename) {
  if (!existsSync(filename)) return { summary: { entries: 0 }, entries: [], unavailable: true };
  const module = await import(pathToFileURL(filename).href);
  const entries = Array.isArray(module.kernelImportBoundaryKnownDebt) ? module.kernelImportBoundaryKnownDebt : [];
  return {
    summary: {
      entries: entries.length,
      byTarget: countBy(entries, (entry) => entry.target ?? "unknown"),
      byDecision: countBy(entries, (entry) => entry.decision ?? "unknown")
    },
    entries
  };
}

function readEslintBoundary(filename) {
  const body = existsSync(filename) ? readFileSync(filename, "utf8") : "";
  return {
    path: "eslint.config.mjs",
    hasNoRestrictedImports: body.includes("no-restricted-imports"),
    hasNoRestrictedSyntax: body.includes("no-restricted-syntax"),
    importsKnownDebtModule: body.includes("kernel-import-boundary-known-debt"),
    exemptsToolsMjs: /files:\s*\[\s*["']tools\/\*\*\/\*\.mjs["']\s*\]/u.test(body),
    kernelDeepImportPatternPresent: body.includes("kernel/src")
  };
}

function readCheckGateSurface(filename) {
  const body = existsSync(filename) ? readFileSync(filename, "utf8") : "";
  return {
    path: "tools/check-gate-surface.mjs",
    present: body.length > 0,
    checksPackageScripts: body.includes("checkPackageScripts"),
    checksRewriteCi: body.includes("checkRewriteCi"),
    checksBranchProtection: body.includes("checkBranchProtection"),
    checksBoundaryFields: body.includes("checkBoundaryFields")
  };
}

function readImportGraph(root) {
  const files = listFilesUnder(root, ["packages", "tools"], (filePath) => /\.(?:ts|tsx|js|mjs)$/u.test(filePath));
  const edges = [];
  for (const file of files) {
    const full = path.join(root, file);
    const body = readFileSync(full, "utf8");
    for (const specifier of extractImportSpecifiers(body)) {
      const edgeKey = `${file}|${specifier}`;
      edges.push({
        edgeKey,
        source: file,
        sourceArea: sourceArea(file),
        specifier,
        kind: specifier.includes("kernel/src/") && !specifier.endsWith("kernel/src/index.ts") ? "kernel-deep-import" : "import"
      });
    }
  }
  const kernelDeepImportEdges = edges.filter((edge) => edge.kind === "kernel-deep-import");
  return {
    extraction: "lexical import/export/dynamic-import inventory for trend detection; use AST or graph-tool commands for final rot evidence.",
    summary: {
      filesScanned: files.length,
      edges: edges.length,
      kernelDeepImportEdges: kernelDeepImportEdges.length,
      bySourceArea: countBy(edges, (edge) => edge.sourceArea),
      kernelDeepImportsBySourceArea: countBy(kernelDeepImportEdges, (edge) => edge.sourceArea)
    },
    edges
  };
}

function readFileInventory(root) {
  const files = listFilesUnder(root, ["packages", "tools"], (filePath) =>
    /\.(?:ts|tsx|js|mjs|json|md|yml|yaml)$/u.test(filePath)
  ).map((file) => {
    const full = path.join(root, file);
    const body = readFileSync(full);
    return {
      path: file,
      size: statSync(full).size,
      sha256: createHash("sha256").update(body).digest("hex")
    };
  });
  return {
    summary: {
      files: files.length,
      byTopLevel: countBy(files, (entry) => entry.path.split("/")[0] ?? "unknown")
    },
    files
  };
}

function readPreviousSnapshot({ rootDir: root, tasksRoot, currentTaskId, explicitPath }) {
  const candidates = [];
  if (explicitPath && explicitPath.trim() !== "") candidates.push(path.resolve(root, explicitPath));
  if (tasksRoot && existsSync(tasksRoot)) {
    for (const taskDir of readdirSync(tasksRoot, { withFileTypes: true })) {
      if (!taskDir.isDirectory() || taskDir.name.includes(currentTaskId)) continue;
      const candidate = path.join(tasksRoot, taskDir.name, "artifacts", "gate-retro.snapshot.json");
      if (existsSync(candidate)) candidates.push(candidate);
    }
  }
  const snapshots = candidates.flatMap((candidate) => {
    try {
      const parsed = readJson(candidate);
      if (parsed.schema !== "gate-architecture-retro-snapshot/v1") return [];
      return [{ sourcePath: toRelative(root, candidate), parsed }];
    } catch {
      return [];
    }
  }).sort((left, right) => String(right.parsed.generatedAt ?? "").localeCompare(String(left.parsed.generatedAt ?? "")));
  return snapshots[0] ?? null;
}

function comparePrevious(previous, current) {
  if (!previous) {
    return {
      previousSnapshot: null,
      allowlists: { changedSections: [], addedEntries: null, removedEntries: null },
      importGraph: { addedEdges: [], removedEdges: [] },
      fileInventory: { added: [], removed: [], changed: [] }
    };
  }
  const old = previous.parsed;
  return {
    previousSnapshot: {
      sourcePath: previous.sourcePath,
      generatedAt: old.generatedAt ?? null,
      coordinationTaskId: old.coordinationTaskId ?? null
    },
    allowlists: compareAllowlistSections(old.allowlists, current.allowlists),
    importGraph: compareByKey(old.importGraph?.edges ?? [], current.importGraph.edges, "edgeKey"),
    fileInventory: compareFileInventory(old.fileInventory?.files ?? [], current.fileInventory.files),
    gateManifest: {
      gateCountDelta: current.manifestSummary.gateCount - Number(old.gateManifest?.gateCount ?? 0),
      boundaryGateCountDelta: (current.manifestSummary.categories.boundary ?? 0) - Number(old.gateManifest?.categories?.boundary ?? 0)
    }
  };
}

function compareAllowlistSections(previous, current) {
  const previousSections = new Map();
  for (const gate of previous?.gates ?? []) {
    for (const section of gate.sections ?? []) previousSections.set(`${gate.gateId}:${section.path}`, section.count);
  }
  const changedSections = [];
  for (const gate of current.gates) {
    for (const section of gate.sections) {
      const key = `${gate.gateId}:${section.path}`;
      const before = previousSections.get(key);
      if (before !== section.count) {
        changedSections.push({ gateId: gate.gateId, section: section.path, before: before ?? 0, after: section.count, delta: section.count - (before ?? 0) });
      }
    }
  }
  return { changedSections };
}

function compareByKey(previousRows, currentRows, key) {
  const previousKeys = new Set(previousRows.map((row) => row[key]));
  const currentKeys = new Set(currentRows.map((row) => row[key]));
  return {
    addedEdges: currentRows.filter((row) => !previousKeys.has(row[key])),
    removedEdges: previousRows.filter((row) => !currentKeys.has(row[key]))
  };
}

function compareFileInventory(previousFiles, currentFiles) {
  const previousByPath = new Map(previousFiles.map((file) => [file.path, file]));
  const currentByPath = new Map(currentFiles.map((file) => [file.path, file]));
  return {
    added: currentFiles.filter((file) => !previousByPath.has(file.path)).map((file) => file.path),
    removed: previousFiles.filter((file) => !currentByPath.has(file.path)).map((file) => file.path),
    changed: currentFiles.filter((file) => previousByPath.has(file.path) && previousByPath.get(file.path).sha256 !== file.sha256).map((file) => file.path)
  };
}

function flattenEntryTree(value, prefix = "entries") {
  if (Array.isArray(value)) return [{ path: prefix, count: value.length, refs: countBy(value, (entry) => entry.ref ?? "missing") }];
  if (!value || typeof value !== "object") return [{ path: prefix, count: 0, refs: {} }];
  return Object.entries(value).flatMap(([key, child]) => flattenEntryTree(child, `${prefix}.${key}`));
}

function splitShellAndList(command) {
  return String(command).split(/\s+&&\s+/u).map((part) => part.trim()).filter(Boolean);
}

function mapCommands(commands, commandToGateIds) {
  return [...new Set(commands.flatMap((command) => commandToGateIds.get(command) ?? []))].sort();
}

function listFilesUnder(root, topDirs, predicate) {
  const output = [];
  for (const topDir of topDirs) {
    const full = path.join(root, topDir);
    if (existsSync(full)) visit(full);
  }
  return output.sort();

  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        const relative = toRelative(root, full);
        if (predicate(relative)) output.push(relative);
      }
    }
  }
}

function extractImportSpecifiers(body) {
  const specifiers = [];
  const patterns = [
    /\bimport\s+(?:[^"'()]*?\s+from\s*)?["']([^"']+)["']/gmu,
    /\bexport\s+(?:[^"']*?\s+from\s*)["']([^"']+)["']/gmu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gmu
  ];
  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function sourceArea(file) {
  const parts = file.split("/");
  if (parts[0] === "tools") return "tools";
  if (parts[0] === "packages" && parts[1]) return `packages/${parts[1]}`;
  return parts[0] ?? "unknown";
}

function renderSummary(snapshot) {
  return [
    "# Gate Architecture Retrospective Snapshot",
    "",
    `Generated: ${snapshot.generatedAt}`,
    `Task: ${snapshot.coordinationTaskId}`,
    "",
    "## Gate Surface",
    "",
    `- Gates: ${snapshot.gateManifest.gateCount}`,
    `- Boundary gates: ${snapshot.gateManifest.categories.boundary ?? 0}`,
    `- PR-required gates: ${snapshot.gateManifest.tiers["pr-required"] ?? 0}`,
    `- check-only gates: ${snapshot.checkDiff.onlyInCheck.join(", ") || "none"}`,
    "",
    "## Allowlists And Known Debt",
    "",
    `- Allowlist files: ${snapshot.allowlists.summary.files}`,
    `- Allowlist entries: ${snapshot.allowlists.summary.totalEntries}`,
    `- Kernel import known debt entries: ${snapshot.knownDebt.summary.entries}`,
    "",
    "## Import Inventory",
    "",
    `- Files scanned: ${snapshot.importGraph.summary.filesScanned}`,
    `- Import edges: ${snapshot.importGraph.summary.edges}`,
    `- Kernel deep import edges: ${snapshot.importGraph.summary.kernelDeepImportEdges}`,
    "",
    "## Previous Snapshot Diff",
    "",
    `- Previous snapshot: ${snapshot.trends.previousSnapshot?.sourcePath ?? "none"}`,
    `- New files: ${snapshot.trends.fileInventory.added.length}`,
    `- Changed files: ${snapshot.trends.fileInventory.changed.length}`,
    `- Added import edges: ${snapshot.trends.importGraph.addedEdges.length}`,
    `- Removed import edges: ${snapshot.trends.importGraph.removedEdges.length}`,
    "",
    "## Evidence Boundary",
    "",
    "This snapshot is machine-readable context. It is not a substitute for the final analysis rule: every rot accusation needs a reproducible command and pasted output.",
    ""
  ].join("\n");
}

function ratio(numerator, denominator) {
  return { numerator, denominator, rate: denominator === 0 ? null : Number((numerator / denominator).toFixed(4)) };
}

function countBy(rows, getKey) {
  const counts = {};
  for (const row of rows) {
    const key = String(getKey(row));
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function readJson(filename) {
  return JSON.parse(readFileSync(filename, "utf8"));
}

function toRelative(root, filename) {
  return path.relative(root, filename).split(path.sep).join("/");
}
