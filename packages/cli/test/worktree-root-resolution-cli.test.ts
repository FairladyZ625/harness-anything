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
    const created = runRawJson(fixture.canonicalRoot, ["task", "create", "--title", "Worktree Root"]);
    const taskId = receiptData(created).taskId;
    assert.equal(typeof taskId, "string");

    const shown = runFrom(fixture.worktreeRoot, ["--json", "task", "show", String(taskId)], fixture.env);

    assert.equal(shown.status, 0);
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
    assert.equal(text.status, 0);
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

    assert.equal(listed.status, 0);
    assert.deepEqual(receiptRootResolution(listed.receipt), {
      root: realpathSync.native(explicitRoot),
      source: "explicit-override"
    });
    const local = runFrom(explicitRoot, ["--json", "task", "list"], fixture.env);
    assert.equal(local.status, 0);
    assert.deepEqual(receiptRootResolution(local.receipt), {
      root: realpathSync.native(explicitRoot),
      source: "local-cwd"
    });
  } finally {
    await stopDaemon(explicitRoot, fixture.userRoot);
    await cleanupFixture(fixture);
  }
});

test("git common-dir parent is rejected when it is not a registered repo root", async () => {
  const fixture = createWorktreeFixture("unregistered", false);
  const registeredRoot = path.join(fixture.containerRoot, "registered-root");
  mkdirSync(registeredRoot, { recursive: true });
  try {
    initializeNestedHarnessRepo(registeredRoot);
    registerRepo(registeredRoot, fixture.userRoot, "registered", fixture.env);

    const failed = runFrom(fixture.worktreeRoot, ["--json", "task", "list"], fixture.env);

    assert.notEqual(failed.status, 0);
    assert.equal(failed.receipt.error?.code, "journal_unavailable");
    assert.match(String(failed.receipt.error?.hint), /could not resolve a registered harness repo root/iu);
    assert.match(String(failed.receipt.error?.hint), /git common-dir candidate .* is not registered/iu);
    assert.doesNotMatch(String(failed.receipt.error?.hint), /Start the daemon|recovery escape hatch/iu);
  } finally {
    await stopDaemon(registeredRoot, fixture.userRoot);
    await cleanupFixture(fixture);
  }
});

test("non-git cwd keeps the unregistered-root failure path", async () => {
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

    assert.notEqual(failed.status, 0);
    assert.equal(failed.receipt.error?.code, "journal_unavailable");
    assert.match(String(failed.receipt.error?.hint), /could not resolve a registered harness repo root/iu);
    assert.doesNotMatch(String(failed.receipt.error?.hint), /git common-dir candidate/iu);
  } finally {
    await stopDaemon(registeredRoot, userRoot);
    rmSync(containerRoot, { recursive: true, force: true });
  }
});

test("resolved roots retain the daemon-unavailable recovery hint for real connection failures", async () => {
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

    assert.notEqual(failed.status, 0);
    assert.equal(failed.receipt.error?.code, "journal_unavailable");
    assert.match(String(failed.receipt.error?.hint), /Daemon unavailable/iu);
    assert.match(String(failed.receipt.error?.hint), /HARNESS_DIRECT_WRITE_REASON=recovery/iu);
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

function createWorktreeFixture(name: string, registerCanonical = true, useProjectDaemonRoot = false): WorktreeFixture {
  const containerRoot = mkdtempSync(path.join(tmpdir(), `ha-worktree-root-${name}-`));
  const canonicalRoot = path.join(containerRoot, "canonical");
  const worktreeRoot = path.join(containerRoot, "worktree");
  const userRoot = path.join(containerRoot, "user-daemon");
  const env = daemonEnv(containerRoot, useProjectDaemonRoot ? undefined : userRoot);
  mkdirSync(canonicalRoot, { recursive: true });
  runGit(canonicalRoot, "init");
  writeFileSync(path.join(canonicalRoot, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
  runGit(canonicalRoot, "add", ".gitignore");
  runGit(canonicalRoot, "commit", "-m", "seed worktree fixture");
  initializeNestedHarnessRepo(canonicalRoot);
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
} {
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    env
  });
  return {
    status: result.status,
    receipt: JSON.parse(result.stdout || "{}") as Record<string, any>
  };
}

function receiptData(receipt: Record<string, any>): Record<string, any> {
  return receipt.details?.data ?? {};
}

function receiptRootResolution(receipt: Record<string, any>): unknown {
  return receipt.details?.rootResolution;
}

function daemonEnv(homeRoot: string, userRoot?: string): NodeJS.ProcessEnv {
  return cliTestEnv({
    HOME: path.join(homeRoot, ".home"),
    USERPROFILE: path.join(homeRoot, ".home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    HARNESS_ACTOR: "agent:worktree-root-test",
    HARNESS_GIT_AUTHOR_NAME: "Harness Test",
    HARNESS_GIT_AUTHOR_EMAIL: "harness@example.test",
    ...(userRoot ? { HARNESS_DAEMON_USER_ROOT: userRoot } : {}),
    HA_PROGRESS: "0"
  });
}

function writeProjectDaemonRoot(rootDir: string, userRoot: string): void {
  const configPath = path.join(rootDir, "harness", "harness.yaml");
  writeFileSync(configPath, `${readFileSync(configPath, "utf8")}  daemon:\n    userRoot: ${userRoot}\n`, "utf8");
}

function runGit(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Harness Test",
      GIT_AUTHOR_EMAIL: "harness-test@example.invalid",
      GIT_COMMITTER_NAME: "Harness Test",
      GIT_COMMITTER_EMAIL: "harness-test@example.invalid"
    }
  }).trim();
}
