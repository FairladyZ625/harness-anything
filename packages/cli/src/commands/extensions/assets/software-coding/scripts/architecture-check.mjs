#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runDeclaredArchitectureExtractors } from "../architecture/contracts/architecture-adapters.mjs";
import { inspectArchitectureConfiguration } from "../architecture/contracts/architecture-configuration.mjs";
import {
  buildArchitectureCheckReport,
  evaluateArchitectureCheckState,
  validateArchitectureCheckReport
} from "../architecture/contracts/architecture-check-report.mjs";
import {
  architectureSnapshotDigest,
  combineArchitectureObservations,
  validateArchitectureSnapshot
} from "../architecture/contracts/architecture-runtime.mjs";

const contextPath = process.env.HARNESS_SCRIPT_CONTEXT;
const resultPath = process.env.HARNESS_SCRIPT_RESULT;
if (!contextPath || !resultPath) throw new Error("HARNESS_SCRIPT_CONTEXT and HARNESS_SCRIPT_RESULT are required");

const context = JSON.parse(readFileSync(contextPath, "utf8"));
const configuration = inspectArchitectureConfiguration({
  projectRoot: context.paths.rootDir,
  authoredRoot: context.paths.authoredRoot,
  hostValidatedBoundary: true
});

if (!configuration.configured) {
  finish(true, reportForState({
    status: "not-configured",
    configuration,
    snapshot: { path: null, present: false, valid: false, digest: null, provenance: null },
    current: null,
    comparison: { commit: "not-checked", sourceDigest: "not-checked", modelDigest: "not-checked", toolVersions: [], semantic: "not-checked" },
    reasons: [],
    issues: [],
    missingTools: [],
    findings: [],
    warnings: [],
    nextActions: []
  }));
} else if (configuration.issues.length > 0) {
  finish(false, invalidReport(configuration, configuration.issues));
} else if (!context.taskId) {
  finish(false, invalidReport(configuration, [{
    code: "architecture_check_task_required",
    path: "taskId",
    message: "Architecture check reads a task-owned snapshot and requires --task <id>."
  }]));
} else {
  const snapshotPath = path.join(context.outputRoot, "artifacts", "architecture", "architecture-snapshot.json");
  const snapshotRelativePath = repositoryRelative(context.paths.rootDir, snapshotPath);
  const snapshotPathIssue = inspectSnapshotPath(snapshotPath);
  if (snapshotPathIssue) {
    finish(false, invalidReport(configuration, [snapshotPathIssue], invalidSnapshotDescriptor(
      snapshotRelativePath,
      pathEntryExists(snapshotPath)
    )));
  }
  let snapshotValue;
  if (existsSync(snapshotPath)) {
    try {
      snapshotValue = JSON.parse(readFileSync(snapshotPath, "utf8"));
    } catch {
      finish(false, invalidReport(configuration, [{
        code: "architecture_snapshot_invalid_json",
        path: snapshotRelativePath,
        message: "Architecture snapshot must be valid JSON."
      }], invalidSnapshotDescriptor(snapshotRelativePath, true)));
    }
    const validation = validateArchitectureSnapshot(snapshotValue);
    if (!validation.ok) {
      finish(false, invalidReport(configuration, validation.issues, invalidSnapshotDescriptor(snapshotRelativePath, true)));
    }
    if (snapshotValue.manifest.path !== configuration.manifest.path) {
      finish(false, invalidReport(configuration, [{
        code: "architecture_snapshot_manifest_mismatch",
        path: `${snapshotRelativePath}#manifest`,
        message: "Architecture snapshot manifest path must match the current configured manifest."
      }], snapshotDescriptor(snapshotRelativePath, snapshotValue)));
    }
  }

  const extraction = await runDeclaredArchitectureExtractors({
    manifest: configuration.manifestValue,
    configuration,
    projectRoot: context.paths.projectRoot,
    executionRoot: context.paths.rootDir,
    inputs: context.inputs
  });
  if (!extraction.ok && extraction.status === "invalid") {
    finish(false, invalidReport(configuration, extraction.issues, snapshotDescriptor(snapshotRelativePath, snapshotValue)));
  }
  if (!extraction.ok) {
    finish(false, reportForState({
      status: "tool-missing",
      configuration,
      snapshot: snapshotDescriptor(snapshotRelativePath, snapshotValue),
      current: null,
      comparison: { commit: "not-checked", sourceDigest: "not-checked", modelDigest: "not-checked", toolVersions: [], semantic: "not-checked" },
      reasons: [],
      issues: [],
      missingTools: extraction.missingTools,
      findings: [],
      warnings: [],
      nextActions: extraction.missingTools.map((tool) => tool.hint)
    }));
  }

  const combined = combineArchitectureObservations(extraction.observations, extraction.tools, extraction.comparisons);
  const commit = context.repository.commit;
  const current = {
    commit,
    sourceDigest: combined.sourceDigest,
    modelDigest: configuration.modelDigest,
    tools: combined.tools
  };
  const state = evaluateArchitectureCheckState({
    configured: true,
    snapshot: snapshotValue,
    current: { provenance: current, findings: combined.findings }
  });
  const snapshotCommit = snapshotValue?.provenance?.commit;
  finish(state.status === "fresh", reportForState({
    status: state.status,
    configuration,
    snapshot: snapshotDescriptor(snapshotRelativePath, snapshotValue),
    current,
    comparison: {
      commit: compareCommit(snapshotCommit, commit),
      sourceDigest: state.comparison.sourceDigest,
      modelDigest: state.comparison.modelDigest,
      toolVersions: state.comparison.toolVersions,
      semantic: combined.findings.length > 0 ? "mismatch" : "match"
    },
    reasons: state.reasons,
    issues: [],
    missingTools: [],
    findings: combined.findings,
    warnings: combined.warnings,
    nextActions: state.status === "drifted"
      ? ["Review digest and semantic differences; update code or authored architecture deliberately."]
      : []
  }));
}

function inspectSnapshotPath(snapshotPath) {
  const snapshotRoot = path.dirname(snapshotPath);
  const relativeParts = path.relative(snapshotRoot, snapshotPath).split(path.sep).filter(Boolean);
  let current = snapshotRoot;
  for (let index = -1; index < relativeParts.length; index += 1) {
    if (index >= 0) current = path.join(current, relativeParts[index]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      return snapshotPathIssue(current, "architecture_snapshot_path_unreadable", "Snapshot path could not be inspected safely.");
    }
    if (stat.isSymbolicLink()) {
      return snapshotPathIssue(current, "architecture_snapshot_path_symlink", "Snapshot task artifact paths must not contain symbolic links.");
    }
    const isLeaf = index === relativeParts.length - 1;
    if ((isLeaf && !stat.isFile()) || (!isLeaf && !stat.isDirectory())) {
      return snapshotPathIssue(current, "architecture_snapshot_path_invalid", "Snapshot parents must be directories and the snapshot must be a regular file.");
    }
  }
  return null;
}

function snapshotPathIssue(target, code, message) {
  return { code, path: repositoryRelative(context.paths.rootDir, target), message };
}

function invalidReport(configurationValue, issues, snapshot = absentSnapshotDescriptor(null)) {
  return reportForState({
    status: "invalid",
    configuration: configurationValue,
    snapshot,
    current: null,
    comparison: { commit: "not-checked", sourceDigest: "not-checked", modelDigest: "not-checked", toolVersions: [], semantic: "not-checked" },
    reasons: [],
    issues,
    missingTools: [],
    findings: [],
    warnings: [],
    nextActions: ["Resolve invalid architecture configuration or snapshot data before retrying."]
  });
}

function reportForState(input) {
  return buildArchitectureCheckReport({
    ...input,
    manifest: input.configuration.manifest
  });
}

function snapshotDescriptor(snapshotPath, snapshot) {
  return snapshot ? {
    path: snapshotPath,
    present: true,
    valid: true,
    digest: architectureSnapshotDigest(snapshot),
    provenance: snapshot.provenance
  } : absentSnapshotDescriptor(snapshotPath);
}

function absentSnapshotDescriptor(snapshotPath) {
  return invalidSnapshotDescriptor(snapshotPath, false);
}

function invalidSnapshotDescriptor(snapshotPath, present) {
  return { path: snapshotPath, present, valid: false, digest: null, provenance: null };
}

function pathEntryExists(target) {
  try {
    lstatSync(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    return true;
  }
}

function compareCommit(before, current) {
  if (!before || !current || before.verification !== "verified" || current.verification !== "verified") return "not-checked";
  return before.sha === current.sha ? "match" : "mismatch";
}

function finish(ok, report) {
  const validation = validateArchitectureCheckReport(report);
  if (!validation.ok) {
    throw new Error(`Invalid architecture-check-report/v1: ${validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  }
  writeFileSync(resultPath, JSON.stringify({ schema: "script-result/v1", ok, report, produced: [] }), "utf8");
  process.exit(0);
}

function repositoryRelative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}
