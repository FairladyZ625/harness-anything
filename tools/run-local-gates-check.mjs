#!/usr/bin/env node
/**
 * Worker-facing pre-push runner for the static PR gates.
 *
 * GitHub CI is authoritative; this runner only gives a worker the same verdict on the
 * cheap, purely static gates several minutes earlier, inside its own worktree. Two
 * properties define the set, both read from tools/gate-manifest.json (the single gate
 * authority) instead of a second hand-maintained checklist:
 *
 *  - `deterministic: true` and PR-visible: the gate judges only repository source and
 *    configuration. External-API gates are `deterministic: false` because they need
 *    credentials and a network the worker does not own, so they cannot pass locally.
 *    Selecting them made this runner fail on a clean worktree with
 *    "repository must be provided as owner/name" — the exact false red that teaches a
 *    worker to ignore the command.
 *  - Not a test suite, smoke, or release-policy gate: those run whole tiers, exercise a
 *    packaged artifact, or judge release posture, and CI's own lanes own them. The
 *    packaged-tarball gate alone costs ~99s of the ~200s a naive "all PR gates" selection
 *    took, for a verdict a static read cannot give.
 *
 * The remaining set is the boundary/vocabulary/dead-export/write-path/complexity/contract
 * static surface — the gates whose CI reds the fleet kept paying an ~11 minute round trip
 * for. Local wall time is ~1.5 minutes for the full set, so `--changed` narrowing is
 * offered for the common case: a gate that declares `localPathGlobs` runs only when a
 * changed path matches, while a gate with no declared scope always runs (it cannot be
 * narrowed, and it is cheap).
 *
 * This is NOT `npm run check:local` (the CEO's aggregate fast tier) and it must not grow
 * into one: no test tiers, no integration, no Docker, no packaging.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(repoRoot, "tools/gate-manifest.json");

// Categories whose verdict needs more than reading the repository: smoke gates boot a
// process or a package, release-policy gates judge a packaged artifact or release
// posture. CI's package-policy / smoke lanes own both.
const NON_STATIC_CATEGORIES = new Set(["smoke", "release-policy"]);
const TEST_SCRIPT_PATTERN = /^test:/u;

/**
 * Why a gate is not part of the local static set, or null when it is. Returning the
 * reason instead of a bare boolean keeps `--list` honest: a worker can see that a gate
 * was deliberately left to CI rather than silently dropped.
 */
export function staticGateExclusion(gate, prJobs) {
  if (gate.aggregate) return "aggregate";
  if (gate.deterministic !== true) return "needs external inputs";
  if (gate.tier !== "pr-required") return `tier ${gate.tier}`;
  const jobs = gate.executionSurfaces?.rewriteCi?.pullRequestJobs ?? [];
  if (!jobs.some((job) => prJobs.has(job))) return "not on a pull-request lane";
  if (NON_STATIC_CATEGORIES.has(gate.category)) return `category ${gate.category}`;
  const script = gate.executionSurfaces?.packageJson?.script;
  if (typeof script === "string" && TEST_SCRIPT_PATTERN.test(script)) return "test tier";
  return null;
}

/**
 * The static gate set, in manifest order. `changedPaths` applies the manifest's own
 * `localPathGlobs` narrowing; a gate without a declared scope stays because there is no
 * declaration to narrow it by.
 */
export function selectLocalGateChecks(manifest, options = {}) {
  const prJobs = new Set(manifest.surfaces?.rewriteCi?.pullRequestGateJobs ?? []);
  const gates = Array.isArray(manifest.gates) ? manifest.gates : [];
  const changedPaths = options.changedPaths ?? null;
  const selected = [];

  for (const gate of gates) {
    if (staticGateExclusion(gate, prJobs) !== null) continue;
    if (Array.isArray(changedPaths) && gate.localPathGlobs !== undefined) {
      if (!changedPaths.some((changedPath) => matchesAnyGlob(changedPath, gate.localPathGlobs))) continue;
    }
    selected.push({
      id: gate.id,
      command: gate.command,
      workflowJobs: gate.executionSurfaces?.rewriteCi?.pullRequestJobs ?? [],
    });
  }

  if (selected.length === 0 && !Array.isArray(changedPaths)) {
    throw new Error("manifest yielded no PR-visible deterministic static gates");
  }
  return selected;
}

function matchesAnyGlob(changedPath, globs) {
  const normalized = changedPath.replaceAll("\\", "/");
  return globs.some((glob) => globToRegExp(glob).test(normalized));
}

// Mirrors tools/run-manifest-gates.mjs's matcher so local narrowing and the CI runner
// cannot disagree about whether a path is in a gate's declared scope.
function globToRegExp(glob) {
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  return new RegExp(`${expression}$`, "u");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function runCommand(entry) {
  console.log(`\n▶ ${entry.id}  (${entry.command})`);
  const started = Date.now();
  const result = spawnSync(entry.command, {
    cwd: repoRoot,
    env: process.env,
    shell: true,
    stdio: "inherit",
  });
  const elapsedS = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error) {
    console.error(`✖ ${entry.id} failed to launch: ${result.error.message}`);
    return { ok: false, elapsedS };
  }
  if (result.status !== 0) {
    console.error(`✖ ${entry.id} failed (exit ${result.status ?? "signal"}) after ${elapsedS}s`);
    return { ok: false, elapsedS };
  }
  console.log(`✓ ${entry.id} (${elapsedS}s)`);
  return { ok: true, elapsedS };
}

function printPlan(plan, changed) {
  const scope = changed === null ? "whole static set" : `changed since ${changed}`;
  console.log(`Local static gate check (${scope}): ${plan.length} gate(s).`);
  for (const entry of plan) {
    console.log(`- ${entry.id}: ${entry.command} [${entry.workflowJobs.join(",")}]`);
  }
}

/**
 * Read the working-tree diff against `base` plus untracked files, the same shape
 * run-local-check uses: committed, staged, unstaged and new files all count.
 */
function localChangedPaths(base) {
  const result = spawnSync("git", ["diff", "--name-only", "-z", base, "--"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git diff against ${base} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (untracked.status !== 0) {
    throw new Error(`git ls-files failed: ${(untracked.stderr || untracked.stdout).trim()}`);
  }
  return [...new Set(`${result.stdout}${untracked.stdout}`.split("\0").filter(Boolean))].sort();
}

function parseArgs(args) {
  const options = { list: false, changed: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--list") {
      options.list = true;
      continue;
    }
    if (arg === "--changed") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        options.changed = "origin/main";
        continue;
      }
      options.changed = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown run-local-gates-check option: ${arg}`);
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const manifest = readJson(manifestPath);
  const changedPaths = options.changed === null ? null : localChangedPaths(options.changed);
  const plan = selectLocalGateChecks(manifest, { changedPaths });
  if (changedPaths !== null) {
    console.log(`Changed path selection (${options.changed}): ${changedPaths.length} path(s).`);
  }
  printPlan(plan, options.changed);

  if (options.list) {
    return;
  }

  const totalStart = Date.now();
  for (const entry of plan) {
    if (!runCommand(entry).ok) {
      console.error(`\nLocal static gate check stopped at: ${entry.id}. Fix it, then re-run.`);
      process.exitCode = 1;
      return;
    }
  }
  const totalS = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log(`\nLocal static gate check passed in ${totalS}s. CI still owns the full PR matrix.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Local static gate check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
