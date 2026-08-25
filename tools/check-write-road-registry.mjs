#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findW3WriteAuthorityViolations } from "./check-write-coordinator-boundary.mjs";

const requiredRows = Object.freeze({
  "lifecycle.event-publication": ["task-create", "task-submit", "task-review-execution", "task-complete"],
  "workspace.bootstrap": ["repo-bootstrap", "daemon-repo-register", "daemon-repo-unregister"],
  "daemon.runtime-control": ["daemon-start", "daemon-stop"],
  "projection.sqlite": [],
});
const mutatingFs = new Set([
  "appendFile",
  "appendFileSync",
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "fsyncSync",
  "mkdir",
  "mkdirSync",
  "open",
  "openSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "symlink",
  "symlinkSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "write",
  "writeFile",
  "writeFileSync",
  "writeSync",
]);

export function findWriteRoadRegistryViolations(
  rootDir = process.cwd(),
  registryRelative = "tools/write-road-registry.json",
) {
  const violations = findW3WriteAuthorityViolations(rootDir),
    registryPath = path.join(rootDir, registryRelative);
  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch (error) {
    return [...violations, `${registryRelative}: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (registry.schema !== "harness-anything/write-road-registry/v2" || !Array.isArray(registry.rows))
    return [...violations, `${registryRelative}: expected write-road-registry/v2 rows`];
  const ids = registry.rows.map((row) => row?.id);
  for (const id of Object.keys(requiredRows))
    if (ids.filter((candidate) => candidate === id).length !== 1)
      violations.push(`${registryRelative}: row ${id} must occur exactly once`);
  for (const row of registry.rows) {
    if (!Object.hasOwn(requiredRows, row?.id)) {
      violations.push(`${registryRelative}: stale or unknown row ${String(row?.id)}`);
      continue;
    }
    if (JSON.stringify(row.actions ?? []) !== JSON.stringify(requiredRows[row.id]))
      violations.push(`${row.id}: actions must equal ${requiredRows[row.id].join(",")}`);
    if (!Array.isArray(row.evidence) || row.evidence.length === 0)
      violations.push(`${row.id}: evidence must be non-empty`);
    for (const file of row.evidence ?? [])
      if (typeof file !== "string" || !existsSync(path.join(rootDir, file)))
        violations.push(`${row.id}: missing evidence ${String(file)}`);
  }
  const lifecycle = registry.rows.find((row) => row.id === "lifecycle.event-publication");
  if (
    lifecycle?.authority !== "packages/daemon/src/repo-cell.ts" ||
    lifecycle?.store !== "packages/kernel/src/store/task-event-store.ts" ||
    lifecycle?.leasePolicy !== "domain-contract"
  ) {
    violations.push(
      "lifecycle.event-publication: authority/store/leasePolicy must bind RepoCell -> task event store -> domain contract",
    );
  }
  const cli = read(path.join(rootDir, "packages/cli/src/cli/thin-command.ts"));
  for (const action of requiredRows["lifecycle.event-publication"])
    if (!cli.includes(`"${action}"`)) violations.push(`thin CLI is missing lifecycle action ${action}`);
  const discovered = discoverPhysicalWriteFiles(rootDir),
    declared = [...new Set(registry.physicalWriteFiles ?? [])].sort();
  for (const file of discovered)
    if (!declared.includes(file)) violations.push(`${file}: physical write sink is not declared`);
  for (const file of declared)
    if (!discovered.includes(file)) violations.push(`${file}: stale physicalWriteFiles entry`);
  return violations;
}

function discoverPhysicalWriteFiles(rootDir) {
  const files = walk(path.join(rootDir, "packages"), rootDir).filter(
    (file) => file.includes("/src/") && file.endsWith(".ts"),
  );
  return files
    .filter((file) => {
      const body = read(path.join(rootDir, file));
      const fsImports = [...body.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["']node:fs["']/gu)].flatMap((match) =>
        match[1].split(",").map((name) => name.trim().split(/\s+as\s+/u)[0]),
      );
      const fsWrite = fsImports.some((name) => mutatingFs.has(name));
      const gitWrite =
        /\b(?:execFileSync|spawnSync)\(\s*["']git["']/u.test(body) &&
        !/^packages\/kernel\/src\/projection\/post-merge-checks\.ts$/u.test(file);
      const sqliteWrite =
        /from\s*["'](?:node:sqlite|@effect\/sql-sqlite-node)["']/u.test(body) &&
        hasWritableSqliteConstructionSite(body);
      return fsWrite || gitWrite || sqliteWrite;
    })
    .sort();
}
function walk(directory, rootDir) {
  if (!existsSync(directory)) return [];
  const out = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...walk(file, rootDir));
    else out.push(path.relative(rootDir, file).split(path.sep).join("/"));
  }
  return out;
}
function hasWritableSqliteConstructionSite(body) {
  for (const match of body.matchAll(/(?:new\s+DatabaseSync|SqliteClient\.make)\s*\(/gu)) {
    const args = sqliteConstructionArguments(body, match.index + match[0].length);
    if (args !== null && !/readOnly:\s*true/u.test(args)) return true;
  }
  return false;
}
function sqliteConstructionArguments(body, openParenIndex) {
  let depth = 1,
    quote = null;
  for (let index = openParenIndex; index < body.length; index += 1) {
    const char = body[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return body.slice(openParenIndex, index);
    }
  }
  return null;
}
function read(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}
function main() {
  const violations = findWriteRoadRegistryViolations();
  if (violations.length > 0) {
    console.error("Write-road registry check failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  } else
    console.log(
      "Write-road registry check passed: legacy roads absent and RepoCell/event store is the sole lifecycle write road.",
    );
}
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
