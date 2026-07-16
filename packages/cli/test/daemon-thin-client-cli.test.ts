// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { JsonRpcLineClient } from "../../daemon/src/index.ts";
import { readDaemonClientConfig } from "../src/daemon/client.ts";
import {
  defaultDaemonUserRoot,
  delay,
  runDaemonCommand,
  runRawJson,
  runRawJsonAsync,
  runRawJsonMaybeFail,
  sleep,
  stopDaemonQuietly,
  withTempRoot,
  withTempRootAsync
} from "./helpers/daemon-cli.ts";
import {
  forcedCommandRequest,
  receiptDataString,
  writeForcedCommandTeamRoster,
  writePeopleRoster
} from "./helpers/forced-command-daemon.ts";
import {
  closeServer,
  connectSocket,
  connectSocketWhenReady,
  listen,
  runDaemonCliProcess,
  spawnDaemonCli
} from "./helpers/daemon-transport.ts";
import {
  daemonStatusRepoIds,
  daemonStatusRepos,
  git,
  initGitRepo,
  isRecord,
  normalizeVolatileReceipt,
  readCliPackageVersion,
  receiptPath,
  waitForCondition
} from "./helpers/daemon-thin-client-fixtures.ts";

const expectedCliVersion = readCliPackageVersion();

test("daemon client defaults to local while preserving an explicit direct bootstrap mode", () => {
  assert.equal(readDaemonClientConfig({}).mode, "local");
  assert.equal(readDaemonClientConfig({ HARNESS_DAEMON_MODE: "direct" }).mode, "direct");
});

test("daemon connect relays opaque bytes without creating repository runtime state", { skip: process.platform === "win32" }, async () => {
  await withTempRootAsync(async (rootDir) => {
    const endpoint = path.join(rootDir, "relay.sock");
    const server = net.createServer((socket) => socket.pipe(socket));
    await listen(server, endpoint);
    try {
      const result = await runDaemonCliProcess(rootDir, ["daemon", "connect", "--stdio", "--socket", endpoint], "opaque request\nsecond frame\n");
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "opaque request\nsecond frame\n");
      assert.equal(existsSync(path.join(rootDir, "harness")), false);
    } finally {
      await closeServer(server);
    }
  });
});

test("daemon connect reaches the already-running daemon instance", async () => {
  await withTempRootAsync(async (rootDir) => {
    const startStatus = runDaemonCommand(rootDir, ["daemon", "start", "--service", "--json"]);
    const child = spawnDaemonCli(rootDir, ["daemon", "connect", "--stdio"]);
    const client = new JsonRpcLineClient(child.stdout, child.stdin, child);
    const hello = await client.request("protocol.hello", { protocolVersion: 1 });
    const status = await client.request("repo.daemon.status", { repo: { repoId: "canonical" } });
    client.close();

    assert.equal(hello.ok, true);
    const details = status.details as Record<string, unknown>;
    const data = details.data as Record<string, unknown>;
    const service = data.service as Record<string, unknown>;
    assert.equal(data.schema, "daemon-status/v2");
    assert.equal(service.daemonId, startStatus.daemonId);
    assert.equal(service.started, true);
  });
});

test("persistent daemon connection prevents idle exit after a command settles", async () => {
  await withTempRootAsync(async (rootDir) => {
    const userRoot = defaultDaemonUserRoot(rootDir);
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct", HARNESS_DAEMON_USER_ROOT: userRoot });
    const endpoint = path.join(rootDir, "idle-connection.sock");
    const daemon = spawnDaemonCli(rootDir, ["daemon", "serve", "--socket", endpoint, "--idle-ms", "500"]);
    const socket = await connectSocketWhenReady(endpoint);
    const client = new JsonRpcLineClient(socket, socket);
    try {
      await client.request("protocol.hello", { protocolVersion: 1 });
      const command = await client.request("repo.command.run", {
        repo: { repoId: "canonical" },
        payload: { command: { rootDir, json: true, action: { kind: "version" } } }
      });
      assert.equal(command.ok, true, JSON.stringify(command));

      await delay(700);
      const status = await client.request("repo.daemon.status", { repo: { repoId: "canonical" } });
      assert.equal(status.ok, true, JSON.stringify(status));
      const data = (status.details as Record<string, unknown>).data as Record<string, unknown>;
      assert.equal(data.schema, "daemon-status/v2");
      assert.equal((data.service as Record<string, unknown>).started, true);
      const probe = await connectSocket(endpoint);
      probe.destroy();
    } finally {
      client.close();
      socket.destroy();
      daemon.kill("SIGTERM");
      stopDaemonQuietly(rootDir, userRoot);
    }
  });
});

test("daemon connect fails closed with startup instructions when no persistent daemon exists", async () => {
  await withTempRootAsync(async (rootDir) => {
    const endpoint = process.platform === "win32"
      ? `\\\\.\\pipe\\ha-connect-missing-${process.pid}-${Date.now()}`
      : path.join(rootDir, "missing.sock");
    const result = await runDaemonCliProcess(rootDir, ["daemon", "connect", "--stdio", "--socket", endpoint]);

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /No persistent daemon is listening/iu);
    assert.match(result.stderr, /ha daemon start --service/iu);
    assert.equal(existsSync(path.join(rootDir, "harness")), false);
  });
});

test("forced-command relay attributes two shared-account members without collapsing principal or executor", async () => {
  await withTempRootAsync(async (rootDir) => {
    const userRoot = defaultDaemonUserRoot(rootDir);
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct", HARNESS_DAEMON_USER_ROOT: userRoot });
    const aliceTask = runRawJson(rootDir, ["new-task", "--title", "Alice Forced Principal"], {
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
    const bobTask = runRawJson(rootDir, ["new-task", "--title", "Bob Forced Principal"], {
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
    writeForcedCommandTeamRoster(rootDir);

    try {
      runDaemonCommand(rootDir, ["daemon", "start", "--service", "--json"], { HARNESS_DAEMON_USER_ROOT: userRoot });
      const [alice, bob] = await Promise.all([
        forcedCommandRequest(rootDir, userRoot, "person_alice", "repo.task.claim", {
          repo: { repoId: "canonical", canonicalRoot: rootDir },
          payload: { taskId: receiptDataString(aliceTask, "taskId"), executor: { kind: "agent", id: "codex-alice" } }
        }),
        forcedCommandRequest(rootDir, userRoot, "person_bob", "repo.task.claim", {
          repo: { repoId: "canonical", canonicalRoot: rootDir },
          payload: { taskId: receiptDataString(bobTask, "taskId"), executor: { kind: "agent", id: "codex-bob" } }
        })
      ]);

      assert.equal(alice.ok, true, JSON.stringify(alice));
      assert.equal(bob.ok, true, JSON.stringify(bob));
      const aliceHolder = (((alice.details as Record<string, unknown>).data as Record<string, unknown>).effectiveHolder as Record<string, unknown>);
      const bobHolder = (((bob.details as Record<string, unknown>).data as Record<string, unknown>).effectiveHolder as Record<string, unknown>);
      assert.equal((aliceHolder.principal as { personId?: string }).personId, "person_alice");
      assert.deepEqual(aliceHolder.executor, { kind: "agent", id: "codex-alice" });
      assert.equal((bobHolder.principal as { personId?: string }).personId, "person_bob");
      assert.deepEqual(bobHolder.executor, { kind: "agent", id: "codex-bob" });

      const wrongRoot = await forcedCommandRequest(rootDir, userRoot, "person_alice", "repo.task.holder", {
        repo: { repoId: "canonical", canonicalRoot: path.join(rootDir, "client-selected-root") },
        payload: { taskId: receiptDataString(aliceTask, "taskId") }
      });
      assert.equal(wrongRoot.ok, false);
      assert.equal((wrongRoot.error as { code?: string }).code, "forced_command_root_mismatch");
    } finally {
      stopDaemonQuietly(rootDir, userRoot);
    }
  });
});

test("local repo mode ignores a forced-command personId and keeps the socket-owner principal", async () => {
  await withTempRootAsync(async (rootDir) => {
    const userRoot = defaultDaemonUserRoot(rootDir);
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct", HARNESS_DAEMON_USER_ROOT: userRoot });
    const task = runRawJson(rootDir, ["new-task", "--title", "Local Forced Frame Rejected"], {
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
    writeForcedCommandTeamRoster(rootDir);
    const configPath = path.join(rootDir, "harness/harness.yaml");
    writeFileSync(configPath, readFileSync(configPath, "utf8").replace("mode: remote", "mode: local"), "utf8");
    git(path.join(rootDir, "harness"), "add", "harness.yaml");
    git(path.join(rootDir, "harness"), "commit", "-m", "test: select local identity mode");

    try {
      runDaemonCommand(rootDir, ["daemon", "start", "--service", "--json"], { HARNESS_DAEMON_USER_ROOT: userRoot });
      const claimed = await forcedCommandRequest(rootDir, userRoot, "person_bob", "repo.task.claim", {
        repo: { repoId: "canonical", canonicalRoot: rootDir },
        payload: { taskId: receiptDataString(task, "taskId"), executor: { kind: "agent", id: "spoof-client" } }
      });

      assert.equal(claimed.ok, true, JSON.stringify(claimed));
      const holder = (((claimed.details as Record<string, unknown>).data as Record<string, unknown>).effectiveHolder as Record<string, unknown>);
      assert.equal((holder.principal as { personId?: string }).personId, "person_alice");
      assert.deepEqual(holder.executor, { kind: "agent", id: "spoof-client" });
    } finally {
      stopDaemonQuietly(rootDir, userRoot);
    }
  });
});

test("daemon serve --stdio is rejected before runtime attachment", async () => {
  await withTempRootAsync(async (rootDir) => {
    const result = await runDaemonCliProcess(rootDir, ["daemon", "serve", "--stdio"]);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /daemon connect --stdio/iu);
    assert.equal(existsSync(path.join(rootDir, "harness")), false);
  });
});

test("daemon client mode preserves command receipt output shape against direct mode", () => {
  withTempRoot((rootDir) => {
    const direct = normalizeVolatileReceipt(runRawJson(rootDir, ["version"], { HARNESS_DAEMON_MODE: "direct" }));
    const daemon = normalizeVolatileReceipt(runRawJson(rootDir, ["version"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "250" }));

    assert.deepEqual(daemon, direct);
  });
});

test("daemon client auto-starts, durably writes, and exits after idle", () => {
  withTempRoot((rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct" });
    writePeopleRoster(rootDir, {
      personId: "person_auto",
      displayName: "Auto User",
      email: "auto@example.test",
      role: "owner"
    });
    const created = runRawJson(rootDir, ["new-task", "--title", "Daemon Client Write"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "250" });

    assert.equal(created.ok, true);
    assert.equal(created.schema, "command-receipt/v2");
    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/watermark.json")), true);
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8"), /write-watermark\/v1/u);

    sleep(700);
    const status = runDaemonCommand(rootDir, ["daemon", "status", "--json"]);
    assert.equal(status.started, false);
  });
});

test("daemon client applies command-level RBAC to inner CLI commands", () => {
  withTempRoot((rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct" });
    writePeopleRoster(rootDir, {
      personId: "person_maint",
      displayName: "Maintainer User",
      email: "maintainer@example.test",
      role: "maintainer"
    });

    const read = runRawJson(rootDir, ["version"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "250" });
    assert.equal(read.ok, true);

    const write = runRawJson(rootDir, ["new-task", "--title", "Maintainer Daemon Write"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_IDLE_MS: "250"
    });
    assert.equal(write.ok, true);

    const arbiter = runRawJsonMaybeFail(rootDir, ["decision", "accept", "dec_missing", "--judgment-only", "manual arbiter probe"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_IDLE_MS: "250"
    });
    assert.notEqual(arbiter.status, 0);
    assert.equal(arbiter.receipt.ok, false);
    assert.deepEqual((arbiter.receipt.error as { code?: string }).code, "rbac_forbidden");
    assert.equal(((arbiter.receipt.details as Record<string, unknown>).actor as { personId?: string }).personId, "person_maint");
    assert.equal((arbiter.receipt.details as Record<string, unknown>).commandClass, "arbiter");
  });
});

test("daemon client writes git commits with the resolved actor author", () => {
  withTempRoot((rootDir) => {
    initGitRepo(rootDir);
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct" });
    writePeopleRoster(rootDir, {
      personId: "person_owner",
      displayName: "Owner User",
      email: "owner@example.test",
      role: "owner"
    });

    const receipt = runRawJson(rootDir, ["new-task", "--title", "Owner Author Attribution"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_IDLE_MS: "250"
    });

    assert.equal(receipt.ok, true);
    assert.equal(((receipt.details as Record<string, unknown>).actor as { personId?: string }).personId, "person_owner");
    assert.equal(git(path.join(rootDir, "harness"), "log", "-1", "--pretty=format:%an <%ae>"), "Owner User <owner@example.test>");
  });
});

test("concurrent daemon client startup converges on one lock owner and both clients continue", async () => {
  await withTempRootAsync(async (rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct" });

    const [left, right] = await Promise.all([
      runRawJsonAsync(rootDir, ["task", "list"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "10000" }),
      runRawJsonAsync(rootDir, ["task", "list"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "10000" })
    ]);

    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    const status = runDaemonCommand(rootDir, ["daemon", "status", "--json"]);
    assert.equal(status.started, true);
    assert.equal(typeof status.pid, "number");
  });
});

test("concurrent daemon client writes serialize into linear git history", async () => {
  await withTempRootAsync(async (rootDir) => {
    initGitRepo(rootDir);
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct" });
    writePeopleRoster(rootDir, {
      personId: "person_concurrent",
      displayName: "Concurrent User",
      email: "concurrent@example.test",
      role: "owner"
    });
    const harnessRoot = path.join(rootDir, "harness");
    const beforeHead = git(harnessRoot, "rev-parse", "HEAD");

    const [left, right] = await Promise.all([
      runRawJsonAsync(rootDir, ["new-task", "--title", "Concurrent Daemon Write Left"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "1500" }),
      runRawJsonAsync(rootDir, ["new-task", "--title", "Concurrent Daemon Write Right"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "1500" })
    ]);

    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    const leftPackagePath = receiptPath(left, "package");
    const rightPackagePath = receiptPath(right, "package");
    const taskIndexPaths = [leftPackagePath, rightPackagePath].map((packagePath) => {
      const taskPath = path.relative(harnessRoot, path.resolve(rootDir, packagePath)).split(path.sep).join("/");
      return `${taskPath}/INDEX.md`;
    });
    assert.equal(new Set(taskIndexPaths).size, 2);
    for (const taskIndexPath of taskIndexPaths) {
      assert.doesNotThrow(() => git(harnessRoot, "cat-file", "-e", `HEAD:${taskIndexPath}`));
      assert.equal(Number(git(harnessRoot, "rev-list", "--count", `${beforeHead}..HEAD`, "--", taskIndexPath)), 1);
    }
    const parentCounts = git(harnessRoot, "log", "--format=%P", `${beforeHead}..HEAD`)
      .split(/\r?\n/u)
      .map((line) => line.trim().length === 0 ? 0 : line.trim().split(/\s+/u).length);
    assert.equal(parentCounts.every((count) => count <= 1), true);
    assert.equal(git(harnessRoot, "status", "--short"), "");
  });
});

test("daemon start service status and stop expose productized status contract", async () => {
  await withTempRootAsync(async (rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct" });
    try {
      const start = runDaemonCommand(rootDir, ["daemon", "start", "--service", "--json"]);
      assert.equal(start.started, true);
      assert.equal(start.mode, "service");
      assert.equal(start.version, expectedCliVersion);
      assert.equal(typeof start.queueDepth, "number");

      let status = runDaemonCommand(rootDir, ["daemon", "status", "--json"]);
      await waitForCondition(() => {
        status = runDaemonCommand(rootDir, ["daemon", "status", "--json"]);
        return status.lastReconcileAt !== null
          && (status.repos as Array<{ repoId?: string; state?: string }>)[0]?.state === "attached";
      });
      assert.equal(status.started, true);
      assert.equal(status.reachable, true);
      assert.equal(typeof status.pid, "number");
      assert.equal(status.version, expectedCliVersion);
      assert.equal(status.protocolVersion, 1);
      assert.equal(typeof status.queueDepth, "number");
      assert.equal(isRecord(status.queue), true);
      assert.equal(isRecord(status.connections), true);
      assert.equal(Array.isArray(status.repos), true);
      assert.equal((status.repos as Array<{ repoId?: string; state?: string }>)[0]?.repoId, "canonical");
      assert.equal((status.repos as Array<{ repoId?: string; state?: string }>)[0]?.state, "attached");

      const stop = runDaemonCommand(rootDir, ["daemon", "stop", "--timeout-ms", "5000", "--json"]);
      assert.equal(stop.pid, status.pid);
      assert.equal(stop.signaled, true);
      assert.equal(stop.drained, true);
      assert.equal(stop.stopped, true);
    } finally {
      try {
        runDaemonCommand(rootDir, ["daemon", "stop", "--timeout-ms", "1000", "--json"]);
      } catch {
        // best-effort cleanup for failed assertions
      }
    }
  });
});

test("daemon install-templates distributes three platform service templates", () => {
  withTempRoot((rootDir) => {
    const outDir = path.join(rootDir, "templates");
    const result = runDaemonCommand(rootDir, ["daemon", "install-templates", "--out", outDir, "--json"]);
    assert.equal(result.ok, true);
    assert.equal(existsSync(path.join(outDir, "harness-anything-daemon.service")), true);
    assert.equal(existsSync(path.join(outDir, "com.harness-anything.daemon.plist")), true);
    assert.equal(existsSync(path.join(outDir, "install-harness-anything-daemon.ps1")), true);
  });
});

test("daemon bootstrap-server is idempotent and installs roster hooks and read-only mirror", () => {
  withTempRoot((rootDir) => {
    const canonicalRoot = path.join(rootDir, "canonical");
    const mirrorRoot = path.join(rootDir, "readonly.git");
    const reportPath = path.join(rootDir, "bootstrap-report.json");
    const args = [
      "daemon",
      "bootstrap-server",
      "--canonical-root",
      canonicalRoot,
      "--ssh-host",
      "team-host",
      "--ssh-user",
      "alice",
      "--person-id",
      "person_alice",
      "--display-name",
      "Alice Admin",
      "--email",
      "alice@example.com",
      "--readonly-mirror",
      mirrorRoot,
      "--report",
      reportPath,
      "--skip-ssh-check",
      "--no-start",
      "--json"
    ];
    const first = runDaemonCommand(rootDir, args);
    const second = runDaemonCommand(rootDir, args);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(existsSync(path.join(canonicalRoot, "harness/people.yaml")), true);
    assert.match(readFileSync(path.join(canonicalRoot, "harness/people.yaml"), "utf8"), /person_alice/u);
    assert.match(readFileSync(path.join(canonicalRoot, "harness/people.yaml"), "utf8"), /ssh-forced-command-person/u);
    assert.equal(existsSync(path.join(canonicalRoot, ".git/hooks/pre-receive")), true);
    assert.equal(existsSync(path.join(mirrorRoot, "hooks/pre-receive")), true);
    assert.equal(existsSync(reportPath), true);
    assert.equal(first.registry && typeof first.registry === "object" && (first.registry as { repoId?: string }).repoId, "canonical");
    assert.equal(existsSync(path.join(defaultDaemonUserRoot(rootDir), "registry.json")), true);

    const canonicalHook = spawnSync(path.join(canonicalRoot, ".git/hooks/pre-receive"), {
      cwd: canonicalRoot,
      encoding: "utf8"
    });
    assert.notEqual(canonicalHook.status, 0);
    assert.match(canonicalHook.stderr, /rejected this direct push/u);

    const mirrorHook = spawnSync(path.join(mirrorRoot, "hooks/pre-receive"), {
      cwd: mirrorRoot,
      encoding: "utf8"
    });
    assert.notEqual(mirrorHook.status, 0);
    assert.match(mirrorHook.stderr, /read-only mirror/u);
  });
});

test("daemon client auto-registers initialized single repo on first local command", () => {
  withTempRoot((rootDir) => {
    const userRoot = path.join(rootDir, "user-daemon");
    try {
      runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct", HARNESS_DAEMON_USER_ROOT: userRoot });

      const listed = runRawJson(rootDir, ["task", "list"], {
        HARNESS_DAEMON_MODE: "local",
        HARNESS_DAEMON_USER_ROOT: userRoot,
        HARNESS_DAEMON_IDLE_MS: "60000"
      });

      assert.equal(listed.ok, true);
      const registry = JSON.parse(readFileSync(path.join(userRoot, "registry.json"), "utf8")) as { repos: Array<{ repoId: string; canonicalRoot: string; state: string }> };
      assert.deepEqual(registry.repos.map((repo) => [repo.repoId, repo.canonicalRoot, repo.state]), [["canonical", realpathSync.native(rootDir), "enabled"]]);

      const status = runDaemonCommand(rootDir, ["daemon", "status", "--user-root", userRoot, "--json"], { HARNESS_DAEMON_USER_ROOT: userRoot });
      assert.equal(status.started, true);
      assert.equal(status.repoId, "canonical");
      assert.equal(status.rootDir, realpathSync.native(rootDir));
    } finally {
      stopDaemonQuietly(rootDir, userRoot);
    }
  });
});

test("daemon client resolves an existing single-repo registry without requiring repo input", () => {
  withTempRoot((rootDir) => {
    const userRoot = path.join(rootDir, "user-daemon");
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct", HARNESS_DAEMON_USER_ROOT: userRoot });
    writePeopleRoster(rootDir, {
      personId: "person_registered",
      displayName: "Registered User",
      email: "registered@example.test",
      role: "owner"
    }, { userRoot });
    const registered = runDaemonCommand(rootDir, ["daemon", "repo", "register", "--repo-id", "canonical", "--user-root", userRoot, "--no-link", "--json"], {
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
    assert.equal(registered.ok, true);

    const created = runRawJson(rootDir, ["new-task", "--title", "Registered Single Repo"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_USER_ROOT: userRoot,
      HARNESS_DAEMON_IDLE_MS: "250"
    });

    assert.equal(created.ok, true);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks")), true);
  });
});

test("daemon client fails unregistered cwd in multi-repo registry with register hint", () => {
  withTempRoot((workspaceRoot) => {
    const userRoot = path.join(workspaceRoot, "user-daemon");
    const alphaRoot = path.join(workspaceRoot, "alpha");
    const betaRoot = path.join(workspaceRoot, "beta");
    const outsiderRoot = path.join(workspaceRoot, "outsider");
    for (const rootDir of [alphaRoot, betaRoot, outsiderRoot]) {
      mkdirSync(rootDir, { recursive: true });
      runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct", HARNESS_DAEMON_USER_ROOT: userRoot });
    }
    runDaemonCommand(alphaRoot, ["daemon", "repo", "register", "--repo-id", "alpha", "--root", alphaRoot, "--user-root", userRoot, "--no-link", "--json"], {
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
    runDaemonCommand(betaRoot, ["daemon", "repo", "register", "--repo-id", "beta", "--root", betaRoot, "--user-root", userRoot, "--no-link", "--json"], {
      HARNESS_DAEMON_USER_ROOT: userRoot
    });

    const failed = runRawJsonMaybeFail(outsiderRoot, ["task", "list"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_USER_ROOT: userRoot
    });

    assert.notEqual(failed.status, 0);
    assert.equal(failed.receipt.ok, false);
    assert.match(((failed.receipt.error as Record<string, unknown>).hint as string), /ha daemon repo register --repo-id <id> --root/u);
  });
});

test("daemon client --repo override targets a registered repo from a different cwd", () => {
  withTempRoot((workspaceRoot) => {
    const userRoot = path.join(workspaceRoot, "user-daemon");
    const alphaRoot = path.join(workspaceRoot, "alpha");
    const betaRoot = path.join(workspaceRoot, "beta");
    try {
      for (const rootDir of [alphaRoot, betaRoot]) {
        mkdirSync(rootDir, { recursive: true });
        runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct", HARNESS_DAEMON_USER_ROOT: userRoot });
      }
      runDaemonCommand(alphaRoot, ["daemon", "repo", "register", "--repo-id", "alpha", "--root", alphaRoot, "--user-root", userRoot, "--no-link", "--json"], {
        HARNESS_DAEMON_USER_ROOT: userRoot
      });
      runDaemonCommand(betaRoot, ["daemon", "repo", "register", "--repo-id", "beta", "--root", betaRoot, "--user-root", userRoot, "--no-link", "--json"], {
        HARNESS_DAEMON_USER_ROOT: userRoot
      });

      const listed = runRawJson(betaRoot, ["--repo", "alpha", "task", "list"], {
        HARNESS_DAEMON_MODE: "local",
        HARNESS_DAEMON_USER_ROOT: userRoot,
        HARNESS_DAEMON_IDLE_MS: "60000"
      });
      assert.equal(listed.ok, true);

      const status = runDaemonCommand(betaRoot, ["--repo", "alpha", "daemon", "status", "--user-root", userRoot, "--json"], {
        HARNESS_DAEMON_USER_ROOT: userRoot
      });
      assert.equal(status.repoId, "alpha");
      assert.equal(status.rootDir, realpathSync.native(alphaRoot));
      assert.deepEqual((status.repos as Array<{ repoId: string }>).map((repo) => repo.repoId), ["alpha", "beta"]);
    } finally {
      stopDaemonQuietly(betaRoot, userRoot);
    }
  });
});

test("daemon service reconciles registry register and unregister changes", async () => {
  await withTempRootAsync(async (workspaceRoot) => {
    const userRoot = path.join(workspaceRoot, "user-daemon");
    const alphaRoot = path.join(workspaceRoot, "alpha");
    const betaRoot = path.join(workspaceRoot, "beta");
    for (const rootDir of [alphaRoot, betaRoot]) {
      mkdirSync(rootDir, { recursive: true });
      runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct", HARNESS_DAEMON_USER_ROOT: userRoot });
    }
    runDaemonCommand(alphaRoot, ["daemon", "repo", "register", "--repo-id", "alpha", "--root", alphaRoot, "--user-root", userRoot, "--no-link", "--json"], {
      HARNESS_DAEMON_USER_ROOT: userRoot
    });

    const listed = runRawJson(alphaRoot, ["task", "list"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_USER_ROOT: userRoot,
      HARNESS_DAEMON_IDLE_MS: "15000"
    });
    assert.equal(listed.ok, true);
    assert.deepEqual(daemonStatusRepoIds(alphaRoot, userRoot, "alpha"), ["alpha"]);

    runDaemonCommand(betaRoot, ["daemon", "repo", "register", "--repo-id", "beta", "--root", betaRoot, "--user-root", userRoot, "--no-link", "--json"], {
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
    await waitForCondition(() => daemonStatusRepoIds(alphaRoot, userRoot, "alpha").includes("beta"));

    runDaemonCommand(betaRoot, ["daemon", "repo", "unregister", "--repo-id", "beta", "--user-root", userRoot, "--no-link", "--json"], {
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
    await waitForCondition(() => daemonStatusRepos(alphaRoot, userRoot, "alpha").find((repo) => repo.repoId === "beta")?.state === "detached");
  });
});

test("daemon repo commands register list and unregister the user-level registry", () => {
  withTempRoot((rootDir) => {
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness", "harness.yaml"), "schema: harness-anything/v1\n", "utf8");
    const userRoot = path.join(rootDir, "user-harness");

    const register = runDaemonCommand(rootDir, [
      "daemon",
      "repo",
      "register",
      "--repo-id",
      "canonical",
      "--display-name",
      "Canonical",
      "--user-root",
      userRoot,
      "--no-link",
      "--json"
    ]);
    assert.equal(register.ok, true);
    assert.equal((register.repo as { repoId?: string }).repoId, "canonical");
    assert.equal((register.repo as { state?: string }).state, "enabled");

    const list = runDaemonCommand(rootDir, ["daemon", "repo", "list", "--user-root", userRoot, "--json"]);
    assert.equal(list.ok, true);
    assert.equal(list.count, 1);
    assert.deepEqual((list.repos as Array<{ repoId: string; state: string }>).map((repo) => [repo.repoId, repo.state]), [["canonical", "enabled"]]);

    const unregister = runDaemonCommand(rootDir, ["daemon", "repo", "unregister", "--repo-id", "canonical", "--user-root", userRoot, "--no-link", "--json"]);
    assert.equal(unregister.ok, true);
    assert.equal((unregister.repo as { state?: string }).state, "disabled");
  });
});
