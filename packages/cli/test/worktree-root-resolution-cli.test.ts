// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "../../daemon/src/index.ts";
import { cliTestEnv } from "./helpers/cli-test-env.ts";
import { initializeNestedHarnessRepo } from "./helpers/git-fixtures.ts";
import { runDaemonCommand, runRawJson, stopDaemon } from "./helpers/daemon-cli.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("worktree commands derive a registered canonical root from git common-dir", async () => {
  const fixture = createWorktreeFixture("registered", true, true);
  try {
    const created = runRawJson(
      fixture.canonicalRoot,
      ["task", "create", "--title", "Worktree Root"],
      { HARNESS_DAEMON_USER_ROOT: "" }
    );
    const taskId = receiptData(created).taskId;
    assert.equal(typeof taskId, "string");

    const shown = runFrom(fixture.worktreeRoot, ["--json", "task", "show", String(taskId)], fixture.env);

    assert.equal(shown.status, 0, shown.diagnostic);
    assert.equal(shown.receipt.ok, true);
    assert.deepEqual(receiptRootResolution(shown.receipt), {
      root: realpathSync.native(fixture.canonicalRoot),
      source: "git-common-dir"
    });
    const text = spawnSync(process.execPath, [cliEntry, "task", "show", String(taskId)], {
      cwd: fixture.worktreeRoot,
      encoding: "utf8",
      env: fixture.env
    });
    assert.equal(text.status, 0, formatChildResult(text));
    assert.match(text.stdout, /root=.*canonical rootSource=git-common-dir/iu);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("explicit root override wins over a registered git common-dir candidate", async () => {
  const fixture = createWorktreeFixture("explicit");
  const explicitRoot = path.join(fixture.containerRoot, "explicit-root");
  mkdirSync(explicitRoot, { recursive: true });
  try {
    initializeNestedHarnessRepo(explicitRoot);
    registerRepo(explicitRoot, fixture.userRoot, "explicit", fixture.env);

    const listed = runFrom(fixture.worktreeRoot, ["--root", explicitRoot, "--json", "task", "list"], fixture.env);

    assert.equal(listed.status, 0, listed.diagnostic);
    assert.deepEqual(receiptRootResolution(listed.receipt), {
      root: realpathSync.native(explicitRoot),
      source: "explicit-override"
    });
    const local = runFrom(explicitRoot, ["--json", "task", "list"], fixture.env);
    assert.equal(local.status, 0, local.diagnostic);
    assert.deepEqual(receiptRootResolution(local.receipt), {
      root: realpathSync.native(explicitRoot),
      source: "local-cwd"
    });
  } finally {
    await stopDaemon(explicitRoot, fixture.userRoot);
    await cleanupFixture(fixture);
  }
});

test("linked worktree reports its unregistered canonical harness root with actionable commands", async () => {
  const fixture = createWorktreeFixture("unregistered", false);
  const registeredRoot = path.join(fixture.containerRoot, "registered-root");
  mkdirSync(registeredRoot, { recursive: true });
  try {
    initializeNestedHarnessRepo(registeredRoot);
    registerRepo(registeredRoot, fixture.userRoot, "registered", fixture.env);

    const failed = runFrom(fixture.worktreeRoot, ["--json", "task", "list"], fixture.env);

    assert.notEqual(failed.status, 0, failed.diagnostic);
    const hint = String(failed.receipt.error?.hint);
    const canonicalRoot = realpathSync.native(fixture.canonicalRoot);
    assert.equal(failed.receipt.error?.code, "harness_root_unresolved");
    assert.match(hint, /detected current directory .* inside a linked Git worktree/iu);
    assert.match(hint, new RegExp(`canonical repository is ${escapeRegExp(JSON.stringify(canonicalRoot))}`, "u"));
    assert.match(hint, /canonical repository is an initialized harness repository, but it is not registered/iu);
    assert.match(hint, new RegExp(`ha daemon repo register --root ${escapeRegExp(canonicalRoot)}`, "u"));
    assert.match(hint, new RegExp(`ha --root ${escapeRegExp(canonicalRoot)} task create --title`, "u"));
    assert.doesNotMatch(String(failed.receipt.error?.hint), /Start the daemon|recovery escape hatch/iu);
  } finally {
    await stopDaemon(registeredRoot, fixture.userRoot);
    await cleanupFixture(fixture);
  }
});

test("linked worktree preserves its canonical repository when that repository is not a harness root", async () => {
  const fixture = createWorktreeFixture("not-harness", false, false, false);
  const registeredRoot = path.join(fixture.containerRoot, "registered-root");
  mkdirSync(registeredRoot, { recursive: true });
  try {
    initializeNestedHarnessRepo(registeredRoot);
    registerRepo(registeredRoot, fixture.userRoot, "registered", fixture.env);

    const failed = runFrom(fixture.worktreeRoot, ["--json", "task", "list"], fixture.env);

    assert.notEqual(failed.status, 0, failed.diagnostic);
    const hint = String(failed.receipt.error?.hint);
    const canonicalRoot = realpathSync.native(fixture.canonicalRoot);
    const worktreeRoot = realpathSync.native(fixture.worktreeRoot);
    assert.equal(failed.receipt.error?.code, "harness_root_unresolved");
    assert.match(hint, /detected current directory .* inside a linked Git worktree/iu);
    assert.match(hint, new RegExp(`canonical repository is ${escapeRegExp(JSON.stringify(canonicalRoot))}`, "u"));
    assert.match(hint, /canonical repository is not an initialized harness repository/iu);
    assert.match(hint, /harness\/harness\.yaml was not found/iu);
    assert.match(hint, new RegExp(`ha --root ${escapeRegExp(canonicalRoot)} init`, "u"));
    assert.match(hint, new RegExp(`ha daemon repo register --root ${escapeRegExp(canonicalRoot)}`, "u"));
    assert.match(hint, new RegExp(`ha --root ${escapeRegExp(canonicalRoot)} task create --title`, "u"));
    assert.equal(hint.includes(`ha daemon repo register --root ${worktreeRoot}`), false);
  } finally {
    await stopDaemon(registeredRoot, fixture.userRoot);
    await cleanupFixture(fixture);
  }
});

test("non-git directory reports a non-harness root without worktree wording", async () => {
  const containerRoot = mkdtempSync(path.join(tmpdir(), "ha-non-git-root-"));
  const registeredRoot = path.join(containerRoot, "registered-root");
  const outsiderRoot = path.join(containerRoot, "outsider");
  const userRoot = path.join(containerRoot, "user-daemon");
  const env = daemonEnv(containerRoot, userRoot);
  mkdirSync(registeredRoot, { recursive: true });
  mkdirSync(outsiderRoot, { recursive: true });
  try {
    runRawJson(registeredRoot, ["init"], env);

    const failed = runFrom(outsiderRoot, ["--json", "task", "list"], env);

    assert.notEqual(failed.status, 0, failed.diagnostic);
    const hint = String(failed.receipt.error?.hint);
    const resolvedOutsiderRoot = realpathSync.native(outsiderRoot);
    assert.equal(failed.receipt.error?.code, "harness_root_unresolved");
    assert.match(hint, /current directory .* is not an initialized harness repository/iu);
    assert.match(hint, /harness\/harness\.yaml was not found/iu);
    assert.match(hint, new RegExp(`ha --root ${escapeRegExp(resolvedOutsiderRoot)} init`, "u"));
    assert.match(hint, new RegExp(`ha daemon repo register --root ${escapeRegExp(resolvedOutsiderRoot)}`, "u"));
    assert.match(hint, new RegExp(`ha --root ${escapeRegExp(resolvedOutsiderRoot)} task create --title`, "u"));
    assert.doesNotMatch(hint, /worktree|git common-dir/iu);
  } finally {
    await stopDaemon(registeredRoot, userRoot);
    rmSync(containerRoot, { recursive: true, force: true });
  }
});

test("resolved roots report an honest daemon_starting state when autostart spawns a live process under a tiny budget", async () => {
  // PLT-Honest: the endpoint starts as an empty directory, which the autostart
  // namespace logic repairs, and autostart spawns a real daemon. Under the
  // tiny 30ms budget the spawned process is still alive (Node is booting), so
  // the honest classification is daemon_starting — never daemon_unavailable
  // with a direct-mode hint that would send an operator to kill the recovering
  // daemon. The previous assertion encoded the old, dangerous conflation.
  if (process.platform === "win32") return;
  const containerRoot = mkdtempSync(path.join(tmpdir(), "ha-daemon-unavailable-root-"));
  const canonicalRoot = path.join(containerRoot, "canonical");
  const userRoot = path.join(containerRoot, "user-daemon");
  const env = daemonEnv(containerRoot, userRoot);
  mkdirSync(canonicalRoot, { recursive: true });
  initializeNestedHarnessRepo(canonicalRoot);
  registerRepo(canonicalRoot, userRoot, "canonical", env);
  const endpoint = localUserDaemonEndpoint(userRoot);
  try {
    mkdirSync(endpoint, { recursive: true });
    const failed = runFrom(canonicalRoot, ["--root", canonicalRoot, "--json", "task", "list"], {
      ...env,
      HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "30"
    });

    assert.notEqual(failed.status, 0, failed.diagnostic);
    assert.equal(failed.receipt.error?.code, "daemon_starting");
    assert.match(String(failed.receipt.error?.hint), /still starting/iu);
    assert.match(String(failed.receipt.error?.hint), /Do NOT use HARNESS_DAEMON_MODE=direct/u, "direct mode must be explicitly prohibited");
    assert.match(String(failed.receipt.error?.hint), /Do NOT run 'ha daemon restart'/u, "restart must be explicitly prohibited");
  } finally {
    rmSync(endpoint, { recursive: true, force: true });
    rmSync(`${endpoint}.owner`, { force: true });
    rmSync(containerRoot, { recursive: true, force: true });
  }
});

interface WorktreeFixture {
  readonly containerRoot: string;
  readonly canonicalRoot: string;
  readonly worktreeRoot: string;
  readonly userRoot: string;
  readonly env: NodeJS.ProcessEnv;
}

function createWorktreeFixture(
  name: string,
  registerCanonical = true,
  useProjectDaemonRoot = false,
  initializeCanonical = true
): WorktreeFixture {
  const containerRoot = realpathSync.native(mkdtempSync(path.join(tmpdir(), `ha-worktree-root-${name}-`)));
  const canonicalRoot = path.join(containerRoot, "canonical");
  const worktreeRoot = path.join(containerRoot, "worktree");
  const userRoot = path.join(containerRoot, "user-daemon");
  const env = daemonEnv(containerRoot, useProjectDaemonRoot ? undefined : userRoot);
  mkdirSync(canonicalRoot, { recursive: true });
  runGit(canonicalRoot, "init");
  writeFileSync(path.join(canonicalRoot, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
  runGit(canonicalRoot, "add", ".gitignore");
  runGit(canonicalRoot, "commit", "-m", "seed worktree fixture");
  if (initializeCanonical) initializeNestedHarnessRepo(canonicalRoot);
  if (useProjectDaemonRoot) writeProjectDaemonRoot(canonicalRoot, "../user-daemon");
  if (registerCanonical) registerRepo(canonicalRoot, userRoot, "canonical", env);
  runGit(canonicalRoot, "worktree", "add", "--detach", worktreeRoot);
  return { containerRoot, canonicalRoot, worktreeRoot, userRoot, env };
}

async function cleanupFixture(fixture: WorktreeFixture): Promise<void> {
  await stopDaemon(fixture.canonicalRoot, fixture.userRoot);
  rmSync(fixture.containerRoot, { recursive: true, force: true });
}

function registerRepo(rootDir: string, userRoot: string, repoId: string, env: NodeJS.ProcessEnv): void {
  runDaemonCommand(rootDir, [
    "daemon", "repo", "register", "--repo-id", repoId, "--root", rootDir,
    "--user-root", userRoot, "--no-link", "--json"
  ], env as Record<string, string>);
}

function runFrom(cwd: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv): {
  readonly status: number | null;
  readonly receipt: Record<string, any>;
  readonly diagnostic: string;
} {
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    env
  });
  const diagnostic = formatChildResult(result);
  let receipt: Record<string, any>;
  try {
    receipt = JSON.parse(result.stdout || "{}") as Record<string, any>;
  } catch (error) {
    throw new Error(`CLI stdout was not JSON.\n${diagnostic}`, { cause: error });
  }
  return {
    status: result.status,
    receipt,
    diagnostic
  };
}

function formatChildResult(result: {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}): string {
  return [
    `status=${String(result.status)} signal=${String(result.signal)}`,
    `stdout:\n${result.stdout || "<empty>"}`,
    `stderr:\n${result.stderr || "<empty>"}`,
    ...(result.error ? [`spawn error:\n${result.error.stack ?? result.error.message}`] : [])
  ].join("\n");
}

function receiptData(receipt: Record<string, any>): Record<string, any> {
  return receipt.details?.data ?? {};
}

function receiptRootResolution(receipt: Record<string, any>): unknown {
  return receipt.details?.rootResolution;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function daemonEnv(homeRoot: string, userRoot?: string): NodeJS.ProcessEnv {
  return cliTestEnv({
    HOME: path.join(homeRoot, ".home"),
    USERPROFILE: path.join(homeRoot, ".home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    HARNESS_CLI_TEST_FIXTURE_PRELOAD: "",
    HARNESS_ACTOR: "agent:worktree-root-test",
    HARNESS_GIT_AUTHOR_NAME: "Harness Test",
    HARNESS_GIT_AUTHOR_EMAIL: "harness@example.test",
    NODE_OPTIONS: "",
    ...(userRoot ? { HARNESS_DAEMON_USER_ROOT: userRoot } : {}),
    HA_PROGRESS: "0"
  });
}

function writeProjectDaemonRoot(rootDir: string, userRoot: string): void {
  const configPath = path.join(rootDir, "harness", "harness.yaml");
  writeFileSync(configPath, `${readFileSync(configPath, "utf8")}  daemon:\n    userRoot: ${userRoot}\n`, "utf8");
}

function runGit(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", [
    "-c", "user.name=Harness Test",
    "-c", "user.email=harness-test@example.invalid",
    "-c", "init.defaultBranch=main",
    "-C", rootDir,
    ...args
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null"
    }
  }).trim();
}
