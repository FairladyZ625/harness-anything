// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { daemonProcessAlive } from "@harness-anything/daemon/internal/daemon-singleton";
import { stop, waitForProcessExit } from "./daemon-autostart-cli.fixture.ts";
import { type TestContext } from "node:test";
import { waitForDurableCondition } from "../../../tools/fixtures/event-arrival.ts";
import {
  cli,
  cliEnv,
  escapeRegExp,
  git,
  localUserDaemonEndpoint,
  processAlive,
  readDaemonLifecycleRecords,
  readDaemonPid,
  realpathSync,
  register,
  run,
  setup,
} from "./daemon-autostart-cli.fixture.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

const childTestTimeoutMs = process.platform === "win32" ? 90_000 : 30_000;
const cleanupExitTimeoutMs = process.platform === "win32" ? 10_000 : 2_000;

test("autostart fixture stops its daemon even when the owning test throws", async () => {
  const parent = mkdtempSync(path.join(realpathSync.native(tmpdir()), "ha-autostart-cleanup-")),
    witness = path.join(parent, "witness.json"),
    childTest = path.join(parent, "failure.test.mjs"),
    fixtureModule = new URL("./daemon-autostart-cli.fixture.ts", import.meta.url).href;
  let fixture: { parent: string; root: string; userRoot: string; pid: number } | undefined;
  try {
    writeFileSync(
      childTest,
      `import test from "node:test";
import { writeFileSync } from "node:fs";
import { setup, run, readDaemonPid } from ${JSON.stringify(fixtureModule)};
test("intentional failure after daemon launch", () => {
  const fixture = setup();
  run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]);
  writeFileSync(${JSON.stringify(witness)}, JSON.stringify({ ...fixture, pid: readDaemonPid(fixture.userRoot, "default") }));
  throw new Error("intentional fixture-owner failure");
});
`,
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ["--test", childTest], {
      encoding: "utf8",
      env,
      timeout: childTestTimeoutMs,
    });
    assert.equal(existsSync(witness), true, `${child.stderr}\n${child.stdout}`);
    fixture = JSON.parse(readFileSync(witness, "utf8"));
    assert.ok(fixture);
    assert.equal(child.status, 1, `${child.stderr}\n${child.stdout}`);
    assert.match(child.stdout, /intentional fixture-owner failure/u);
    assert.equal(daemonProcessAlive(fixture.pid), false, `fixture daemon ${fixture.pid} outlived its failed test`);
    assert.equal(existsSync(fixture.parent), false, "fixture removal must follow daemon exit");
  } finally {
    if (fixture) {
      stop(fixture.root, fixture.userRoot);
      await waitForProcessExit(fixture.pid, cleanupExitTimeoutMs);
      removeTempRepository(fixture.parent);
    }
    removeTempRepository(parent);
  }
});

// The runner's preload names the owner for test files it starts; a test file started directly with
// `node --test <path>` gets no preload, and its detached daemon then outlived the file. The launch
// seam names the test file process, so the same kill still ends the daemon. This arm carries no
// preload on purpose: it is the leak that was reported, reproduced.
test("a daemon started by a directly-run test file exits when that file is killed", async () => {
  const parent = mkdtempSync(path.join(realpathSync.native(tmpdir()), "ha-autostart-direct-owner-")),
    witness = path.join(parent, "witness.json"),
    childTest = path.join(parent, "direct-owner-killed.test.mjs"),
    fixtureModule = new URL("./daemon-autostart-cli.fixture.ts", import.meta.url).href;
  let fixture: { parent: string; root: string; userRoot: string; pid: number } | undefined;
  try {
    writeFileSync(
      childTest,
      `import test from "node:test";
import { writeFileSync } from "node:fs";
import { setup, run, readDaemonPid } from ${JSON.stringify(fixtureModule)};
test("directly-run test file owns the daemon it starts", () => {
  const fixture = setup();
  run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]);
  writeFileSync(${JSON.stringify(witness)}, JSON.stringify({ ...fixture, pid: readDaemonPid(fixture.userRoot, "default") }));
  process.kill(process.pid, "SIGKILL");
});
`,
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.HARNESS_DAEMON_OWNER_PID;
    const child = spawnSync(process.execPath, ["--test", childTest], {
      encoding: "utf8",
      env,
      timeout: childTestTimeoutMs,
    });
    assert.equal(existsSync(witness), true, `${child.stderr}\n${child.stdout}`);
    fixture = JSON.parse(readFileSync(witness, "utf8"));
    assert.ok(fixture);
    assert.equal(child.status, 1, `${child.stderr}\n${child.stdout}`);
    await waitForProcessExit(fixture.pid, 10_000);
    assert.equal(
      daemonProcessAlive(fixture.pid),
      false,
      `daemon ${fixture.pid} outlived the directly-run test file that started it`,
    );
  } finally {
    if (fixture) {
      stop(fixture.root, fixture.userRoot);
      await waitForProcessExit(fixture.pid, cleanupExitTimeoutMs);
      removeTempRepository(fixture.parent);
    }
    removeTempRepository(parent);
  }
});

// The owner is named by the preload the test runner gives every test child, not by this fixture:
// a test file that knows nothing about daemon ownership is covered the same way.
test("daemon exits when its fixture owner is killed", async () => {
  const parent = mkdtempSync(path.join(realpathSync.native(tmpdir()), "ha-autostart-owner-liveness-")),
    witness = path.join(parent, "witness.json"),
    childTest = path.join(parent, "owner-killed.test.mjs"),
    fixtureModule = new URL("./daemon-autostart-cli.fixture.ts", import.meta.url).href,
    ownerPreload = new URL("../../../tools/node-test-daemon-owner.mjs", import.meta.url).href;
  let fixture: { parent: string; root: string; userRoot: string; pid: number } | undefined;
  try {
    writeFileSync(
      childTest,
      `import test from "node:test";
import { writeFileSync } from "node:fs";
import { setup, run, readDaemonPid } from ${JSON.stringify(fixtureModule)};
test("daemon owner", () => {
  const fixture = setup();
  run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]);
  writeFileSync(${JSON.stringify(witness)}, JSON.stringify({ ...fixture, pid: readDaemonPid(fixture.userRoot, "default") }));
  process.kill(process.pid, "SIGKILL");
});
`,
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [`--import=${ownerPreload}`, "--test", childTest], {
      encoding: "utf8",
      env,
      timeout: childTestTimeoutMs,
    });
    assert.equal(existsSync(witness), true, `${child.stderr}\n${child.stdout}`);
    fixture = JSON.parse(readFileSync(witness, "utf8"));
    assert.ok(fixture);
    assert.equal(child.status, 1, `${child.stderr}\n${child.stdout}`);
    // The stop is requested within one liveness tick; the process then waits for the installation
    // probes its startup spawned, which on a loaded machine outlast the default two seconds.
    await waitForProcessExit(fixture.pid, 10_000);
    assert.equal(daemonProcessAlive(fixture.pid), false, `fixture daemon ${fixture.pid} outlived its killed owner`);
  } finally {
    if (fixture) {
      stop(fixture.root, fixture.userRoot);
      await waitForProcessExit(fixture.pid, cleanupExitTimeoutMs);
      removeTempRepository(fixture.parent);
    }
    removeTempRepository(parent);
  }
});

test("stopping a cold daemon leaves the user root untouched", () => {
  const fixture = setup(false);

  const stopped = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "daemon", "stop"], {
    encoding: "utf8",
    env: cliEnv(fixture.root, fixture.userRoot),
  });
  assert.notEqual(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
  const receipt = JSON.parse(stopped.stdout) as { error?: { code?: string } };
  assert.equal(receipt.error?.code, "daemon_unavailable");
  assert.equal(existsSync(fixture.userRoot), false, "a cold stop must not create daemon state");
});

const operatorStopAutostartTest = async (context: TestContext) => {
  const fixture = setup();

  assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
  register(fixture.root, fixture.userRoot, "autostart");
  const status = run(fixture.root, fixture.userRoot, ["daemon", "status"]);
  assert.equal(status.entry, "dist");
  const buildCommit = (status.build as { readonly commit?: unknown }).commit;
  const gitCommitResult = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
  const expectedBuildCommit = gitCommitResult.status === 0 ? gitCommitResult.stdout.trim() : null;
  if (expectedBuildCommit !== null) {
    assert.match(expectedBuildCommit, /^[0-9a-f]{40}$/u);
    assert.equal(buildCommit, expectedBuildCommit);
    assert.match(String(status.summary), /entry=dist commit=[0-9a-f]{40}/u);
  } else assert.equal(buildCommit, null, "an isolated source archive has no Git identity to report");
  assert.deepEqual(status.target, {
    endpoint: localUserDaemonEndpoint(fixture.userRoot, "default"),
    daemonId: "default",
    userRoot: fixture.userRoot,
    repoId: "autostart",
    canonicalRoot: realpathSync.native(fixture.root),
  });
  for (const value of Object.values(status.target as Record<string, unknown>))
    assert.match(String(status.summary), new RegExp(escapeRegExp(String(value)), "u"));
  assert.equal(
    run(fixture.root, fixture.userRoot, ["task", "create", "--id", "task-autostart", "--admin", "--title", "Auto"])
      .outcome,
    "applied",
  );
  const previousPid = readDaemonPid(fixture.userRoot, "default");
  assert.ok(previousPid);
  // The autostart seam probes first: a live daemon is reused, never respawned.
  assert.equal(run(fixture.root, fixture.userRoot, ["task", "list"]).outcome, "applied");
  assert.equal(
    readDaemonPid(fixture.userRoot, "default"),
    previousPid,
    "a reachable daemon must not be replaced by a second spawn",
  );
  assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "stop"]).ok, true);
  assert.equal(readDaemonPid(fixture.userRoot, "default"), null);
  await waitForDurableCondition(() => !processAlive(previousPid));
  assert.equal(
    existsSync(localUserDaemonEndpoint(fixture.userRoot, "default")),
    false,
    "stop receipt settles only after pid and socket are gone",
  );
  const lifecycle = readDaemonLifecycleRecords(fixture.userRoot, "default");
  const processStart = lifecycle.find((record) => record.event === "process_start");
  assert.equal(processStart?.entry, "dist");
  assert.equal(processStart?.commit, expectedBuildCommit);
  assert.equal(
    lifecycle.some((record) => record.event === "socket_bound"),
    true,
  );
  assert.equal(
    lifecycle.some((record) => record.event === "process_exit" && record.outcome === "stop_requested"),
    true,
  );
  const stoppedStatusRun = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "daemon", "status"], {
    encoding: "utf8",
    env: cliEnv(fixture.root, fixture.userRoot),
  });
  // Unavailable answers exit non-zero: the first-run lane polls this exit code to see the daemon gone.
  assert.notEqual(stoppedStatusRun.status, 0, `${stoppedStatusRun.stderr}\n${stoppedStatusRun.stdout}`);
  const stoppedStatus = JSON.parse(stoppedStatusRun.stdout) as Record<string, unknown>;
  assert.match(String(stoppedStatus.summary), /not running \(stopped by operator at \d{4}-\d{2}-\d{2}T/u);
  const worktree = path.join(fixture.root, ".worktrees", "task-list-feature");
  git(fixture.root, "worktree", "add", "--quiet", "--detach", worktree);
  const refused = spawnSync(process.execPath, [cli, "--root", worktree, "--json", "task", "list"], {
    encoding: "utf8",
    env: cliEnv(worktree, fixture.userRoot),
  });
  assert.notEqual(refused.status, 0, `${refused.stderr}\n${refused.stdout}`);
  const refusal = JSON.parse(refused.stdout) as { error?: { code?: string } };
  assert.equal(refusal.error?.code, "daemon_stopped_by_operator");
  assert.equal(readDaemonPid(fixture.userRoot, "default"), null, "the refused worktree must not claim the daemon");

  const blocked = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "task", "list"], {
    encoding: "utf8",
    env: cliEnv(fixture.root, fixture.userRoot),
  });
  assert.notEqual(blocked.status, 0, `${blocked.stderr}\n${blocked.stdout}`);
  const blockedReceipt = JSON.parse(blocked.stdout) as {
    error?: { code?: string };
    diagnostic?: { expectation?: string };
  };
  assert.equal(blockedReceipt.error?.code, "daemon_stopped_by_operator");
  assert.match(String(blockedReceipt.diagnostic?.expectation), /ha daemon start --service/u);
  assert.equal(readDaemonPid(fixture.userRoot, "default"), null, "operator stop must suppress autostart");

  assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
  const result = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "task", "list"], {
    encoding: "utf8",
    env: cliEnv(fixture.root, fixture.userRoot),
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const receipt = JSON.parse(result.stdout) as { ok: boolean; outcome?: string };
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.outcome, "applied");
  const restartedPid = readDaemonPid(fixture.userRoot, "default");
  assert.ok(restartedPid, "explicit start must leave a resident daemon pid file");
  assert.notEqual(restartedPid, previousPid);
  const connected = spawnSync(process.execPath, [cli, "--root", worktree, "--json", "task", "list"], {
    encoding: "utf8",
    env: cliEnv(worktree, fixture.userRoot),
  });
  assert.equal(connected.status, 0, `${connected.stderr}\n${connected.stdout}`);
  assert.equal(readDaemonPid(fixture.userRoot, "default"), restartedPid, "the worktree must reuse the resident daemon");
  context.diagnostic(
    `stop refusal=${blockedReceipt.error?.code}; explicit-start pid=${restartedPid}; worktree existing-daemon task-list=ok`,
  );
  const restartedLifecycle = readDaemonLifecycleRecords(fixture.userRoot, "default"),
    generationStart = restartedLifecycle.findLastIndex((record) => record.event === "process_start"),
    bound = restartedLifecycle.findIndex((record, index) => index > generationStart && record.event === "socket_bound"),
    attach = restartedLifecycle.findIndex(
      (record, index) => index > generationStart && record.event === "repo_attach_started",
    );
  assert.ok(
    generationStart >= 0 && bound > generationStart && attach > bound,
    "the resident socket must bind before the cold registry starts attaching",
  );
  process.kill(restartedPid, "SIGKILL");
  await waitForProcessExit(restartedPid);
  const recovered = run(fixture.root, fixture.userRoot, ["task", "list"]);
  assert.equal(recovered.outcome, "applied");
  const recoveredPid = readDaemonPid(fixture.userRoot, "default");
  assert.ok(recoveredPid, "process death without daemon stop must remain autostartable");
  assert.notEqual(recoveredPid, restartedPid);
  context.diagnostic(`SIGKILL negative control autostart pid=${recoveredPid}`);
  assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "stop"]).ok, true);
};
test(
  "operator stop blocks autostart until explicit start while process death remains recoverable",
  { timeout: 60_000 },
  operatorStopAutostartTest,
);
