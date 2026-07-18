#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const defaultRepoRoot = path.resolve(import.meta.dirname, "..");
const taskPackagePattern = /^(task_[0-9A-HJKMNP-TV-Z]{26})(?:-|$)/u;

export function checkGhostTaskPackages(repoRoot = defaultRepoRoot) {
  const tasksRoot = path.join(repoRoot, "harness", "tasks");
  if (!existsSync(tasksRoot)) {
    return { skipped: true, scanned: 0, missingIndexes: [], duplicateTaskIds: [] };
  }

  const packages = readdirSync(tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const match = taskPackagePattern.exec(entry.name);
      return match?.[1] === undefined
        ? null
        : {
            taskId: match[1],
            relativePath: path.posix.join("harness", "tasks", entry.name),
            hasIndex: existsSync(path.join(tasksRoot, entry.name, "INDEX.md"))
          };
    })
    .filter((entry) => entry !== null)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const byTaskId = new Map();
  for (const taskPackage of packages) {
    const group = byTaskId.get(taskPackage.taskId) ?? [];
    group.push(taskPackage.relativePath);
    byTaskId.set(taskPackage.taskId, group);
  }

  return {
    skipped: false,
    scanned: packages.length,
    missingIndexes: packages
      .filter((taskPackage) => !taskPackage.hasIndex)
      .map((taskPackage) => taskPackage.relativePath),
    duplicateTaskIds: [...byTaskId.entries()]
      .filter(([, directories]) => directories.length > 1)
      .map(([taskId, directories]) => ({ taskId, directories }))
      .sort((left, right) => left.taskId.localeCompare(right.taskId))
  };
}

export function formatGhostTaskPackageReport(result) {
  if (result.skipped) return "Ghost task package check: harness/tasks not present; skipping.";
  if (result.missingIndexes.length === 0 && result.duplicateTaskIds.length === 0) {
    return `Ghost task package check passed: ${result.scanned} task package(s), 0 missing INDEX.md, 0 duplicate task IDs.`;
  }

  const lines = ["Ghost task package check failed."];
  for (const directory of result.missingIndexes) {
    lines.push(`- missing INDEX.md: ${directory}`);
  }
  for (const duplicate of result.duplicateTaskIds) {
    lines.push(`- duplicate ${duplicate.taskId}: ${duplicate.directories.join(", ")}`);
  }
  return lines.join("\n");
}

export function main(repoRoot = defaultRepoRoot) {
  const result = checkGhostTaskPackages(repoRoot);
  console.log(formatGhostTaskPackageReport(result));
  return result.missingIndexes.length === 0 && result.duplicateTaskIds.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
