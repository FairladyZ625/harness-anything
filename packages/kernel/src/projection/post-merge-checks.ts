import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { findEntityRefs } from "../domain/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import type { ProjectionCheckAxisReport, ProjectionCheckReport, ProjectionWarning, ProjectionWarningCode, ProjectionWarningSource } from "./types.ts";
import { readMarkdownSource, readScalar, sourcePath, type TaskSourceEntry } from "./sqlite-task-source.ts";

export function runPostMergeChecks(rootDir: string): ReadonlyArray<ProjectionWarning> {
  const source = readMarkdownSource(rootDir);
  const warnings: ProjectionWarning[] = [];
  warnings.push(...findDuplicateTaskIds(rootDir, source.entries));
  warnings.push(...findDuplicateExternalBindings(source.entries));
  warnings.push(...findTrackedGeneratedFiles(rootDir));
  warnings.push(...findTamperedBindings(source.entries));
  warnings.push(...findConflictMarkers(rootDir));
  warnings.push(...findDanglingEntityRefs(rootDir, source.entries));
  warnings.push(...findRelationCycles(source.entries));
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

function findConflictMarkers(rootDir: string): ReadonlyArray<ProjectionWarning> {
  const layout = resolveHarnessLayout(rootDir);
  const roots = [layout.authoredRoot, path.join(layout.rootDir, "AGENTS.md"), path.join(layout.rootDir, "CLAUDE.md")];
  for (const candidate of roots.flatMap((entry) => listTextFiles(entry))) {
    const body = readFileSync(candidate, "utf8");
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

function findDanglingEntityRefs(rootDir: string, entries: ReadonlyArray<TaskSourceEntry>): ReadonlyArray<ProjectionWarning> {
  const knownTaskIds = new Set(entries.map((entry) => readScalar(entry.frontmatter, "task_id") || entry.taskId));
  const warnings: ProjectionWarning[] = [];
  const files = listTextFiles(resolveHarnessLayout(rootDir).authoredRoot);
  for (const filePath of files) {
    const body = readFileSync(filePath, "utf8");
    for (const ref of findEntityRefs(body)) {
      if (ref.externalHarness) continue;
      if (ref.id.length > 0 && !knownTaskIds.has(ref.id)) {
        warnings.push(hardFail(
          "source-package",
          "dangling_entity_ref",
          `Dangling task reference task/${ref.id} in ${sourcePath(rootDir, filePath)}.`,
          "Update the reference to an existing task package or remove the stale relation."
        ));
        return warnings;
      }
    }
  }
  return warnings;
}

function findRelationCycles(entries: ReadonlyArray<TaskSourceEntry>): ReadonlyArray<ProjectionWarning> {
  const graph = new Map<string, string[]>();
  for (const entry of entries) {
    const taskId = readScalar(entry.frontmatter, "task_id") || entry.taskId;
    const packageBody = listTextFiles(path.dirname(entry.indexPath))
      .map((filePath) => readFileSync(filePath, "utf8"))
      .join("\n");
    const targets = [...packageBody.matchAll(/target:\s*((?:[A-Za-z][A-Za-z0-9_-]*:)?task\/[A-Za-z0-9_-]+)/gu)]
      .flatMap((match) => {
        const ref = findEntityRefs(match[1] ?? "")[0];
        return ref && !ref.externalHarness ? [ref.id] : [];
      });
    graph.set(taskId, targets);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function visit(taskId: string): string[] | null {
    if (visiting.has(taskId)) return stack.slice(stack.indexOf(taskId)).concat(taskId);
    if (visited.has(taskId)) return null;
    visiting.add(taskId);
    stack.push(taskId);
    for (const target of graph.get(taskId) ?? []) {
      if (!graph.has(target)) continue;
      const cycle = visit(target);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(taskId);
    visited.add(taskId);
    return null;
  }

  for (const taskId of graph.keys()) {
    const cycle = visit(taskId);
    if (cycle) {
      return [hardFail(
        "source-package",
        "relation_cycle_detected",
        `Task relation cycle detected: ${cycle.join(" -> ")}.`,
        "Break the cyclic task relation before merging authored planning docs."
      )];
    }
  }
  return [];
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
  const stat = statSync(inputPath);
  if (stat.isFile()) return isTextLikePath(inputPath) ? [inputPath] : [];
  if (!stat.isDirectory()) return [];
  const files: string[] = [];
  for (const entry of readdirSync(inputPath, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    files.push(...listTextFiles(path.join(inputPath, entry.name)));
  }
  return files;
}

function isTextLikePath(filePath: string): boolean {
  return /\.(md|markdown|txt|ya?ml|json)$/iu.test(filePath);
}

function nullIfEmpty(value: string): string | null {
  return value.length === 0 ? null : value;
}

function stablePayloadHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
