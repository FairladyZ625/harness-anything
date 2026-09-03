// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { seedSettingsEvent } from "../../daemon/test/repo-settings.fixture.ts";

const cli = path.resolve("packages/cli/src/index.ts");

test("daemon control renders status and fails closed when repository materialization is red", () => {
  const fixture = setup();
  let canonical: string | null = null;
  const indexLock = path.join(fixture.repo, ".git", "index.lock");
  try {
    assert.equal(runJson(fixture, ["daemon", "start", "--service"]).ok, true);

    const registered = runText(fixture, ["daemon", "repo", "register", "--repo-id", "receipt", "--root", fixture.repo]);
    assert.equal(registered.status, 0, registered.stderr);
    assert.match(registered.stdout, /repoId=receipt/u);
    assert.match(
      registered.stdout,
      new RegExp(`canonicalRoot=${escapeRegExp(realpathSync.native(fixture.repo))}`, "u"),
    );
    assert.match(registered.stdout, /changed=true/u);

    const unchanged = runText(fixture, ["daemon", "repo", "register", "--repo-id", "receipt", "--root", fixture.repo]);
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.match(unchanged.stdout, /repoId=receipt/u);
    assert.match(unchanged.stdout, /changed=false/u);

    const status = runText(fixture, ["daemon", "status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /pid=\d+/u);
    assert.match(status.stdout, /repos=1/u);
    const healthyStatus = runJson(fixture, ["daemon", "status"]),
      healthyRepo = (healthyStatus.repos as readonly Record<string, unknown>[])[0]!;
    assert.deepEqual((healthyRepo.materialization as Record<string, unknown>).state, "ok");

    writeFileSync(indexLock, "held by CLI contract test\n");
    const lockAccepted = runJson(fixture, ["task", "create", "--title", "Accepted into WAL before lock retry"]);
    assert.equal(lockAccepted.outcome, "applied", JSON.stringify(lockAccepted));
    let retryingRepo: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const retryingStatus = runJson(fixture, ["daemon", "status"]),
        candidate = (retryingStatus.repos as readonly Record<string, unknown>[])[0],
        materialization = candidate?.materialization as Record<string, unknown> | null;
      if (materialization?.state === "retrying") {
        retryingRepo = candidate!;
        break;
      }
    }
    assert.ok(retryingRepo, "daemon status did not expose the transient Git lock retry");
    const retryingHealth = retryingRepo.materialization as Record<string, unknown>;
    assert.equal(retryingHealth.reason, undefined);
    assert.equal(Number.isSafeInteger(retryingHealth.retryElapsedMs), true);
    assert.match(String(retryingHealth.lastError), /index\.lock[\s\S]*File exists/iu);
    const humanRetrying = runText(fixture, ["daemon", "status"]);
    assert.equal(humanRetrying.status, 0, humanRetrying.stderr);
    assert.match(humanRetrying.stdout, /state=retrying waitedMs=[0-9]+/u);
    assert.match(humanRetrying.stdout, /lastError=.*index\.lock/u);
    const retryingWrite = runJsonResult(fixture, ["task", "create", "--title", "Rejected during lock retry"]);
    assert.equal(retryingWrite.status, 1, retryingWrite.stderr);
    assert.equal(retryingWrite.receipt.code, "materialization_failed");
    assert.equal((retryingWrite.receipt.diagnostic as Record<string, unknown>).kind, "materialization-retrying");
    assert.equal((retryingWrite.receipt.diagnostic as Record<string, unknown>).state, "retrying");
    assert.equal((retryingWrite.receipt.diagnostic as Record<string, unknown>).reason, undefined);
    rmSync(indexLock, { force: true });
    let lockRecovered = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const recoveredStatus = runJson(fixture, ["daemon", "status"]),
        materialization = (recoveredStatus.repos as readonly Record<string, unknown>[])[0]?.materialization as Record<
          string,
          unknown
        > | null;
      if (materialization?.state === "ok" && materialization.pendingWalEvents === 0) {
        lockRecovered = true;
        break;
      }
    }
    assert.equal(lockRecovered, true, "transient Git lock did not self-heal and checkpoint its WAL");
    const lockRecoveredWrite = runJson(fixture, ["task", "create", "--title", "Accepted without daemon restart"]);
    assert.equal(lockRecoveredWrite.outcome, "applied", JSON.stringify(lockRecoveredWrite));
    waitForMaterializationOk(fixture);

    const preparedTask = runJson(fixture, ["task", "create", "--title", "Accepted before materialization latch"]);
    assert.equal(preparedTask.outcome, "applied", JSON.stringify(preparedTask));
    canonical = git(fixture.repo, "rev-parse", "refs/ha/canonical");
    const fork = git(fixture.repo, "commit-tree", `${canonical}^{tree}`, "-m", "materialization divergence");
    git(fixture.repo, "reset", "--hard", fork);
    let failedStatus: ReturnType<typeof runJsonResult> | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observed = runJsonResult(fixture, ["daemon", "status"]);
      if (observed.status === 1) {
        failedStatus = observed;
        break;
      }
    }
    assert.ok(failedStatus, "daemon status did not turn red after Git divergence");
    assert.equal(failedStatus.status, 1, failedStatus.stderr);
    assert.equal(failedStatus.receipt.code, "materialization_failed");
    const failedRepo = (failedStatus.receipt.repos as readonly Record<string, unknown>[])[0]!,
      failedHealth = failedRepo.materialization as Record<string, unknown>;
    assert.equal(failedHealth.state, "failed");
    assert.equal(failedHealth.reason, "git_diverged");
    assert.equal(failedHealth.pendingWalEvents, 1);
    const humanFailure = runText(fixture, ["daemon", "status"]);
    assert.equal(humanFailure.status, 1);
    assert.match(humanFailure.stderr, /error code=materialization_failed/u);
    assert.match(humanFailure.stderr, /lastCheckpointRevision=[1-9][0-9]* .*pendingWalEvents=1/u);

    const rejected = runJsonResult(fixture, ["task", "create", "--title", "Rejected after latch"]);
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.equal(rejected.receipt.code, "materialization_failed");
    assert.equal((rejected.receipt.diagnostic as Record<string, unknown>).reason, "git_diverged");

    git(fixture.repo, "reset", "--hard", canonical);
    const recoveryProbe = runJsonResult(fixture, ["task", "create", "--title", "Probe repaired latch"]);
    assert.equal(recoveryProbe.status, 1, recoveryProbe.stderr);
    assert.equal(recoveryProbe.receipt.code, "materialization_failed");
    waitForMaterializationOk(fixture);
    const recoveredWrite = runJson(fixture, ["task", "create", "--title", "Accepted after recovery"]);
    assert.equal(recoveredWrite.outcome, "applied", JSON.stringify(recoveredWrite));

    const rebuilt = runText(fixture, ["daemon", "projection", "rebuild"]);
    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    assert.match(rebuilt.stdout, /stateDigest=sha256:[0-9a-f]{64}/u);

    const unregistered = runText(fixture, ["daemon", "repo", "unregister", "--repo-id", "receipt"]);
    assert.equal(unregistered.status, 0, unregistered.stderr);
    assert.match(unregistered.stdout, /repoId=receipt/u);
    assert.match(unregistered.stdout, /changed=true/u);

    const alreadyUnregistered = runText(fixture, ["daemon", "repo", "unregister", "--repo-id", "receipt"]);
    assert.equal(alreadyUnregistered.status, 0, alreadyUnregistered.stderr);
    assert.match(alreadyUnregistered.stdout, /repoId=receipt/u);
    assert.match(alreadyUnregistered.stdout, /changed=false/u);
  } finally {
    rmSync(indexLock, { force: true });
    if (canonical !== null) {
      git(fixture.repo, "reset", "--hard", canonical);
    }
    runJsonResult(fixture, ["daemon", "stop"]);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function setup(): { readonly root: string; readonly repo: string; readonly userRoot: string } {
  const root = mkdtempSync(path.join(tmpdir(), "ha-daemon-receipt-")),
    repo = path.join(root, "repo"),
    userRoot = path.join(root, "user");
  mkdirSync(path.join(repo, "harness"), { recursive: true });
  mkdirSync(userRoot);
  writeFileSync(
    path.join(repo, "harness", "harness.yaml"),
    [
      "schema: harness-anything/v1",
      "layout:",
      "  authoredRoot: harness",
      "settings:",
      "  walFlush:",
      "    adaptive: false",
      "    events: 256",
      "    bytes: 8388608",
      "    milliseconds: 1",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(repo, "harness", "people.yaml"),
    `schema: harness-people/v1\npeople:\n  - personId: owner\n    displayName: Owner\n    primaryEmail: owner@example.test\n    roles: [owner]\n    credentials:\n      - kind: unix-socket-owner-boundary\n        issuer: host:${hostname()}\n        subject: ${process.getuid?.() ?? 0}\nroles:\n  - roleId: owner\n    commandClasses: [admin, repo-write, repo-read, arbiter]\n`,
  );
  git(repo, "init", "--quiet");
  git(repo, "add", "harness");
  git(repo, "commit", "--quiet", "-m", "fixture");
  seedSettingsEvent({ rootDir: repo, repoId: "receipt" });
  return { root, repo, userRoot };
}

function waitForMaterializationOk(fixture: ReturnType<typeof setup>): void {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = runJson(fixture, ["daemon", "status"]),
      materialization = (status.repos as readonly Record<string, unknown>[])[0]?.materialization as Record<
        string,
        unknown
      > | null;
    if (materialization?.state === "ok" && materialization.pendingWalEvents === 0) return;
  }
  assert.fail("daemon materialization did not return to ok with an empty WAL");
}
function runJson(fixture: ReturnType<typeof setup>, args: readonly string[]): Record<string, unknown> {
  const result = spawnSync(process.execPath, [cli, "--root", fixture.repo, "--json", ...args], {
    encoding: "utf8",
    env: environment(fixture),
  });
  const daemonLog = path.join(fixture.userRoot, "logs", "daemon-default.log"),
    log = existsSync(daemonLog) ? readFileSync(daemonLog, "utf8") : "daemon log absent";
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\n${log}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
function runText(fixture: ReturnType<typeof setup>, args: readonly string[]) {
  return spawnSync(process.execPath, [cli, "--root", fixture.repo, ...args], {
    encoding: "utf8",
    env: environment(fixture),
  });
}
function runJsonResult(fixture: ReturnType<typeof setup>, args: readonly string[]) {
  const result = spawnSync(process.execPath, [cli, "--root", fixture.repo, "--json", ...args], {
    encoding: "utf8",
    env: environment(fixture),
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    receipt: result.stdout.trim() ? (JSON.parse(result.stdout) as Record<string, unknown>) : {},
  };
}
function environment(fixture: ReturnType<typeof setup>): NodeJS.ProcessEnv {
  const {
    HARNESS_CANONICAL_ROOT: _canonicalRoot,
    HARNESS_DAEMON_ENDPOINT: _endpoint,
    HARNESS_DAEMON_REPO_ID: _repoId,
    HARNESS_TASK_BOUND: _taskBound,
    ...inherited
  } = process.env;
  return {
    ...inherited,
    GIT_CONFIG_GLOBAL: "/dev/null",
    HARNESS_ACTOR: "agent:harness-test",
    HARNESS_DAEMON_USER_ROOT: fixture.userRoot,
    TMPDIR: "/tmp",
  };
}
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Daemon Receipt Test",
      GIT_AUTHOR_EMAIL: "receipt@example.test",
      GIT_COMMITTER_NAME: "Daemon Receipt Test",
      GIT_COMMITTER_EMAIL: "receipt@example.test",
    },
  }).trim();
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
