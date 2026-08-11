import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeRepoPath } from "./module-policy.mjs";
import { repoRoot } from "./git.mjs";

function filesBelow(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else files.push(path.relative(directory, fullPath).split(path.sep).join("/"));
    }
  };
  walk(directory);
  return files.sort();
}

export function cliEntrypoints(rootDir) {
  const packagePath = path.join(rootDir, "packages/cli/package.json");
  if (!existsSync(packagePath)) return { entries: [], errors: ["packages/cli/package.json is missing"] };
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  const targets = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {});
  const entries = [];
  const errors = [];
  for (const target of new Set(targets)) {
    const normalized = normalizeRepoPath(target);
    if (normalized === null) {
      errors.push(`CLI bin target is not a normalized relative path: ${target}`);
      continue;
    }
    const absolutePath = path.join(rootDir, "packages/cli", normalized);
    if (!existsSync(absolutePath)) errors.push(`CLI bin target is not built: packages/cli/${normalized}`);
    else entries.push(absolutePath);
  }
  if (targets.length === 0) errors.push("packages/cli/package.json declares no bin entrypoints");
  return { entries, errors };
}

export function evaluatePlatformSmoke(rootDir) {
  const discovered = cliEntrypoints(rootDir);
  const errors = [...discovered.errors];
  const checks = [];
  for (const entry of discovered.entries) {
    const syntax = spawnSync(process.execPath, ["--check", entry], { cwd: rootDir, encoding: "utf8", windowsHide: true });
    if (syntax.status !== 0) errors.push(`${path.relative(rootDir, entry)} is not parseable by node: ${syntax.stderr.trim()}`);
    else checks.push(`${path.relative(rootDir, entry)}: parseable`);

    const isolatedHome = mkdtempSync(path.join(tmpdir(), "rebuild-platform-smoke-"));
    const daemonRoot = path.join(isolatedHome, "daemon-root");
    const help = spawnSync(process.execPath, [entry, "--help"], {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
      env: {
        ...process.env,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        HARNESS_DAEMON_MODE: "direct",
        HARNESS_DAEMON_USER_ROOT: daemonRoot,
        HARNESS_USER_HOME: path.join(isolatedHome, "user-home")
      }
    });
    if (help.error !== undefined) errors.push(`${path.relative(rootDir, entry)} --help failed to cold-start: ${help.error.message}`);
    else if (help.status !== 0) errors.push(`${path.relative(rootDir, entry)} --help exited ${help.status}: ${help.stderr.trim()}`);
    else if (!/usage|commands|harness-anything|\bha\b/iu.test(`${help.stdout}\n${help.stderr}`)) errors.push(`${path.relative(rootDir, entry)} --help produced no recognizable help output`);
    const daemonFiles = filesBelow(daemonRoot);
    if (daemonFiles.length > 0) errors.push(`${path.relative(rootDir, entry)} --help created daemon state: ${daemonFiles.join(", ")}`);
    if (help.status === 0 && daemonFiles.length === 0) checks.push(`${path.relative(rootDir, entry)}: help cold-started without daemon state`);
  }
  return { ok: errors.length === 0, errors, checks };
}

export function main() {
  const result = evaluatePlatformSmoke(repoRoot());
  for (const check of result.checks) console.log(`platform-smoke: ${check}`);
  console.log("platform-smoke: limitation: P2 exercises the baseline direct-mode help path; local-mode help isolation awaits P3 CLI wiring");
  if (!result.ok) for (const error of result.errors) console.error(`G20 platform-smoke: ${error}`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
