#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function buildDuplicateSoftDeletePlan(rootDir, manifest) {
  validateManifest(manifest);
  const seen = new Set();
  const groups = manifest.groups.map((group) => {
    const candidates = group.candidates.map((taskId) => {
      if (seen.has(taskId)) throw new Error(`duplicate candidate across groups: ${taskId}`);
      seen.add(taskId);
      const task = readTask(rootDir, taskId);
      const action = group.keep === undefined
        ? "awaiting-selection"
        : taskId === group.keep
          ? "keep"
          : task.packageDisposition === "tombstoned"
            ? "skip-already-tombstoned"
            : "soft-delete";
      return { taskId, path: task.path, packageDisposition: task.packageDisposition, action };
    });
    return { key: group.key, keep: group.keep ?? null, candidates };
  });
  return {
    schema: "duplicate-soft-delete-dry-run/v1",
    source: manifest.source,
    readyToApply: groups.every((group) => group.keep !== null),
    groups
  };
}

export function applyDuplicateSoftDeletePlan(rootDir, manifest, plan, run = runSoftDelete) {
  if (!plan.readyToApply) {
    throw new Error("refusing apply: every duplicate group must select exactly one keep task");
  }
  const applied = [];
  for (const group of plan.groups) {
    for (const candidate of group.candidates) {
      if (candidate.action !== "soft-delete") continue;
      run(rootDir, candidate.taskId, manifest.reason, manifest.actor);
      applied.push(candidate.taskId);
    }
  }
  return applied;
}

function validateManifest(manifest) {
  if (manifest?.schema !== "duplicate-soft-delete-plan/v1") throw new Error("manifest schema must be duplicate-soft-delete-plan/v1");
  if (typeof manifest.source !== "string" || manifest.source.length === 0) throw new Error("manifest source is required");
  if (typeof manifest.reason !== "string" || manifest.reason.length === 0) throw new Error("manifest reason is required");
  if (!Array.isArray(manifest.groups) || manifest.groups.length === 0) throw new Error("manifest groups are required");
  const keys = new Set();
  for (const group of manifest.groups) {
    if (typeof group.key !== "string" || group.key.length === 0 || keys.has(group.key)) throw new Error(`invalid or duplicate group key: ${group.key}`);
    keys.add(group.key);
    if (!Array.isArray(group.candidates) || group.candidates.length < 2 || new Set(group.candidates).size !== group.candidates.length) {
      throw new Error(`group ${group.key} needs at least two unique candidates`);
    }
    if (group.keep !== undefined && !group.candidates.includes(group.keep)) throw new Error(`group ${group.key} keep task is not a candidate`);
  }
}

function readTask(rootDir, taskId) {
  const tasksRoot = path.join(rootDir, "harness/tasks");
  if (!existsSync(tasksRoot)) throw new Error(`tasks root not found: ${tasksRoot}`);
  const packageName = readdirSync(tasksRoot).find((entry) => entry === taskId || entry.startsWith(`${taskId}-`));
  if (!packageName) throw new Error(`task package not found: ${taskId}`);
  const indexPath = path.join(tasksRoot, packageName, "INDEX.md");
  const body = readFileSync(indexPath, "utf8");
  const authoredTaskId = scalar(body, "task_id");
  if (authoredTaskId !== taskId) throw new Error(`task id mismatch at ${indexPath}: ${authoredTaskId}`);
  return {
    path: path.relative(rootDir, path.dirname(indexPath)).split(path.sep).join("/"),
    packageDisposition: scalar(body, "packageDisposition") || "active"
  };
}

function scalar(body, key) {
  return new RegExp(`^${key}:\\s*(.*)$`, "mu").exec(body)?.[1]?.trim().replace(/^['"]|['"]$/gu, "") ?? "";
}

function runSoftDelete(rootDir, taskId, reason, actor) {
  const effectiveActor = actor ?? process.env.HARNESS_ACTOR;
  if (!effectiveActor) throw new Error("HARNESS_ACTOR or manifest actor is required for --apply");
  execFileSync(process.execPath, [
    path.join(repoRoot, "packages/cli/src/index.ts"),
    "--root", rootDir,
    "task", "delete", "--soft", taskId,
    "--reason", reason,
    "--json"
  ], { cwd: repoRoot, env: { ...process.env, HARNESS_ACTOR: effectiveActor }, stdio: "inherit" });
}

function main(argv) {
  const manifestPath = valueAfter(argv, "--manifest");
  const rootDir = path.resolve(valueAfter(argv, "--root") ?? process.cwd());
  if (!manifestPath) throw new Error("usage: duplicate-soft-delete --manifest <plan.json> [--root <repo>] [--apply]");
  const manifest = JSON.parse(readFileSync(path.resolve(manifestPath), "utf8"));
  const plan = buildDuplicateSoftDeletePlan(rootDir, manifest);
  const output = `${JSON.stringify(plan, null, 2)}\n`;
  process.stdout.write(output);
  const outputPath = valueAfter(argv, "--output");
  if (outputPath) {
    const absoluteOutputPath = path.resolve(outputPath);
    mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });
    writeFileSync(absoluteOutputPath, output, "utf8");
  }
  if (argv.includes("--apply")) applyDuplicateSoftDeletePlan(rootDir, manifest, plan);
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
