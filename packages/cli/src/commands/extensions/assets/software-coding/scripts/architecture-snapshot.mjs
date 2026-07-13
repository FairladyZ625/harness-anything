#!/usr/bin/env node
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runDeclaredArchitectureExtractors } from "../architecture/contracts/architecture-adapters.mjs";
import { inspectArchitectureConfiguration } from "../architecture/contracts/architecture-configuration.mjs";
import { validateArchitectureSnapshotReport } from "../architecture/contracts/architecture-operation-reports.mjs";
import {
  architectureSnapshotDigest,
  architectureSnapshotJson,
  buildArchitectureSnapshot,
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
  finish(true, {
    schema: "architecture-snapshot-report/v1",
    status: "not-configured",
    manifest: configuration.manifest,
    snapshot: null,
    missingTools: [],
    issues: [],
    findings: [],
    warnings: [],
    nextActions: ["Run architecture-init explicitly to enable repository architecture tooling."]
  });
} else if (configuration.issues.length > 0) {
  finish(false, {
    schema: "architecture-snapshot-report/v1",
    status: "invalid",
    manifest: configuration.manifest,
    snapshot: null,
    missingTools: [],
    issues: configuration.issues,
    findings: [],
    warnings: [],
    nextActions: ["Resolve every manifest/model issue before generating a snapshot."]
  });
} else if (!context.taskId) {
  finish(false, {
    schema: "architecture-snapshot-report/v1",
    status: "invalid",
    manifest: configuration.manifest,
    snapshot: null,
    missingTools: [],
    issues: [{
      code: "architecture_snapshot_task_required",
      path: "taskId",
      message: "Architecture snapshots are task artifacts and require --task <id>."
    }],
    findings: [],
    warnings: [],
    nextActions: ["Rerun architecture-snapshot with the owning task ID."]
  });
} else {
  const extraction = await runDeclaredArchitectureExtractors({
    manifest: configuration.manifestValue,
    configuration,
    projectRoot: context.paths.projectRoot,
    executionRoot: context.paths.rootDir,
    inputs: context.inputs
  });
  if (!extraction.ok) {
    finish(false, {
      schema: "architecture-snapshot-report/v1",
      status: extraction.status,
      manifest: configuration.manifest,
      snapshot: null,
      missingTools: extraction.missingTools,
      issues: extraction.issues,
      findings: [],
      warnings: [],
      nextActions: extraction.status === "tool-missing"
        ? extraction.missingTools.map((tool) => tool.hint)
        : ["Fix the declared extractor configuration before retrying."]
    });
  } else {
    const combined = combineArchitectureObservations(extraction.observations, extraction.tools, extraction.comparisons);
    const snapshot = buildArchitectureSnapshot({
      manifest: configuration.manifest,
      provenance: {
        commit: context.repository.commit,
        sourceDigest: combined.sourceDigest,
        modelDigest: configuration.modelDigest,
        tools: combined.tools
      },
      extractors: combined.extractors,
      mappings: combined.mappings,
      nodeEdges: combined.nodeEdges,
      unmapped: combined.unmapped,
      stats: combined.stats
    });
    const snapshotPath = path.join(context.outputRoot, "artifacts", "architecture", "architecture-snapshot.json");
    const validation = validateArchitectureSnapshot(snapshot);
    const outputIssue = inspectSnapshotOutput(snapshotPath);
    if (!validation.ok || outputIssue) {
      finish(false, {
        schema: "architecture-snapshot-report/v1",
        status: "invalid",
        manifest: configuration.manifest,
        snapshot: null,
        missingTools: [],
        issues: [...(validation.issues ?? []), ...(outputIssue ? [outputIssue] : [])],
        findings: [],
        warnings: [],
        nextActions: ["Fix the adapter output or task artifact path before retrying; the last good snapshot was not changed."]
      });
    }
    mkdirSync(path.dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, architectureSnapshotJson(snapshot), "utf8");
    const reportPath = repositoryRelative(context.paths.rootDir, snapshotPath);
    finish(true, {
      schema: "architecture-snapshot-report/v1",
      status: combined.findings.length > 0 ? "drifted" : "fresh",
      manifest: configuration.manifest,
      snapshot: {
        path: reportPath,
        digest: architectureSnapshotDigest(snapshot),
        provenance: snapshot.provenance
      },
      missingTools: [],
      issues: [],
      findings: combined.findings,
      warnings: combined.warnings,
      nextActions: combined.findings.length > 0
        ? ["Review drift findings; do not rewrite authored architecture intent automatically."]
        : []
    }, [reportPath]);
  }
}

function inspectSnapshotOutput(snapshotPath) {
  try {
    const stat = lstatSync(snapshotPath);
    return stat.isFile() ? null : {
      code: stat.isSymbolicLink() ? "architecture_snapshot_output_symlink" : "architecture_snapshot_output_invalid",
      path: repositoryRelative(context.paths.rootDir, snapshotPath),
      message: "Architecture snapshot output must be a regular file or an absent path, never a symlink or directory."
    };
  } catch (error) {
    return error?.code === "ENOENT" ? null : {
      code: "architecture_snapshot_output_unreadable",
      path: repositoryRelative(context.paths.rootDir, snapshotPath),
      message: "Architecture snapshot output could not be inspected safely."
    };
  }
}

function finish(ok, report, produced = []) {
  const validation = validateArchitectureSnapshotReport(report);
  if (!validation.ok) throw new Error(`Invalid architecture-snapshot-report/v1: ${validation.issues.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`);
  writeFileSync(resultPath, JSON.stringify({ schema: "script-result/v1", ok, report, produced }), "utf8");
  process.exit(0);
}

function repositoryRelative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}
