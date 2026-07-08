import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { findEntityRefs, parseFactFlowRecords } from "../domain/index.ts";
import { stablePayloadHash } from "../integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { readFrontmatter, readScalar } from "../markdown/frontmatter.ts";
import { buildRelationGraphProjection, detectRelationGraphCycles, validateRelationGraphRecords } from "./relation-graph-projection.ts";
import type { ProjectionCheckAxisReport, ProjectionCheckReport, ProjectionWarning, ProjectionWarningCode, ProjectionWarningSource } from "./types.ts";
import { readMarkdownSource, sourcePath, type TaskSourceEntry } from "./sqlite-task-source.ts";
import { readDirIfPresent, readTextFileIfPresent, statPathIfPresent } from "./toctou-safe-fs.ts";

export function runPostMergeChecks(rootInput: HarnessLayoutInput): ReadonlyArray<ProjectionWarning> {
  const rootDir = resolveHarnessLayout(rootInput).rootDir;
  const source = readMarkdownSource(rootInput);
  const warnings: ProjectionWarning[] = [];
  warnings.push(...findDuplicateTaskIds(rootDir, source.entries));
  warnings.push(...findDuplicateExternalBindings(source.entries));
  warnings.push(...findTrackedGeneratedFiles(rootDir));
  warnings.push(...findTamperedBindings(source.entries));
  warnings.push(...findConflictMarkerWarnings(rootInput));
  warnings.push(...findDecisionWatermarkIssues(rootInput));
  warnings.push(...findDanglingEntityRefs(rootInput, source.entries));
  warnings.push(...findRelationRecordIssues(rootInput));
  warnings.push(...findParentCycles(rootDir, source.entries));
  warnings.push(...findRelationCycles(rootInput));
  return warnings;
}

export function warning(source: ProjectionWarningSource, code: ProjectionWarningCode, message: string, repairHint: string): ProjectionWarning {
  return {
    code,
    source,
    severity: "warning",
    message,
    repairHint
  };
}

export function hardFail(source: ProjectionWarningSource, code: ProjectionWarningCode, message: string, repairHint: string): ProjectionWarning {
  return {
    code,
    source,
    message,
    severity: "hard-fail",
    repairHint
  };
}

function findDuplicateTaskIds(rootDir: string, entries: ReadonlyArray<TaskSourceEntry>): ReadonlyArray<ProjectionWarning> {
  const seen = new Map<string, string>();
  const warnings: ProjectionWarning[] = [];
  for (const entry of entries) {
    const taskId = readScalar(entry.frontmatter, "task_id") || entry.taskId;
    const source = sourcePath(rootDir, entry.indexPath);
    const previous = seen.get(taskId);
    if (previous) {
      warnings.push(hardFail(
        "source-package",
        "duplicate_task_id",
        `Duplicate task_id ${taskId} in ${previous} and ${source}.`,
        "Regenerate one task package with a new random task_<ULID> identity; do not hand-edit IDs to merge packages."
      ));
    } else {
      seen.set(taskId, source);
    }
  }
  return warnings;
}

function findDuplicateExternalBindings(entries: ReadonlyArray<TaskSourceEntry>): ReadonlyArray<ProjectionWarning> {
  const seen = new Map<string, string>();
  const warnings: ProjectionWarning[] = [];
  for (const entry of entries) {
    const engine = readScalar(entry.frontmatter, "  engine");
    const ref = readScalar(entry.frontmatter, "  ref");
    if (ref.length === 0) continue;
    const key = `${engine}:${ref}`;
    const taskId = readScalar(entry.frontmatter, "task_id") || entry.taskId;
    const previous = seen.get(key);
    if (previous) {
      warnings.push(hardFail(
        "source-package",
        "duplicate_external_binding",
        `External binding ${key} is used by ${previous} and ${taskId}.`,
        "Keep exactly one package for each external engine/ref binding and relink or remove the duplicate package."
      ));
    } else {
      seen.set(key, taskId);
    }
  }
  return warnings;
}

function findTrackedGeneratedFiles(rootDir: string): ReadonlyArray<ProjectionWarning> {
  try {
    const output = execFileSync("git", ["-C", rootDir, "ls-files", "--", ".harness", ".journal", ".projection.sqlite", ".adopt-claims"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (output.length === 0) return [];
    return [hardFail(
      "collaboration-gate",
      "generated_tracked",
      "Generated local harness files are tracked by git.",
      "Remove .harness/, legacy .journal/, legacy .projection.sqlite, and legacy .adopt-claims/ files from git; rebuild generated projections locally."
    )];
  } catch {
    return [];
  }
}

function findTamperedBindings(entries: ReadonlyArray<TaskSourceEntry>): ReadonlyArray<ProjectionWarning> {
  const warnings: ProjectionWarning[] = [];
  for (const entry of entries) {
    const engine = readScalar(entry.frontmatter, "  engine");
    const bindingCreatedAt = readScalar(entry.frontmatter, "  bindingCreatedAt");
    const stored = readScalar(entry.frontmatter, "  bindingFingerprint");
    if (engine.length === 0 || bindingCreatedAt.length === 0 || stored.length === 0) continue;
    const ref = nullIfEmpty(readScalar(entry.frontmatter, "  ref"));
    const expected = `sha256:${stablePayloadHash({ engine, ref, bindingCreatedAt })}`;
    if (stored !== expected) {
      const taskId = readScalar(entry.frontmatter, "task_id") || entry.taskId;
      warnings.push(hardFail(
        "source-package",
        "binding_tampered",
        `Lifecycle binding fingerprint mismatch for ${taskId}.`,
        "Do not mutate lifecycle identity fields in place; restore the original binding or create a fresh task/adoption package."
      ));
    }
  }
  return warnings;
}

export function findConflictMarkerWarnings(rootInput: HarnessLayoutInput): ReadonlyArray<ProjectionWarning> {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  const roots = [layout.authoredRoot, path.join(layout.rootDir, "AGENTS.md"), path.join(layout.rootDir, "CLAUDE.md")];
  for (const candidate of roots.flatMap((entry) => listTextFiles(entry))) {
    const body = readTextFileIfPresent(candidate);
    if (body === null) continue;
    if (/^<<<<<<<[^\n]*\n[\s\S]*?^=======$[\s\S]*?^>>>>>>>[^\n]*$/mu.test(body)) {
      return [hardFail(
        "collaboration-gate",
        "conflict_marker_present",
        `Git conflict marker found in ${sourcePath(rootDir, candidate)}.`,
        "Resolve merge conflict markers before running post-merge checks again."
      )];
    }
  }
  return [];
}

function findDecisionWatermarkIssues(rootInput: HarnessLayoutInput): ReadonlyArray<ProjectionWarning> {
  const layout = resolveHarnessLayout(rootInput);
  const seen = new Map<string, string>();
  const warnings: ProjectionWarning[] = [];
  for (const filePath of listTextFiles(layout.decisionsRoot)) {
    if (path.basename(filePath) !== "decision.md") continue;
    const body = readTextFileIfPresent(filePath);
    if (body === null) continue;
    const frontmatter = readFrontmatter(body);
    if (!frontmatter || readScalar(frontmatter, "schema") !== "decision-package/v1") continue;
    const source = sourcePath(layout.rootDir, filePath);
    const decisionId = readScalar(frontmatter, "decision_id") || path.basename(path.dirname(filePath));
    const watermark = readScalar(frontmatter, "_coordinatorWatermark");
    if (watermark.length === 0) {
      warnings.push(hardFail(
        "source-package",
        "decision_watermark_missing",
        `Decision ${decisionId} in ${source} is missing _coordinatorWatermark.`,
        "Rewrite the decision through the decision write coordinator path; do not hand-author machine-readable decision frontmatter."
      ));
      continue;
    }
    const previous = seen.get(watermark);
    if (previous) {
      warnings.push(hardFail(
        "source-package",
        "decision_watermark_duplicate",
        `Decision ${decisionId} in ${source} reuses _coordinatorWatermark from ${previous}.`,
        "Regenerate one of the copied decision files through the decision write coordinator path so each authored decision has a unique watermark."
      ));
      continue;
    }
    seen.set(watermark, source);
  }
  return warnings;
}

function findDanglingEntityRefs(rootInput: HarnessLayoutInput, entries: ReadonlyArray<TaskSourceEntry>): ReadonlyArray<ProjectionWarning> {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  const knownRefs = buildEntityRefIndex(rootInput, entries);
  const warnings: ProjectionWarning[] = [];
  const files = listTextFiles(layout.authoredRoot)
    .filter((filePath) => !isInsideRoot(layout.sessionsRoot, filePath))
    .filter((filePath) => !isGeneratedArtifactCapture(layout.tasksRoot, filePath));
  for (const filePath of files) {
    const body = readTextFileIfPresent(filePath);
    if (body === null) continue;
    for (const ref of findEntityRefs(body)) {
      if (ref.externalHarness) continue;
      if (ref.kind === "task" && !knownRefs.taskIds.has(ref.id)) {
        warnings.push(hardFail(
          "source-package",
          "dangling_entity_ref",
          `Dangling task reference task/${ref.id} in ${sourcePath(rootDir, filePath)}.`,
          "Update the reference to an existing task package or remove the stale relation."
        ));
        return warnings;
      }
      if (ref.kind === "decision" && (!knownRefs.decisionIds.has(ref.id) || (ref.anchor && !knownRefs.decisionAnchors.has(`${ref.id}/${ref.anchor}`)))) {
        const rendered = ref.anchor ? `decision/${ref.id}/${ref.anchor}` : `decision/${ref.id}`;
        warnings.push(hardFail(
          "source-package",
          "dangling_entity_ref",
          `Dangling decision reference ${rendered} in ${sourcePath(rootDir, filePath)}.`,
          "Update the reference to an existing decision package or remove the stale relation."
        ));
        return warnings;
      }
      if (ref.kind === "fact") {
        const key = `${ref.ownerTaskId}/${ref.id}`;
        if (!ref.ownerTaskId || !knownRefs.taskIds.has(ref.ownerTaskId) || !knownRefs.factRefs.has(key)) {
          warnings.push(hardFail(
            "source-package",
            "dangling_entity_ref",
            `Dangling fact reference fact/${ref.ownerTaskId ?? "unknown"}/${ref.id} in ${sourcePath(rootDir, filePath)}.`,
            "Restore the task-local F-id in facts.md or remove the stale relation."
          ));
          return warnings;
        }
      }
    }
  }
  return warnings;
}

function isInsideRoot(rootDir: string, filePath: string): boolean {
  const relative = path.relative(rootDir, filePath);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isGeneratedArtifactCapture(tasksRoot: string, filePath: string): boolean {
  const relative = path.relative(tasksRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep);
  const artifactIndex = parts.indexOf("artifacts");
  if (artifactIndex < 0) return false;
  const captureKind = parts[artifactIndex + 1];
  return ["baseline", "before", "after", "captures", "snapshots", "transcripts", "raw", "orchestration"].includes(captureKind);
}

interface EntityRefIndex {
  readonly taskIds: ReadonlySet<string>;
  readonly decisionIds: ReadonlySet<string>;
  readonly decisionAnchors: ReadonlySet<string>;
  readonly factRefs: ReadonlySet<string>;
}

function buildEntityRefIndex(rootInput: HarnessLayoutInput, entries: ReadonlyArray<TaskSourceEntry>): EntityRefIndex {
  const layout = resolveHarnessLayout(rootInput);
  const taskIds = new Set(entries.map((entry) => readScalar(entry.frontmatter, "task_id") || entry.taskId));
  const factRefs = new Set<string>();
  for (const entry of entries) {
    const taskId = readScalar(entry.frontmatter, "task_id") || entry.taskId;
    const factsPath = path.join(path.dirname(entry.indexPath), layout.factDocumentName);
    if (!existsSync(factsPath)) continue;
    const factsBody = readTextFileIfPresent(factsPath);
    if (factsBody === null) continue;
    for (const record of parseFactFlowRecords(factsBody)) {
      factRefs.add(`${taskId}/${record.fact_id}`);
    }
  }

  const decisionIds = new Set<string>();
  const decisionAnchors = new Set<string>();
  for (const filePath of listTextFiles(layout.decisionsRoot)) {
    if (path.basename(filePath) !== "decision.md") continue;
    const body = readTextFileIfPresent(filePath);
    if (body === null) continue;
    const frontmatter = readFrontmatter(body);
    if (!frontmatter || readScalar(frontmatter, "schema") !== "decision-package/v1") continue;
    const decisionId = readScalar(frontmatter, "decision_id");
    if (!decisionId) continue;
    decisionIds.add(decisionId);
    for (const anchor of findDecisionAnchors(frontmatter)) {
      decisionAnchors.add(`${decisionId}/${anchor}`);
    }
  }
  return { taskIds, decisionIds, decisionAnchors, factRefs };
}

function findDecisionAnchors(frontmatter: string): ReadonlyArray<string> {
  return [...frontmatter.matchAll(/^\s*-\s*\{\s*id:\s*"?([A-Za-z][A-Za-z0-9_-]*)"?/gmu)]
    .map((match) => match[1])
    .filter((anchor): anchor is string => Boolean(anchor));
}

function findRelationCycles(rootInput: HarnessLayoutInput): ReadonlyArray<ProjectionWarning> {
  const cycle = detectRelationGraphCycles(buildRelationGraphProjection(rootInput).edges)[0];
  if (!cycle) return [];
  return [hardFail(
    "source-package",
    "relation_cycle_detected",
    `Entity relation cycle detected: ${cycle.join(" -> ")}.`,
    "Break the cyclic typed relation records before merging authored planning docs."
  )];
}

function findParentCycles(rootDir: string, entries: ReadonlyArray<TaskSourceEntry>): ReadonlyArray<ProjectionWarning> {
  const parents = new Map<string, string>();
  const sources = new Map<string, string>();
  for (const entry of entries) {
    const taskId = readScalar(entry.frontmatter, "task_id") || entry.taskId;
    const parent = readScalar(entry.frontmatter, "parent");
    sources.set(taskId, sourcePath(rootDir, entry.indexPath));
    if (parent) parents.set(taskId, parent);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const stack: string[] = [];

  function visit(taskId: string): ReadonlyArray<string> | null {
    if (visiting.has(taskId)) return stack.slice(stack.indexOf(taskId)).concat(taskId);
    if (visited.has(taskId)) return null;
    visiting.add(taskId);
    stack.push(taskId);
    const parent = parents.get(taskId);
    const cycle = parent ? visit(parent) : null;
    stack.pop();
    visiting.delete(taskId);
    visited.add(taskId);
    return cycle;
  }

  for (const taskId of parents.keys()) {
    const cycle = visit(taskId);
    if (!cycle) continue;
    const source = sources.get(cycle[0] ?? "") ?? "harness/tasks";
    return [hardFail(
      "source-package",
      "relation_cycle_detected",
      `Task parent cycle detected: ${cycle.join(" -> ")} (${source}).`,
      "Break the cyclic parent fields before merging authored task packages."
    )];
  }
  return [];
}

function findRelationRecordIssues(rootInput: HarnessLayoutInput): ReadonlyArray<ProjectionWarning> {
  return validateRelationGraphRecords(rootInput).map(({ entry, issue }) => hardFail(
    "source-package",
    issue.code,
    `${issue.message} (${entry.sourcePath}:${entry.recordIndex + 1}).`,
    relationRepairHint(issue.code)
  ));
}

function relationRepairHint(code: ProjectionWarningCode): string {
  if (code === "relation_host_source_mismatch" || code === "relation_provenance_inheritance_mismatch") {
    return "Move the relation record into the metadata for its source entity so provenance is inherited from the correct host.";
  }
  if (code === "relation_id_mismatch") {
    return "Recompute relation_id from source, target, type, and direction; relation_id is deterministic and must not be hand-assigned.";
  }
  if (code === "duplicate_relation_id") {
    return "Keep one byte-identical duplicate relation record, or manually arbitrate divergent attributes for the same canonical edge before merging.";
  }
  if (code === "relation_rationale_missing") {
    return "Add a non-blank rationale for strong or gate-bearing relation records.";
  }
  if (code === "invalid_relation_type_subset") {
    return "Use an allowed source-kind/type/target-kind relation triple from the entity relation matrix.";
  }
  if (code === "relation_endpoint_unknown") {
    return "Restore the referenced task, decision anchor, or fact before rebuilding the relation graph projection.";
  }
  return "Restore a valid typed relation endpoint before rebuilding the relation graph projection.";
}

export function buildCheckReport(
  ok: boolean,
  rowCount: number,
  warnings: ReadonlyArray<ProjectionWarning>
): ProjectionCheckReport {
  const axisReport = (axis: ProjectionWarningSource): ProjectionCheckAxisReport => {
    const axisWarnings = warnings.filter((item) => item.source === axis);
    return {
      axis,
      ok: axisWarnings.every((item) => item.severity !== "hard-fail"),
      warningCount: axisWarnings.length,
      hardFailCount: axisWarnings.filter((item) => item.severity === "hard-fail").length,
      codes: [...new Set(axisWarnings.map((item) => item.code))].sort()
    };
  };
  return {
    schema: "harness-check-report/v1",
    ok,
    axes: [
      axisReport("source-package"),
      axisReport("generated-cache"),
      axisReport("collaboration-gate")
    ],
    summary: {
      rowCount,
      warningCount: warnings.length,
      hardFailCount: warnings.filter((item) => item.severity === "hard-fail").length
    }
  };
}

function listTextFiles(inputPath: string): ReadonlyArray<string> {
  if (!existsSync(inputPath)) return [];
  const rootStat = statPathIfPresent(inputPath);
  if (rootStat === null) return [];
  if (rootStat.isFile()) return isTextLikePath(inputPath) ? [inputPath] : [];
  if (!rootStat.isDirectory()) return [];
  const files: string[] = [];
  const dirQueue: string[] = [inputPath];
  while (dirQueue.length > 0) {
    const dir = dirQueue.pop()!;
    const entries = readDirIfPresent(dir);
    if (entries === null) continue;
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const childPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        dirQueue.push(childPath);
      } else if (entry.isFile() && isTextLikePath(childPath)) {
        files.push(childPath);
      }
    }
  }
  return files;
}

function isTextLikePath(filePath: string): boolean {
  return /\.(md|markdown|txt|ya?ml|json)$/iu.test(filePath);
}

function nullIfEmpty(value: string): string | null {
  return value.length === 0 ? null : value;
}
