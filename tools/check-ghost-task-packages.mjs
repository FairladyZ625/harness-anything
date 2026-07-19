#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const defaultRepoRoot = path.resolve(import.meta.dirname, "..");
const taskPackagePattern = /^(task_[0-9A-HJKMNP-TV-Z]{26})(?:-|$)/u;
const taskFrontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const taskIdPattern = /^task_[0-9A-HJKMNP-TV-Z]{26}$/u;

export function checkGhostTaskPackages(repoRoot = defaultRepoRoot) {
  const resolution = resolveLedgerRoot(repoRoot);
  if (resolution.status !== "checked") {
    return {
      status: resolution.status,
      reason: resolution.reason,
      scanned: 0,
      unregisteredPackages: [],
      duplicateTaskIds: []
    };
  }

  try {
    return scanGhostTaskPackages(resolution.ledgerRoot, resolution.tasksRoot);
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
      scanned: 0,
      unregisteredPackages: [],
      duplicateTaskIds: []
    };
  }
}

function scanGhostTaskPackages(ledgerRoot, tasksRoot) {
  const packages = readdirSync(tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      const match = taskPackagePattern.exec(entry.name);
      const relativePath = path.relative(ledgerRoot, path.join(tasksRoot, entry.name)).split(path.sep).join("/");
      const indexPath = path.join(tasksRoot, entry.name, "INDEX.md");
      if (existsSync(indexPath) && !statSync(indexPath).isFile()) {
        throw new Error(`${relativePath}/INDEX.md must be a regular file`);
      }
      const indexSource = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;
      const frontmatter = indexSource === null ? null : taskFrontmatterPattern.exec(indexSource)?.[1] ?? null;
      const registeredTaskId = frontmatter === null ? null : readGhostYamlScalar(frontmatter, "task_id");
      return {
        taskId: match?.[1] ?? null,
        relativePath,
        registeredTaskId: registeredTaskId !== null && taskIdPattern.test(registeredTaskId) ? registeredTaskId : null,
        registered: match?.[1] !== undefined
          && readGhostYamlScalar(frontmatter ?? "", "schema") === "task-package/v2"
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
    status: "checked",
    reason: null,
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
  const direct = inspectSelfHostedLayout(repoRoot);
  if (direct.status !== "not-self-hosted") return direct;

  const commonRoot = resolveCommonCheckoutRoot(repoRoot);
  if (commonRoot === null || commonRoot === repoRoot) {
    return { status: "not-applicable", reason: direct.reason };
  }
  const canonical = inspectSelfHostedLayout(commonRoot);
  if (canonical.status === "not-self-hosted") {
    return {
      status: "not-applicable",
      reason: `neither checkout nor common Git checkout declares harness/harness.yaml (${repoRoot}; ${commonRoot})`
    };
  }
  return canonical;
}

function inspectSelfHostedLayout(repoRoot) {
  const configPath = path.join(repoRoot, "harness", "harness.yaml");
  if (!existsSync(configPath)) {
    return { status: "not-self-hosted", reason: `checkout does not declare ${path.join("harness", "harness.yaml")}` };
  }
  try {
    if (!statSync(configPath).isFile()) {
      return { status: "unavailable", reason: `${configPath} must be a regular file` };
    }
    const tasksRootSetting = readTasksRootSetting(readFileSync(configPath, "utf8"));
    if (tasksRootSetting === null) {
      return { status: "unavailable", reason: `${configPath} does not declare tasks.root` };
    }
    const normalized = path.normalize(tasksRootSetting);
    if (path.isAbsolute(tasksRootSetting) || normalized === "." || normalized.startsWith("..")
      || normalized.includes(`..${path.sep}`)) {
      return { status: "unavailable", reason: `${configPath} tasks.root must stay inside the checkout` };
    }
    const tasksRoot = path.resolve(repoRoot, normalized);
    if (!existsSync(tasksRoot) || !statSync(tasksRoot).isDirectory()) {
      return { status: "unavailable", reason: `declared tasks.root is not a directory: ${tasksRoot}` };
    }
    return { status: "checked", ledgerRoot: repoRoot, tasksRoot };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

function resolveCommonCheckoutRoot(repoRoot) {
  const dotGitPath = path.join(repoRoot, ".git");
  try {
    if (!existsSync(dotGitPath) || !statSync(dotGitPath).isFile()) return null;
    const gitDirMatch = /^gitdir:\s*(.+?)\s*$/mu.exec(readFileSync(dotGitPath, "utf8"));
    if (!gitDirMatch) return null;
    const gitDir = path.resolve(repoRoot, gitDirMatch[1]);
    const commonDirPath = path.join(gitDir, "commondir");
    if (!existsSync(commonDirPath) || !statSync(commonDirPath).isFile()) return null;
    return path.dirname(path.resolve(gitDir, readFileSync(commonDirPath, "utf8").trim()));
  } catch {
    return null;
  }
}

function readTasksRootSetting(source) {
  let inTasks = false;
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, "");
    if (!line.trim()) continue;
    const topLevel = /^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/u.exec(line);
    if (topLevel) {
      inTasks = topLevel[1] === "tasks";
      continue;
    }
    if (!inTasks) continue;
    const nested = /^\s+root:\s*(.*?)\s*$/u.exec(line);
    if (nested) return decodeGhostYamlScalar(nested[1] ?? "");
  }
  return null;
}

function readGhostYamlScalar(source, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escapedKey}:\\s*(.*?)\\s*$`, "mu").exec(source);
  return match ? decodeGhostYamlScalar(match[1] ?? "") : null;
}

function decodeGhostYamlScalar(rawValue) {
  const value = rawValue.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const decoded = JSON.parse(value);
      return typeof decoded === "string" && decoded !== "" ? decoded : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    const decoded = value.slice(1, -1).replace(/''/gu, "'");
    return decoded || null;
  }
  return value || null;
}

export function formatGhostTaskPackageReport(result) {
  if (result.status === "not-applicable") {
    return `Ghost task package check not applicable: ${result.reason}.`;
  }
  if (result.status === "unavailable") {
    return `Ghost task package check failed: self-hosted task ledger unavailable: ${result.reason}.`;
  }
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
  if (result.status === "not-applicable") return 0;
  return result.status === "checked" && result.unregisteredPackages.length === 0 && result.duplicateTaskIds.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
