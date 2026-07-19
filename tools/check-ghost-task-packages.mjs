#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const defaultRepoRoot = path.resolve(import.meta.dirname, "..");
const taskPackagePattern = /^(task_[0-9A-HJKMNP-TV-Z]{26})(?:-|$)/u;
const taskFrontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const taskIdLinePattern = /^task_id:\s*(task_[0-9A-HJKMNP-TV-Z]{26})\s*$/mu;
const taskSchemaLinePattern = /^schema:\s*task-package\/v2\s*$/mu;

export function checkGhostTaskPackages(repoRoot = defaultRepoRoot) {
  const ledgerRoot = resolveLedgerRoot(repoRoot);
  const tasksRoot = ledgerRoot === null ? null : path.join(ledgerRoot, "harness", "tasks");
  if (tasksRoot === null || !existsSync(tasksRoot)) {
    return { available: false, scanned: 0, unregisteredPackages: [], duplicateTaskIds: [] };
  }

  const packages = readdirSync(tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const match = taskPackagePattern.exec(entry.name);
      const relativePath = path.posix.join("harness", "tasks", entry.name);
      const indexPath = path.join(tasksRoot, entry.name, "INDEX.md");
      const indexSource = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;
      const frontmatter = indexSource === null ? null : taskFrontmatterPattern.exec(indexSource)?.[1] ?? null;
      const registeredTaskId = frontmatter === null ? null : taskIdLinePattern.exec(frontmatter)?.[1] ?? null;
      return {
        taskId: match?.[1] ?? null,
        relativePath,
        registeredTaskId,
        registered: match?.[1] !== undefined
          && taskSchemaLinePattern.test(frontmatter ?? "")
          && registeredTaskId === match[1]
      };
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const byTaskId = new Map();
  for (const taskPackage of packages) {
    if (taskPackage.taskId === null) continue;
    const group = byTaskId.get(taskPackage.taskId) ?? [];
    group.push(taskPackage.relativePath);
    byTaskId.set(taskPackage.taskId, group);
  }

  return {
    available: true,
    scanned: packages.length,
    unregisteredPackages: packages
      .filter((taskPackage) => !taskPackage.registered)
      .map((taskPackage) => ({
        relativePath: taskPackage.relativePath,
        directoryTaskId: taskPackage.taskId,
        registeredTaskId: taskPackage.registeredTaskId
      })),
    duplicateTaskIds: [...byTaskId.entries()]
      .filter(([, directories]) => directories.length > 1)
      .map(([taskId, directories]) => ({ taskId, directories }))
      .sort((left, right) => left.taskId.localeCompare(right.taskId))
  };
}

export function resolveLedgerRoot(repoRoot) {
  const directTasksRoot = path.join(repoRoot, "harness", "tasks");
  if (existsSync(directTasksRoot)) return repoRoot;
  const dotGitPath = path.join(repoRoot, ".git");
  if (!existsSync(dotGitPath) || statSync(dotGitPath).isDirectory()) return null;
  const gitDirMatch = /^gitdir:\s*(.+?)\s*$/mu.exec(readFileSync(dotGitPath, "utf8"));
  if (!gitDirMatch) return null;
  const gitDir = path.resolve(repoRoot, gitDirMatch[1]);
  const commonDirPath = path.join(gitDir, "commondir");
  if (!existsSync(commonDirPath)) return null;
  const commonGitDir = path.resolve(gitDir, readFileSync(commonDirPath, "utf8").trim());
  const candidateRoot = path.dirname(commonGitDir);
  return existsSync(path.join(candidateRoot, "harness", "tasks")) ? candidateRoot : null;
}

export function formatGhostTaskPackageReport(result) {
  if (!result.available) return "Ghost task package check failed: canonical harness/tasks ledger is unavailable.";
  if (result.unregisteredPackages.length === 0 && result.duplicateTaskIds.length === 0) {
    return `Ghost task package check passed: ${result.scanned} task package(s), all registered by INDEX.md, 0 duplicate task IDs.`;
  }

  const lines = ["Ghost task package check failed."];
  for (const taskPackage of result.unregisteredPackages) {
    lines.push(`- unregistered package: ${taskPackage.relativePath} (directory ID: ${taskPackage.directoryTaskId ?? "invalid"}; INDEX ID: ${taskPackage.registeredTaskId ?? "missing"})`);
  }
  for (const duplicate of result.duplicateTaskIds) {
    lines.push(`- duplicate ${duplicate.taskId}: ${duplicate.directories.join(", ")}`);
  }
  return lines.join("\n");
}

export function main(repoRoot = defaultRepoRoot) {
  const result = checkGhostTaskPackages(repoRoot);
  console.log(formatGhostTaskPackageReport(result));
  return result.available && result.unregisteredPackages.length === 0 && result.duplicateTaskIds.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
