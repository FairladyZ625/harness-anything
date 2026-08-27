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
 *   - Tiers: default "fast" (fresh-main line-budget, typecheck, lint,
 *     test:fast, test:contract, boundaries checkers, package-policy, and rebuild contract gates).
 *     `--full` appends test:integration test:gui, and test:gui:e2e. First
 *     failing step stops the run with a non-zero exit and a clear report of
 *     which step failed.
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

// Step list. Each step is [label, npmScriptName]. The boundaries/package-policy
// portion is DERIVED from tools/gate-manifest.json (the same authority CI's
// run-manifest-gates.mjs consumes), so the local set cannot drift from CI for
// those jobs. Gates qualify when they run in a local-relevant PR job, expose an
// npm script, participate in check:pr, and are deterministic (no network/PR
// context needed).
const LOCAL_MANIFEST_JOBS = new Set(["boundaries", "package-policy"]);

// The boundaries job declares its exclude list in the workflow itself. Read it from
// there so this runner never grows a second hand-maintained copy. Anchored on the
// command, not on a step name: a step's prose label is free to change, and the
// previous anchor ("Run rebuild-compatible boundary gates") named a step that the
// rebuild-lane collapse deleted. Exactly one such command must exist — two would
// mean the job runs different gate sets on different lanes again, and this runner
// would have to pick one and be silently wrong on the other.
export function excludedBoundaryGateIds() {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/rewrite-ci.yml"), "utf8");
  const commands = [...workflow.matchAll(/--workflow-job boundaries(?:\s+--exclude\s+(\S+))?/gu)];
  if (commands.length !== 1) {
    throw new Error(
      `run-local-check: expected exactly one boundaries gate command in rewrite-ci.yml, found ${commands.length}`,
    );
  }
  return new Set(commands[0][1] ? commands[0][1].split(",") : []);
}

function manifestDerivedSteps() {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "tools/gate-manifest.json"), "utf8"));
  const excluded = excludedBoundaryGateIds();
  return manifest.gates
    .filter((gate) => {
      const surfaces = gate.executionSurfaces ?? {};
      const jobs = surfaces.rewriteCi?.pullRequestJobs ?? [];
      const pkg = surfaces.packageJson ?? {};
      return (
        jobs.some((job) => LOCAL_MANIFEST_JOBS.has(job)) &&
        !excluded.has(gate.id) &&
        typeof pkg.script === "string" &&
        pkg.checkPr === true &&
        gate.deterministic === true
      );
    })
    .map((gate) => [
      `${gate.executionSurfaces.rewriteCi.pullRequestJobs.find((job) => LOCAL_MANIFEST_JOBS.has(job))}: ${gate.id}`,
      gate.executionSurfaces.packageJson.script,
    ]);
}

// G32 lives in rebuild-gates.yml rather than the rewrite-ci manifest. Keep its
// base-sensitive local adapter explicit; the remaining static gates are derived.
const FAST_STEPS = [
  ["line-budget", "check:local:line-budget"],
  ["line-density", "check:local:line-density"],
  ["typecheck", "typecheck"],
  ["test:fast", "test:fast"],
  ["test:contract", "test:contract"],
  ...manifestDerivedSteps(),
  ["contracts: derived-contracts", "check:local:derived-contracts"],
  ["contracts: schema-closure", "check:local:schema-closure"],
];

const FULL_EXTRA_STEPS = [
  ["test:integration", "test:integration"],
  ["test:gui", "test:gui"],
  ["test:gui:e2e", "test:gui:e2e"],
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
    env: process.env,
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
    hasNice: binaryExists("nice"),
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
      `Cloud CI enforces the required checks on pull requests.`,
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
    console.log(
      "Note: this tier did not run test:integration or test:gui. Cloud CI runs the integration shards on every " +
        "pull request; the GUI job runs only when the pull request touches packages/gui or the root " +
        "package/tsconfig manifests. Run `npm run check:local -- --full` to cover both here.",
    );
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Local check crashed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
