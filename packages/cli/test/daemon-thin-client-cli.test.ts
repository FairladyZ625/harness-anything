// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { JsonRpcLineClient } from "../../daemon/src/index.ts";
import { readDaemonClientConfig } from "../src/daemon/client.ts";
import {
  defaultDaemonUserRoot,
  pollUntil,
  runDaemonCommand,
  runRawJson,
  runRawJsonAsync,
  runRawJsonMaybeFail,
  stopDaemon,
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
  spawnDaemonCli,
  stopSpawnedDaemon
} from "./helpers/daemon-transport.ts";
import {
  git,
  gitObjectExists,
  initGitRepo,
  isRecord,
  normalizeVolatileReceipt,
  readCliPackageVersion,
  receiptPath
} from "./helpers/daemon-thin-client-fixtures.ts";

const expectedCliVersion = readCliPackageVersion();

test("daemon client defaults to the local daemon", () => {
  assert.equal(readDaemonClientConfig({}).mode, "local");
});

function connectionCount(receipt: Record<string, unknown>): number | undefined {
  const details = receipt.details as Record<string, unknown> | undefined;
  const data = details?.data as Record<string, unknown> | undefined;
  const connections = data?.connections as Record<string, unknown> | undefined;
  return typeof connections?.active === "number" ? connections.active : undefined;
}

function waitForChildOutput(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`child output timed out: ${stdout}\n${stderr}`)), 5_000);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (!stdout.includes(expected)) return;
      clearTimeout(timer);
      resolve();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("exit", (code, signal) => {
      if (stdout.includes(expected)) return;
      clearTimeout(timer);
      reject(new Error(`child exited before ready: ${JSON.stringify({ code, signal, stdout, stderr })}`));
    });
  });
}

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

test("daemon logs reads the shared typed operational page through the daemon route", async () => {
  await withTempRootAsync(async (rootDir) => {
    const userRoot = defaultDaemonUserRoot(rootDir);
    try {
      runDaemonCommand(rootDir, ["daemon", "start", "--service", "--json"], { HARNESS_DAEMON_USER_ROOT: userRoot });
      const result = runDaemonCommand(rootDir, ["daemon", "logs", "--limit", "25", "--levels", "info,error", "--json"], {
        HARNESS_DAEMON_USER_ROOT: userRoot
      });
      const page = result.page as {
        readonly schema?: string;
        readonly entries?: ReadonlyArray<{ readonly schema?: string; readonly repoId?: string; readonly redaction?: { readonly policy?: string } }>;
      };
      assert.equal(page.schema, "daemon-log-page/v1");
      assert.equal((page.entries?.length ?? 0) > 0, true);
      assert.equal(page.entries?.every((entry) => entry.schema === "daemon-log-entry/v1"), true);
      assert.equal(page.entries?.every((entry) => entry.repoId === "canonical"), true);
      assert.equal(page.entries?.every((entry) => entry.redaction?.policy === "runtime-log-redaction/v1"), true);
    } finally {
      await stopDaemon(rootDir, userRoot);
    }
  });
});

test("persistent daemon connection prevents idle exit after a command settles", async () => {
  await withTempRootAsync(async (rootDir) => {
    const userRoot = defaultDaemonUserRoot(rootDir);
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture", HARNESS_DAEMON_USER_ROOT: userRoot });
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

      const idleDeadline = Date.now() + 700;
      await pollUntil(
        () => Date.now(),
        (now) => now >= idleDeadline,
        (candidate, error) => JSON.stringify({ candidate, error: String(error ?? "") }),
        { timeoutMs: 2_000 }
      );
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
      await stopSpawnedDaemon(daemon, endpoint);
      await stopDaemon(rootDir, userRoot);
    }
  });
});

test("SIGKILL of a GUI notification holder closes its socket and restores daemon idle exit", {
  skip: process.platform === "win32" ? "SIGKILL is unavailable on Windows" : false
}, async () => {
  await withTempRootAsync(async (rootDir) => {
    const userRoot = defaultDaemonUserRoot(rootDir);
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture", HARNESS_DAEMON_USER_ROOT: userRoot });
    const endpoint = path.join(rootDir, "gui-kill-idle.sock");
    const daemon = spawnDaemonCli(rootDir, ["daemon", "serve", "--socket", endpoint, "--idle-ms", "1000"]);
    // Open the status connection before the holder starts and keep it open. The
    // daemon arms its idle timer the moment its last connection closes, so a
    // transient readiness probe would start the countdown and then race it
    // against the holder's boot (Node startup plus TypeScript module load). On a
    // loaded machine the holder loses that race, the daemon exits, and the
    // holder's connect fails with ENOENT. Holding one connection open keeps the
    // idle timer disarmed until this test deliberately closes it below.
    const statusSocket = await connectSocketWhenReady(endpoint);
    const statusClient = new JsonRpcLineClient(statusSocket, statusSocket);
    await statusClient.request("protocol.hello", { protocolVersion: 1 });
    const clientModuleUrl = new URL("../../daemon-client/src/index.ts", import.meta.url).href;
    const holder = spawn(process.execPath, ["--input-type=module", "--eval", `
      import { JsonLineSocketTransport, PersistentDaemonClient } from ${JSON.stringify(clientModuleUrl)};
      const client = new PersistentDaemonClient({
        endpoint: process.argv[1],
        transport: new JsonLineSocketTransport(),
        requestTimeoutMs: 1000,
        onDiagnostic: (diagnostic) => console.error(diagnostic.message)
      });
      await client.subscribe("canonical");
      console.log("GUI_NOTIFICATION_SOCKET_READY");
      setInterval(() => undefined, 1000);
    `, endpoint], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      // The daemon's active-connection count is eventually consistent with the
      // holder's process state: the child announcing readiness (and later the
      // kernel tearing its socket down on SIGKILL) both reach the daemon as
      // events it processes on its own event loop. Asserting either count at a
      // single instant races that delivery, so poll for the expected count and
      // let the diagnostic report the last observed status on timeout.
      const observeConnectionCount = async (expected: number): Promise<unknown> =>
        pollUntil(
          () => statusClient.request("repo.daemon.status", { repo: { repoId: "canonical" } }),
          (status) => connectionCount(status) === expected,
          (candidate, error) => JSON.stringify({ expected, candidate, error: String(error ?? "") }),
          { timeoutMs: 5_000 }
        );

      await waitForChildOutput(holder, "GUI_NOTIFICATION_SOCKET_READY");
      await observeConnectionCount(2);

      assert.equal(holder.kill("SIGKILL"), true);
      await new Promise<void>((resolve) => holder.once("exit", () => resolve()));
      // This status probe is the only remaining connection. Once it closes,
      // the daemon's active count returns to zero and its idle timer starts.
      await observeConnectionCount(1);
      statusClient.close();
      statusSocket.destroy();

      await pollUntil(
        () => daemon.exitCode,
        (exitCode) => exitCode !== null,
        (candidate, error) => JSON.stringify({ candidate, error: String(error ?? "") }),
        { timeoutMs: 3_000 }
      );
      assert.equal(daemon.exitCode, 0);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
      if (!statusSocket.destroyed) {
        statusClient.close();
        statusSocket.destroy();
      }
      await stopSpawnedDaemon(daemon, endpoint);
      await stopDaemon(rootDir, userRoot);
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
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture", HARNESS_DAEMON_USER_ROOT: userRoot });
    const aliceTask = runRawJson(rootDir, ["new-task", "--title", "Alice Forced Principal"], {
      HARNESS_DAEMON_MODE: "fixture",
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
    const bobTask = runRawJson(rootDir, ["new-task", "--title", "Bob Forced Principal"], {
      HARNESS_DAEMON_MODE: "fixture",
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
      await stopDaemon(rootDir, userRoot);
    }
  });
});

test("local repo mode ignores a forced-command personId and keeps the socket-owner principal", async () => {
  await withTempRootAsync(async (rootDir) => {
    const userRoot = defaultDaemonUserRoot(rootDir);
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture", HARNESS_DAEMON_USER_ROOT: userRoot });
    const task = runRawJson(rootDir, ["new-task", "--title", "Local Forced Frame Rejected"], {
      HARNESS_DAEMON_MODE: "fixture",
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
      await stopDaemon(rootDir, userRoot);
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

test("daemon client mode preserves command receipt output shape against direct mode", async () => {
  await withTempRootAsync(async (rootDir) => {
    const direct = normalizeVolatileReceipt(runRawJson(rootDir, ["version"], { HARNESS_DAEMON_MODE: "fixture" }));
    const daemon = normalizeVolatileReceipt(await pollUntil(
      () => runRawJson(rootDir, ["version"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "250" }),
      (receipt) => receipt.ok === true,
      (receipt, error) => JSON.stringify({ receipt, error: error instanceof Error ? error.message : String(error ?? "") })
    ));

    assert.deepEqual(daemon, direct);
  });
});

test("daemon client auto-starts, durably writes, and exits after idle", async () => {
  await withTempRootAsync(async (rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture" });
    writePeopleRoster(rootDir, {
      personId: "person_auto",
      displayName: "Auto User",
      email: "auto@example.test",
      role: "owner"
    });
    const created = runRawJson(rootDir, ["new-task", "--title", "Daemon Client Write"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "250" });

    assert.equal(created.ok, true);
    assert.equal(created.schema, "command-receipt/v2");
    const watermarkPath = path.join(rootDir, ".harness/write-journal/watermark.json");
    const watermark = await pollUntil(
      () => existsSync(watermarkPath) ? readFileSync(watermarkPath, "utf8") : undefined,
      (candidate) => /write-watermark\/v1/u.test(candidate ?? ""),
      (candidate, error) => JSON.stringify({ watermarkPath, candidate, error: String(error ?? ""), created })
    );
    assert.match(watermark ?? "", /write-watermark\/v1/u);

    const status = await pollUntil(
      () => runDaemonCommand(rootDir, ["daemon", "status", "--json"]),
      (candidate) => candidate.started === false,
      (candidate, error) => JSON.stringify({ candidate, error: String(error ?? ""), created })
    );
    assert.equal(status.started, false);
  });
});

test("daemon client applies command-level RBAC to inner CLI commands", async () => {
  await withTempRootAsync(async (rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture" });
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

test("daemon client writes git commits with the resolved actor author", async () => {
  await withTempRootAsync(async (rootDir) => {
    initGitRepo(rootDir);
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture" });
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
    const author = await pollUntil(
      () => git(path.join(rootDir, "harness"), "log", "-1", "--pretty=format:%an <%ae>"),
      (candidate) => candidate === "Owner User <owner@example.test>",
      (candidate, error) => JSON.stringify({ candidate, error: String(error ?? ""), receipt })
    );
    assert.equal(author, "Owner User <owner@example.test>");
  });
});

test("concurrent daemon client startup converges on one lock owner and both clients continue", async () => {
  await withTempRootAsync(async (rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture" });

    const [left, right] = await Promise.all([
      runRawJsonAsync(rootDir, ["task", "list"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "10000" }),
      runRawJsonAsync(rootDir, ["task", "list"], { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_IDLE_MS: "10000" })
    ]);

    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    const status = await pollUntil(
      () => runDaemonCommand(rootDir, ["daemon", "status", "--json"]),
      (candidate) => candidate.started === true && typeof candidate.pid === "number",
      (candidate, error) => JSON.stringify({ candidate, error: String(error ?? ""), left, right })
    );
    assert.equal(status.started, true);
    assert.equal(typeof status.pid, "number");
  });
});

test("concurrent daemon client writes serialize into linear git history", async () => {
  await withTempRootAsync(async (rootDir) => {
    initGitRepo(rootDir);
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture" });
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
    await pollUntil(
      () => taskIndexPaths.map((taskIndexPath) => ({
        taskIndexPath,
        visible: gitObjectExists(harnessRoot, `HEAD:${taskIndexPath}`),
        commitCount: Number(git(harnessRoot, "rev-list", "--count", `${beforeHead}..HEAD`, "--", taskIndexPath))
      })),
      (entries) => entries.every((entry) => entry.visible && entry.commitCount === 1),
      (entries, error) => JSON.stringify({ entries, error: String(error ?? ""), left, right })
    );
    const parentCounts = git(harnessRoot, "log", "--format=%P", `${beforeHead}..HEAD`)
      .split(/\r?\n/u)
      .map((line) => line.trim().length === 0 ? 0 : line.trim().split(/\s+/u).length);
    assert.equal(parentCounts.every((count) => count <= 1), true);
    await pollUntil(
      () => git(harnessRoot, "status", "--short"),
      (status) => status === "",
      (status, error) => JSON.stringify({ status, error: String(error ?? ""), left, right })
    );
  });
});

test("daemon start service status and stop expose productized status contract", async () => {
  await withTempRootAsync(async (rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture" });
    try {
      const start = runDaemonCommand(rootDir, ["daemon", "start", "--service", "--json"]);
      assert.equal(start.started, true);
      assert.equal(start.mode, "service");
      assert.equal(start.version, expectedCliVersion);
      assert.equal(typeof start.queueDepth, "number");

      const status = await pollUntil(
        () => runDaemonCommand(rootDir, ["daemon", "status", "--json"]),
        (candidate) => candidate.lastReconcileAt !== null
          && (candidate.repos as Array<{ repoId?: string; state?: string }>)[0]?.state === "attached",
        (candidate, error) => JSON.stringify({ candidate, error: String(error ?? ""), start })
      );
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
      await stopDaemon(rootDir);
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

test("daemon client auto-registers initialized single repo on first local command", async () => {
  await withTempRootAsync(async (rootDir) => {
    const userRoot = path.join(rootDir, "user-daemon");
    try {
      runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture", HARNESS_DAEMON_USER_ROOT: userRoot });

      const listed = runRawJson(rootDir, ["task", "list"], {
        HARNESS_DAEMON_MODE: "local",
        HARNESS_DAEMON_USER_ROOT: userRoot,
        HARNESS_DAEMON_IDLE_MS: "60000"
      });

      assert.equal(listed.ok, true);
      const registryPath = path.join(userRoot, "registry.json");
      const registry = await pollUntil(
        () => existsSync(registryPath)
          ? JSON.parse(readFileSync(registryPath, "utf8")) as { repos: Array<{ repoId: string; canonicalRoot: string; state: string }> }
          : undefined,
        (candidate) => candidate?.repos.length === 1,
        (candidate, error) => JSON.stringify({ registryPath, candidate, error: String(error ?? ""), listed })
      );
      assert.deepEqual(registry.repos.map((repo) => [repo.repoId, repo.canonicalRoot, repo.state]), [["canonical", realpathSync.native(rootDir), "enabled"]]);

      const status = await pollUntil(
        () => runDaemonCommand(rootDir, ["daemon", "status", "--user-root", userRoot, "--json"], { HARNESS_DAEMON_USER_ROOT: userRoot }),
        (candidate) => candidate.started === true && candidate.repoId === "canonical",
        (candidate, error) => JSON.stringify({ candidate, error: String(error ?? ""), listed })
      );
      assert.equal(status.started, true);
      assert.equal(status.repoId, "canonical");
      assert.equal(status.rootDir, realpathSync.native(rootDir));
    } finally {
      await stopDaemon(rootDir, userRoot);
    }
  });
});

test("daemon client resolves an existing single-repo registry without requiring repo input", async () => {
  await withTempRootAsync(async (rootDir) => {
    const userRoot = path.join(rootDir, "user-daemon");
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture", HARNESS_DAEMON_USER_ROOT: userRoot });
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

    try {
      const created = runRawJson(rootDir, ["new-task", "--title", "Registered Single Repo"], {
        HARNESS_DAEMON_MODE: "local",
        HARNESS_DAEMON_USER_ROOT: userRoot,
        HARNESS_DAEMON_IDLE_MS: "250"
      });

      assert.equal(created.ok, true);
      await pollUntil(
        () => existsSync(path.join(rootDir, "harness/tasks")),
        Boolean,
        (visible, error) => JSON.stringify({ visible, error: String(error ?? ""), created })
      );
    } finally {
      await stopDaemon(rootDir, userRoot);
    }
  });
});
