// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { seedSettingsEvent } from "../../daemon/test/repo-settings.fixture.ts";

const cli = path.resolve("packages/cli/src/index.ts");

test("daemon control reports Git follower failure while SQLite keeps accepting commands", () => {
  const fixture = setup();
  let refLock: string | null = null;
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
    const indexAccepted = runJson(fixture, ["task", "create", "--title", "SQLite accepts with caller index locked"]);
    assert.equal(indexAccepted.outcome, "applied", JSON.stringify(indexAccepted));
    assert.equal((gitSettled(fixture, indexAccepted).git as Record<string, unknown>).state, "verified");
    assert.equal(readFileSync(indexLock, "utf8"), "held by CLI contract test\n");
    rmSync(indexLock);
    const branchRef = git(fixture.repo, "symbolic-ref", "HEAD");
    refLock = path.join(fixture.repo, ".git", `${branchRef}.lock`);
    writeFileSync(refLock, "hold follower ref\n");
    const pending = runJson(fixture, ["task", "create", "--title", "Accepted before Git failure"]);
    assert.equal(pending.status, "accepted_durable");
    assert.ok(pending.acceptance);
    const observed = runJson(fixture, [
      "receipt",
      "show",
      String(pending.opId),
      "--wait",
      "git_verified",
      "--timeout-ms",
      "200",
    ]);
    assert.equal(observed.status, "accepted_durable");
    assert.equal((observed.git as Record<string, unknown>).state, "pending");
    const failedStatus = runJsonResult(fixture, ["daemon", "status"]);
    const failedRepo = (failedStatus.receipt.repos as readonly Record<string, unknown>[])[0]!;
    assert.equal((failedRepo.materialization as Record<string, unknown>).state, "failed");
    const next = runJson(fixture, ["task", "create", "--title", "SQLite remains accepting"]);
    assert.equal(next.status, "accepted_durable");
    rmSync(refLock);
    refLock = null;
    const recoveredWrite = runJson(fixture, ["task", "create", "--title", "Accepted after follower repair"]);
    assert.equal(recoveredWrite.status, "accepted_durable");
    assert.equal((gitSettled(fixture, recoveredWrite).git as Record<string, unknown>).state, "verified");
    const recovered = runJson(fixture, ["receipt", "show", String(pending.opId)]);
    assert.equal((recovered.git as Record<string, unknown>).state, "verified");

    const rebuilt = runText(fixture, ["daemon", "projection", "rebuild"]);
    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    assert.match(rebuilt.stdout, /stateDigest=sha256:[0-9a-f]{64}/u);

    const unregistered = runText(fixture, ["daemon", "repo", "unregister", "--repo-id", "receipt"]);
    assert.equal(unregistered.status, 0, unregistered.stderr);
    assert.match(unregistered.stdout, /repoId=receipt/u);
    assert.match(unregistered.stdout, /changed=true/u);

    // The first unregister disables and keeps history; the second removes the disabled row.
    const removed = runText(fixture, ["daemon", "repo", "unregister", "--repo-id", "receipt"]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(removed.stdout, /repoId=receipt/u);
    assert.match(removed.stdout, /changed=true/u);

    const gone = runText(fixture, ["daemon", "repo", "unregister", "--repo-id", "receipt"]);
    assert.notEqual(gone.status, 0);
    // The daemon route refuses an unknown repoId as repo_namespace_unknown; the kernel path says "not registered".
    assert.match(`${gone.stdout}${gone.stderr}`, /not registered|repo_namespace_unknown/u);
  } finally {
    rmSync(indexLock, { force: true });
    if (refLock !== null) rmSync(refLock, { force: true });
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
// Writes return their acceptance receipt; Git follower progress is observed through the explicit receipt wait.
function gitSettled(fixture: ReturnType<typeof setup>, receipt: Record<string, unknown>): Record<string, unknown> {
  return runJson(fixture, ["receipt", "show", String(receipt.opId), "--wait", "git_verified", "--timeout-ms", "5000"]);
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
