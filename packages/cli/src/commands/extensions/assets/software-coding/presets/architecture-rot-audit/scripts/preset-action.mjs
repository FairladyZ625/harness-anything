#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLensBCandidates, evaluateDetectionResults } from "./detectors/detector-policy.mjs";
import { runSeedDetectors } from "./detectors/seed-detectors.mjs";
import {
  canonicalRoot,
  collectProductFileHashes,
  diffFileHashes,
  readGitHead,
  selectPriorSnapshot
} from "./snapshot.mjs";

const contextPath = process.env.HARNESS_PRESET_CONTEXT;
if (!contextPath) throw new Error("HARNESS_PRESET_CONTEXT is required");
const context = JSON.parse(readFileSync(contextPath, "utf8"));
if (context.entrypoint !== "check") throw new Error(`Unsupported architecture-rot-audit entrypoint: ${context.entrypoint}`);

const presetRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(path.join(presetRoot, "registry", "architecture-rot-registry.json"), "utf8"));
const rootDir = context.paths.rootDir;
const artifactsDir = path.join(context.outputRoot, "artifacts");
const generatedAt = new Date().toISOString();
const git = readGitHead(rootDir);
const previous = selectPriorSnapshot(context.paths.tasksRoot, context.taskId);
const detectorResults = runSeedDetectors(rootDir, registry.records);
const evaluation = evaluateDetectionResults(registry.records, detectorResults);
const fileHashes = collectProductFileHashes(rootDir);
const fileDiff = diffFileHashes(fileHashes, previous.snapshot?.fileHashes);
const changedSurface = [...new Set([...fileDiff.added, ...fileDiff.changed])].sort();
const candidates = buildLensBCandidates(changedSurface);
const warningMessages = [
  ...previous.warnings,
  ...evaluation.warnings.map((warning) => `${warning.id}: ${warning.interpretation}`),
  ...(git.headVerification === "unverified" ? ["Git HEAD could not be verified through read-only repository metadata."] : [])
];

const currentRecords = registry.records.map((record) => {
  const item = evaluation.items.find((candidate) => candidate.id === record.id);
  return {
    ...record,
    status: item.snapshotStatus,
    lastRun: {
      executedAt: generatedAt,
      head: git.sourceHead,
      executionOutcome: item.detectorOutcome === "unverified" ? "unverified" : "completed",
      exitCode: item.exitCode,
      stdout: item.evidence === null ? null : `${JSON.stringify(item.evidence)}\n`,
      stderr: item.error ?? "",
      mechanismVerdict: item.detectorOutcome,
      interpretation: item.interpretation
    }
  };
});
const fixedItems = evaluation.items.filter((item) => item.registryStatus === "fixed");
const snapshot = {
  schema: "architecture-rot-snapshot/v1",
  generatedAt,
  presetId: "architecture-rot-audit",
  coordinationTaskId: context.taskId,
  registryId: registry.registryId,
  root: {
    realpath: canonicalRoot(rootDir),
    ...git
  },
  previousSnapshot: previous.snapshot ? {
    sourcePath: toRootRelative(rootDir, previous.sourcePath),
    generatedAt: previous.snapshot.generatedAt,
    coordinationTaskId: previous.snapshot.coordinationTaskId
  } : null,
  registry: {
    schema: registry.schema,
    records: currentRecords
  },
  lensA: {
    fixedChecked: fixedItems.length,
    passes: fixedItems.filter((item) => item.detectorOutcome === "pass").map((item) => item.id),
    recurrences: fixedItems.filter((item) => item.detectorOutcome === "fail").map((item) => item.id),
    unverified: fixedItems.filter((item) => item.detectorOutcome === "unverified").map((item) => item.id),
    items: evaluation.items
  },
  lensB: {
    basis: previous.snapshot ? "previous-snapshot-file-hashes" : "full-baseline",
    ...fileDiff,
    candidates
  },
  fileHashes,
  warnings: warningMessages,
  verdict: evaluation.ok ? "passed" : "blocked"
};
const triage = {
  schema: "architecture-rot-triage/v1",
  generatedAt,
  coordinationTaskId: context.taskId,
  blocking: false,
  basis: snapshot.lensB.basis,
  changedSurface,
  candidates,
  note: "Lens-B candidates require human triage and never block this preset check by themselves."
};

mkdirSync(artifactsDir, { recursive: true });
writeJson(path.join(artifactsDir, "arch-rot.snapshot.json"), snapshot);
writeJson(path.join(artifactsDir, "arch-rot.triage.json"), triage);
writeFileSync(path.join(artifactsDir, "arch-rot.snapshot.md"), renderSummary(snapshot), "utf8");
writeJson(path.join(artifactsDir, "preset-result.json"), {
  schema: "script-result/v1",
  ok: evaluation.ok,
  warnings: warningMessages,
  report: {
    schema: "architecture-rot-check-report/v1",
    status: evaluation.ok ? "passed" : "blocked",
    summary: evaluation.summary,
    lensB: { candidates: candidates.length, blocking: false },
    snapshot: "artifacts/arch-rot.snapshot.json",
    triage: "artifacts/arch-rot.triage.json"
  },
  error: evaluation.ok ? undefined : {
    code: "architecture_rot_recurrence",
    hint: `Fixed architecture mechanisms failed: ${evaluation.hardFailures.map((item) => item.id).join(", ")}`
  }
});

function renderSummary(value) {
  const lines = [
    "# Architecture Rot Audit",
    "",
    `- Generated: ${value.generatedAt}`,
    `- Source HEAD: ${value.root.sourceHead} (${value.root.headVerification})`,
    `- Verdict: ${value.verdict}`,
    `- Fixed checked: ${value.lensA.fixedChecked}`,
    `- Recurrences: ${value.lensA.recurrences.length}`,
    `- Open-green/unverified warnings: ${evaluation.warnings.length}`,
    `- Lens-B candidates: ${value.lensB.candidates.length} (triage-only, non-blocking)`,
    "",
    "## Lens A",
    "",
    "| Record | Registry | Detector | Severity |",
    "| --- | --- | --- | --- |",
    ...value.lensA.items.map((item) => `| ${item.id} | ${item.registryStatus} | ${item.detectorOutcome} | ${item.severity} |`),
    "",
    "## Warnings",
    "",
    ...(value.warnings.length > 0 ? value.warnings.map((warning) => `- ${warning}`) : ["- None."]),
    ""
  ];
  return lines.join("\n");
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function toRootRelative(root, filePath) {
  return filePath ? path.relative(root, filePath).split(path.sep).join("/") : null;
}
