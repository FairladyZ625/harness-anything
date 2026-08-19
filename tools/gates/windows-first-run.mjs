import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cliEntrypoints } from "./platform-smoke.mjs";
import { repoRoot } from "./git.mjs";

// platform-smoke proves the packaged CLI boots and refuses cleanly on a cold machine. Every
// command it runs is asserted to fail, which is why it stayed green through #1524, #1527,
// #1565, #1586 and #1588 -- those need the product to actually run. This gate is the warm
// path: initialize a repository, hold a resident daemon, write through it, read it back, and
// put it away. It runs on every platform so a Windows-only failure is attributable.

const STEP_TIMEOUT_MS = 180_000;
const STOP_SETTLE_MS = 30_000;

function harness(entry, repo, env, args) {
  const result = spawnSync(process.execPath, [entry, "--root", repo, "--json", ...args],
    { cwd: repo, encoding: "utf8", env, timeout: STEP_TIMEOUT_MS, windowsHide: true });
  let receipt = null;
  try { receipt = JSON.parse(result.stdout); } catch (error) { consumeKnownError(error); }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", receipt, timedOut: result.error?.code === "ETIMEDOUT" };
}

function git(repo, ...args) { spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }); }

/** The published bytes are the product's core promise, and end-of-line conversion is the way
 * they silently stop being the bytes that were written (#1525, #1588). */
function carriageReturns(file) { return (readFileSync(file, "utf8").match(/\r/gu) ?? []).length; }

export function evaluateWindowsFirstRun(rootDir, { stopSettleMs = STOP_SETTLE_MS } = {}) {
  const discovered = cliEntrypoints(rootDir);
  if (discovered.errors.length > 0) return { ok: false, errors: discovered.errors, checks: [] };
  const entry = discovered.entries[0];
  const errors = [], checks = [];
  const record = (label, ok, detail) => { if (ok) checks.push(label); else errors.push(`${label}: ${detail}`); };

  const root = mkdtempSync(path.join(tmpdir(), "ha-first-run-"));
  const repo = path.join(root, "repo"), home = path.join(root, "home");
  mkdirSync(repo, { recursive: true }); mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    HARNESS_DAEMON_USER_ROOT: path.join(root, "daemon"), HARNESS_USER_HOME: path.join(home, "user-home") };
  const step = (args) => harness(entry, repo, env, args);

  try {
    git(repo, "init", "-q"); git(repo, "config", "user.email", "first-run@harness.invalid"); git(repo, "config", "user.name", "First Run");

    const initialized = step(["init", "--repo-id", "firstrun", "--person-id", "owner", "--display-name", "Owner"]);
    record("init publishes the scaffold", initialized.status === 0 && initialized.receipt?.outcome === "applied",
      `exit ${initialized.status} ${initialized.stderr.trim() || JSON.stringify(initialized.receipt)}`);
    if (initialized.status !== 0) return { ok: false, errors, checks };

    const configPath = path.join(repo, "harness/harness.yaml");
    record("init writes files that exist", existsSync(configPath), `${configPath} is missing`);
    record("published bytes carry no carriage returns", carriageReturns(configPath) === 0,
      `harness/harness.yaml holds ${carriageReturns(configPath)} carriage returns`);

    // #1588: the byte-fidelity failure is in the *clone*, not in the write. A clone reads the
    // host's global end-of-line setting and no local pin travels with it, so this is the only
    // shape of the check that can fail. Windows is where the global default makes it certain.
    const clone = path.join(root, "clone");
    const cloned = spawnSync("git", ["clone", "-q", path.join(repo, "harness"), clone], { encoding: "utf8", windowsHide: true });
    record("the ledger clones", cloned.status === 0, `git clone exited ${cloned.status}: ${(cloned.stderr ?? "").trim()}`);
    if (cloned.status === 0) {
      const clonedConfig = path.join(clone, "harness.yaml");
      record("a cloned ledger is byte-identical to the published one",
        existsSync(clonedConfig) && readFileSync(clonedConfig).equals(readFileSync(configPath)),
        `clone holds ${existsSync(clonedConfig) ? carriageReturns(clonedConfig) : "no"} carriage returns against ${carriageReturns(configPath)} published`);
    }

    const status = step(["daemon", "status"]);
    record("a resident daemon answers after init", status.status === 0, `exit ${status.status} ${status.stderr.trim()}`);

    const created = step(["task", "create", "--admin", "--id", "first-task", "--title", "First task"]);
    record("a task publishes through the daemon", created.status === 0 && created.receipt?.outcome === "applied",
      `exit ${created.status} ${created.stderr.trim() || JSON.stringify(created.receipt)}`);

    const fact = step(["fact", "record", "--task", "first-task", "--statement", "The first-run lane published a fact.", "--source", "windows-first-run"]);
    record("a fact publishes through the daemon", fact.status === 0, `exit ${fact.status} ${fact.stderr.trim()}`);

    const shown = step(["task", "show", "first-task"]);
    record("the task reads back", shown.status === 0 && JSON.stringify(shown.receipt ?? {}).includes("first-task"),
      `exit ${shown.status} ${shown.stderr.trim()}`);

    // #1565: stop reported a timeout on Windows while the daemon did stop moments later, because
    // the endpoint name outlives the process. A stop that succeeds but cannot say so is a failure.
    const stopped = step(["daemon", "stop"]);
    record("stop reports the stop it performed", stopped.status === 0,
      `exit ${stopped.status} ${stopped.stderr.trim() || JSON.stringify(stopped.receipt)}`);

    const deadline = Date.now() + stopSettleMs;
    let after = step(["daemon", "status"]);
    while (after.status === 0 && Date.now() < deadline) after = step(["daemon", "status"]);
    record("status reports the daemon gone after stop", after.status !== 0,
      `daemon still answering ${stopSettleMs}ms after a successful stop`);
  } finally {
    harness(entry, repo, env, ["daemon", "stop"]);
    rmSync(root, { recursive: true, force: true });
  }
  return { ok: errors.length === 0, errors, checks };
}

export function main() {
  const result = evaluateWindowsFirstRun(repoRoot());
  for (const check of result.checks) console.log(`windows-first-run: ${check}`);
  if (!result.ok) for (const error of result.errors) console.error(`G34 windows-first-run: ${error}`);
  return result.ok ? 0 : 1;
}
function consumeKnownError(error) { void error; }

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
