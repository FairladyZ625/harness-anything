#!/usr/bin/env node
/**
 * Local pre-PR check runner (developer convenience, NOT a security boundary).
 *
 * Motivation: the full `npm run check` / `check:pr` aggregate saturates a laptop
 * (many spawned CLI subprocesses, full test-concurrency fan-out, several agents
 * running in parallel worktrees). Cloud CI (GitHub Actions branch protection)
 * enforces the real required checks; this runner only gives earlier local
 * feedback, so it may run a reduced default set without weakening merge safety.
 *
 * Design:
 *   - Machine-wide mutex lock (/tmp/harness-local-check.lock) so concurrent
 *     agents serialize instead of stacking load. Stale locks (dead pid) are
 *     reclaimed. `--no-wait` exits immediately instead of waiting.
 *   - Low QoS: on darwin, wrap each step in `taskpolicy -c utility`; otherwise
 *     fall back to `nice -n 10`; if neither is available, run bare.
 *   - Tiers: default "fast" (typecheck, lint, test:fast, test:contract,
 *     boundaries checkers, package-policy). `--full` appends test:integration
 *     test:gui, and test:gui:e2e. First failing step stops the run with a
 *     non-zero exit and a clear report of which step failed.
 *
 * This file is deliberately named `run-local-check.mjs` (not `check-*.mjs`): the
 * `check-*` prefix is the governed gate command surface reconciled by
 * tools/check-gate-surface.mjs against the gate manifest. A local convenience
 * runner must not sit on that surface.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const LOCK_DIR = "/tmp/harness-local-check.lock";
const LOCK_PID_FILE = path.join(LOCK_DIR, "pid");

// Step list. Each step is [label, npmScriptName]. Scripts already exist in
// package.json; boundaries mirrors the CI `boundaries` job (minus lint, which is
// listed once here). Keep this aligned with .github/workflows/rewrite-ci.yml.
const FAST_STEPS = [
  ["typecheck", "typecheck"],
  ["lint", "lint"],
  ["test:fast", "test:fast"],
  ["test:contract", "test:contract"],
  ["boundaries: import-boundaries", "harness:check-import-boundaries"],
  ["boundaries: file-complexity", "harness:check-file-complexity"],
  ["boundaries: forbidden-symbols", "harness:scan-forbidden-symbols"],
  ["boundaries: private-boundary", "harness:check-private-boundary"],
  ["boundaries: gate-surface", "harness:check-gate-surface"],
  ["boundaries: runtime-release-readiness", "harness:check-runtime-release-readiness"],
  ["boundaries: implementation-contracts", "harness:check-implementation-contracts"],
  ["boundaries: schema-contracts", "harness:check-schema-contracts"],
  ["boundaries: legacy-intake-readiness", "harness:check-legacy-intake-readiness"],
  ["package-policy", "harness:check-package-policy"]
];

const FULL_EXTRA_STEPS = [
  ["test:integration", "test:integration"],
  ["test:gui", "test:gui"],
  ["test:gui:e2e", "test:gui:e2e"]
];

export function parseLocalCheckArgs(args) {
  const options = { full: false, wait: true, pollMs: 2000 };
  for (const arg of args) {
    if (arg === "--full") {
      options.full = true;
      continue;
    }
    if (arg === "--no-wait") {
      options.wait = false;
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

export function buildSteps(full) {
  return full ? [...FAST_STEPS, ...FULL_EXTRA_STEPS] : [...FAST_STEPS];
}

/**
 * Pick the low-QoS wrapper for a platform, given which binaries are available.
 * Returns the argv prefix to prepend before the real command (possibly empty).
 */
export function selectQosPrefix({ platform, hasTaskpolicy, hasNice }) {
  if (platform === "darwin" && hasTaskpolicy) {
    return ["taskpolicy", "-c", "utility"];
  }
  if (hasNice) {
    return ["nice", "-n", "10"];
  }
  return [];
}

function binaryExists(name) {
  // `command -v` is a POSIX shell builtin; invoke it as a single shell string so
  // no args are passed alongside `shell: true` (avoids Node DEP0190). `name` is
  // an internal literal, never user input.
  const result = spawnSync(`command -v ${name}`, { shell: "/bin/sh", stdio: "ignore" });
  return result.status === 0;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. EPERM: exists but not ours (still alive).
    return error.code === "EPERM";
  }
}

/**
 * Acquire the machine-wide lock. Atomic mkdir; on contention, inspect the pid
 * and reclaim if stale. Honors `wait`/`pollMs`. Returns a release() function.
 */
async function acquireLock({ wait, pollMs }) {
  let announcedWait = false;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(LOCK_PID_FILE, String(process.pid), "utf8");
      return () => {
        try {
          rmSync(LOCK_DIR, { recursive: true, force: true });
        } catch {
          // best-effort release
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }

    const holderPid = readLockPid();
    if (holderPid !== null && !processAlive(holderPid)) {
      // Stale lock: previous holder died. Reclaim atomically-ish.
      try {
        rmSync(LOCK_DIR, { recursive: true, force: true });
      } catch {
        // another racer may have cleaned it; loop and retry
      }
      continue;
    }

    if (!wait) {
      const holder = holderPid === null ? "unknown pid" : `pid ${holderPid}`;
      throw new LockBusyError(`another local check is running (${holder}); --no-wait set, exiting.`);
    }

    if (!announcedWait) {
      const holder = holderPid === null ? "unknown pid" : `pid ${holderPid}`;
      console.log(`Another local check is running (${holder}). Waiting for the machine-wide lock...`);
      announcedWait = true;
    }
    await sleep(pollMs);
  }
}

function readLockPid() {
  try {
    const raw = readFileSync(LOCK_PID_FILE, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

class LockBusyError extends Error {}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runStep(label, scriptName, qosPrefix) {
  const argv = [...qosPrefix, "npm", "run", scriptName];
  const [command, ...rest] = argv;
  console.log(`\n▶ ${label}  (${argv.join(" ")})`);
  const started = Date.now();
  const result = spawnSync(command, rest, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env
  });
  const elapsedS = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error) {
    console.error(`✖ ${label} failed to launch: ${result.error.message}`);
    return { ok: false, elapsedS };
  }
  if (result.status !== 0) {
    console.error(`✖ ${label} failed (exit ${result.status ?? "signal"}) after ${elapsedS}s`);
    return { ok: false, elapsedS };
  }
  console.log(`✓ ${label} (${elapsedS}s)`);
  return { ok: true, elapsedS };
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

  const qosPrefix = selectQosPrefix({
    platform: process.platform,
    hasTaskpolicy: process.platform === "darwin" && binaryExists("taskpolicy"),
    hasNice: binaryExists("nice")
  });

  let release;
  try {
    release = await acquireLock({ wait: options.wait, pollMs: options.pollMs });
  } catch (error) {
    if (error instanceof LockBusyError) {
      console.log(error.message);
      process.exitCode = 0;
      return;
    }
    throw error;
  }

  const steps = buildSteps(options.full);
  const cores = availableParallelism();
  const qosLabel = qosPrefix.length ? qosPrefix.join(" ") : "none";
  console.log(
    `Local check (${options.full ? "full" : "fast"} tier): ${steps.length} steps, ` +
      `QoS wrapper: ${qosLabel}, cores: ${cores}. ` +
      `Cloud CI enforces the required checks; integration/gui run in CI regardless.`
  );

  const totalStart = Date.now();
  try {
    for (const [label, scriptName] of steps) {
      const outcome = runStep(label, scriptName, qosPrefix);
      if (!outcome.ok) {
        console.error(`\nLocal check stopped at: ${label}. Fix it and re-run.`);
        process.exitCode = 1;
        return;
      }
    }
  } finally {
    release();
  }

  const totalS = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log(`\nLocal check passed (${options.full ? "full" : "fast"} tier) in ${totalS}s.`);
  if (!options.full) {
    console.log("Note: integration and GUI tests are covered by cloud CI, not this fast tier.");
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Local check crashed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
