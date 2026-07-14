#!/usr/bin/env node
/**
 * Lightweight local stop gate. GitHub CI remains the complete authority.
 *
 * Default work is intentionally change-aware: incremental TypeScript build,
 * ESLint for changed source files, and fast/contract tests under affected
 * package/tool prefixes. `--full` is a manual convenience tier, not the worker
 * stop condition. All heavy children share the machine-wide slot and low QoS.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  discoverQosPrefix,
  prefixCommand,
  withLocalHeavySlot
} from "./local-resource-governance.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const LINTABLE_EXTENSION = /\.(?:c|m)?js$|\.tsx?$/u;
const ROOT_WIDE_TEST_INPUTS = new Set([
  "package-lock.json",
  "eslint.config.mjs",
  "tsconfig.json",
  "tsconfig.base.json"
]);

export function parseLocalCheckArgs(args) {
  const options = { full: false };
  for (const arg of args) {
    if (arg === "--full") {
      options.full = true;
      continue;
    }
    if (arg === "--fast") {
      options.full = false;
      continue;
    }
    throw new Error(`unknown run-local-check option: ${arg}`);
  }
  return options;
}

export function collectChangedFiles(root = repoRoot, run = spawnSync) {
  const mergeBase = gitOutput(run, root, ["merge-base", "HEAD", "origin/main"]);
  const base = mergeBase.ok && mergeBase.stdout ? mergeBase.stdout : "HEAD";
  const changed = gitOutput(run, root, ["diff", "--name-only", "--diff-filter=ACMR", base, "--"]);
  if (!changed.ok) throw new Error(`git diff failed: ${changed.stderr || "unknown error"}`);
  const untracked = gitOutput(run, root, ["ls-files", "--others", "--exclude-standard"]);
  if (!untracked.ok) throw new Error(`git ls-files failed: ${untracked.stderr || "unknown error"}`);
  return [...new Set([...splitLines(changed.stdout), ...splitLines(untracked.stdout)])].sort();
}

export function deriveAffectedTestPrefixes(changedFiles) {
  if (changedFiles.some((file) => ROOT_WIDE_TEST_INPUTS.has(file) || /^tsconfig\.[^.]+\.json$/u.test(file))) {
    return ["packages/", "tools/"];
  }
  const prefixes = new Set();
  for (const file of changedFiles) {
    if (file === "package.json") prefixes.add("tools/");
    const parts = file.split("/");
    if (parts[0] === "tools") prefixes.add("tools/");
    if (parts[0] !== "packages" || parts.length < 2) continue;
    const depth = parts[1] === "adapters" && parts.length >= 3 ? 3 : 2;
    prefixes.add(`${parts.slice(0, depth).join("/")}/`);
  }
  return [...prefixes].sort();
}

export function buildSteps(full, changedFiles = []) {
  const steps = [["incremental typecheck", "npm", ["run", "typecheck"]]];
  const lintFiles = changedFiles.filter((file) => LINTABLE_EXTENSION.test(file) && existsSync(path.join(repoRoot, file)));
  if (lintFiles.length > 0) steps.push(["changed-file lint", "npx", ["--no-install", "eslint", ...lintFiles]]);

  const prefixes = deriveAffectedTestPrefixes(changedFiles);
  if (prefixes.length > 0) {
    const prefixArgs = prefixes.flatMap((prefix) => ["--prefix", prefix]);
    steps.push(["affected fast tests", process.execPath, ["tools/run-node-tests.mjs", "--tier", "fast", ...prefixArgs]]);
    steps.push(["affected contract tests", process.execPath, ["tools/run-node-tests.mjs", "--tier", "contract", ...prefixArgs]]);
    if (prefixes.includes("packages/") || prefixes.includes("packages/gui/")) {
      steps.push(["affected GUI tests", "npm", ["run", "test:gui"]]);
    }
  }

  if (full) {
    steps.push(["integration tests", "npm", ["run", "test:integration"]]);
    steps.push(["GUI E2E", "npm", ["run", "test:gui:e2e"]]);
    steps.push(["manifest local gates", "npm", ["run", "check:local:gates"]]);
  }
  return steps;
}

export function buildLocalStepInvocation(qosPrefix, command, args) {
  return prefixCommand(qosPrefix, command, args);
}

function runStep([label, command, args], qosPrefix, env) {
  const invocation = buildLocalStepInvocation(qosPrefix, command, args);
  const displayed = [invocation.command, ...invocation.args].join(" ");
  console.log(`\n▶ ${label}  (${displayed})`);
  const started = Date.now();
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    stdio: "inherit",
    env
  });
  const elapsedS = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error) {
    console.error(`✖ ${label} failed to launch: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`✖ ${label} failed (exit ${result.status ?? "signal"}) after ${elapsedS}s`);
    return false;
  }
  console.log(`✓ ${label} (${elapsedS}s)`);
  return true;
}

async function main(argv) {
  let options;
  try {
    options = parseLocalCheckArgs(argv);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }

  const changedFiles = collectChangedFiles();
  const steps = buildSteps(options.full, changedFiles);
  const qosPrefix = discoverQosPrefix();
  await withLocalHeavySlot({ label: options.full ? "check:local:full" : "check:local" }, async (lease) => {
    console.log(
      `Local check (${options.full ? "manual full" : "light stop-gate"}): ${steps.length} steps, ` +
      `${changedFiles.length} changed files, QoS=${qosPrefix.join(" ") || "none"}, slot=${path.basename(lease.slotPath)}. ` +
      "GitHub CI remains the complete authority."
    );
    const started = Date.now();
    for (const step of steps) {
      if (!runStep(step, qosPrefix, lease.childEnv)) {
        console.error(`\nLocal check stopped at: ${step[0]}. Fix it and re-run.`);
        process.exitCode = 1;
        return;
      }
    }
    console.log(`\nLocal check passed in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
    if (!options.full) console.log("GitHub CI still runs every manifest-declared pull-request gate.");
  });
}

function gitOutput(run, root, args) {
  const result = run("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? ""
  };
}

function splitLines(value) {
  return value ? value.split(/\r?\n/u).filter(Boolean) : [];
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Local check crashed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
