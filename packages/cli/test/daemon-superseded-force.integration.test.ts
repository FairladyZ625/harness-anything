// harness-test-tier: integration
import { waitForArrival, watchDirectoryArrival } from "../../../tools/fixtures/event-arrival.ts";
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "@harness-anything/daemon/internal/client/local-daemon-target";
import { requestDaemonJsonRpcAt } from "@harness-anything/daemon/internal/client/local-json-rpc-client";
import { daemonSocketProbe, readDaemonPid } from "@harness-anything/daemon/internal/daemon-singleton";
import { type TestContext } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  assertValidWriteReceipt,
  cli,
  cliEnv,
  coded,
  connectSocket,
  currentDaemonProtocolVersion,
  JsonRpcLineClient,
  register,
  run as runAutostartCli,
  setup as setupAutostartFixture,
  waitForFileContent,
} from "./daemon-autostart-cli.fixture.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

test(
  "force stop can find a superseded daemon after its socket is released without killing the runtime",
  { skip: process.platform === "win32" ? "requires POSIX detached process-group semantics" : false, timeout: 30_000 },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-superseded-force-")),
      userRoot = path.join(parent, "user"),
      rootDir = path.join(parent, "repo"),
      runtimeFile = path.join(parent, "runtime/dist/daemon/src/runtime.js"),
      marker = path.join(parent, "runtime/dist/build-id.txt"),
      providerReady = path.join(parent, "provider-ready"),
      daemonId = "superseded-pid-holder";
    const waitFor = (predicate: () => boolean, _message?: string): Promise<void> =>
      waitForArrival(() => (predicate() ? true : null), watchDirectoryArrival(parent));
    mkdirSync(path.dirname(runtimeFile), { recursive: true });
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(runtimeFile, "// fixture\n");
    writeFileSync(marker, "build-a\n");
    const child = fork(
      new URL("../../daemon/test/fixtures/superseded-pid-holder.fixture.ts", import.meta.url),
      [userRoot, rootDir, runtimeFile, providerReady],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const exited = once(child, "exit");
    let workerPid = 0;
    try {
      const [ready] = (await once(child, "message")) as [{ ready: boolean; workerPid: number }];
      assert.equal(ready.ready, true);
      workerPid = ready.workerPid;
      await waitFor(() => existsSync(providerReady), "runtime provider did not start");
      const released = once(child, "message");
      writeFileSync(marker, "build-b\n");
      await requestDaemonJsonRpcAt(
        localUserDaemonEndpoint(userRoot, daemonId),
        "daemon.status",
        {},
        2000,
        2000,
        undefined,
        true,
      );
      assert.equal((await released)[0], "released");
      assert.equal(await daemonSocketProbe(localUserDaemonEndpoint(userRoot, daemonId)), false);
      assert.doesNotThrow(() => process.kill(child.pid!, 0), "the outgoing daemon must still be alive");
      assert.equal(readDaemonPid(userRoot, daemonId), child.pid, "the live outgoing process remains discoverable");
      const env = { ...process.env };
      delete env.HARNESS_ACTOR;
      delete env.HARNESS_EXECUTION_CREDENTIAL;
      const cli = spawn(
        process.execPath,
        [
          path.resolve("packages/cli/src/index.ts"),
          "daemon",
          "stop",
          "--force",
          "--json",
          "--user-root",
          userRoot,
          "--daemon-id",
          daemonId,
        ],
        { env },
      );
      let stdout = "";
      cli.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      const [code] = await once(cli, "close");
      assert.equal(code, 0, stdout);
      assert.equal(JSON.parse(stdout).forced, true);
      await exited;
      assert.doesNotThrow(() => process.kill(workerPid, 0), "runtime must survive daemon force stop");
    } finally {
      child.kill("SIGKILL");
      if (workerPid) killGroup(workerPid);
      await exited;
      removeTempRepository(parent);
    }
  },
);

const blockedVerticalScriptTest = async (context: TestContext) => {
  const fixture = setupAutostartFixture(),
    repoId = "vertical-wedge",
    taskId = "task-vertical-wedge",
    blocker = path.join(fixture.parent, "vertical-script.block"),
    started = `${blocker}.started`,
    endpoint = localUserDaemonEndpoint(fixture.userRoot, "default");
  let client: JsonRpcLineClient | undefined,
    readClient: JsonRpcLineClient | undefined,
    queuedClient: JsonRpcLineClient | undefined,
    scriptRequest: Promise<Record<string, unknown>> | undefined,
    queuedWrite: Promise<Record<string, unknown>> | undefined;
  try {
    writeFileSync(blocker, "blocked\n", "utf8");
    const launched = spawnSync(
      process.execPath,
      [cli, "--root", fixture.root, "--json", "daemon", "start", "--service"],
      {
        encoding: "utf8",
        env: { ...cliEnv(fixture.root, fixture.userRoot), HARNESS_TEST_VERTICAL_SCRIPT_BLOCK_FILE: blocker },
      },
    );
    assert.equal(
      launched.status,
      0,
      `${launched.stderr}\n${launched.stdout}\n${existsSync(path.join(fixture.userRoot, "logs", "daemon-default.log")) ? readFileSync(path.join(fixture.userRoot, "logs", "daemon-default.log"), "utf8") : "daemon log missing"}`,
    );
    register(fixture.root, fixture.userRoot, repoId);
    assert.equal(
      runAutostartCli(fixture.root, fixture.userRoot, [
        "task",
        "create",
        "--id",
        taskId,
        "--admin",
        "--title",
        "Vertical Wedge",
      ]).outcome,
      "applied",
    );

    const socket = await connectSocket(endpoint, 2_000);
    client = new JsonRpcLineClient(socket, socket);
    await client.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, 2_000);
    scriptRequest = client.request("repo.script.run", {
      repo: { repoId },
      payload: { scriptId: "vertical:software-coding:repository-audit", taskId, inputs: {}, dryRun: true },
    }) as Promise<Record<string, unknown>>;
    const launch = await Promise.race([
      waitForFileContent(started).then(() => ({ state: "started" as const })),
      scriptRequest.then((receipt) => ({ state: "settled" as const, receipt })),
    ]);
    assert.equal(launch.state, "started", JSON.stringify(launch));

    const probeStarted = performance.now();
    let handshake: Record<string, unknown>;
    try {
      const response = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 2_000, 250);
      handshake = { ok: true, elapsedMs: Math.round(performance.now() - probeStarted), daemonPid: response.pid };
    } catch (error) {
      handshake = {
        ok: false,
        elapsedMs: Math.round(performance.now() - probeStarted),
        code: coded(error),
        message: error instanceof Error ? error.message : String(error),
      };
    }
    context.diagnostic(`blocked vertical script handshake probe: ${JSON.stringify(handshake)}`);
    assert.equal(handshake.ok, true, JSON.stringify(handshake));

    const readSocket = await connectSocket(endpoint, 2_000);
    readClient = new JsonRpcLineClient(readSocket, readSocket);
    await readClient.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, 2_000);
    const readStarted = performance.now(),
      readRequest = readClient.request("repo.tasks.list", { repo: { repoId }, payload: {} });
    const readWhileBlocked = { state: "settled" as const, receipt: await readRequest };
    const snapshotTaskIds = Array.isArray(readWhileBlocked.receipt?.rows)
        ? readWhileBlocked.receipt.rows.map((row) => String((row as Record<string, unknown>).taskId))
        : null,
      snapshotWhileBlocked = {
        state: readWhileBlocked.state,
        elapsedMs: Math.round(performance.now() - readStarted),
        readStatus: readWhileBlocked.receipt?.status,
        taskIds: snapshotTaskIds,
      };
    context.diagnostic(`same-repo snapshot probe while script blocked: ${JSON.stringify(snapshotWhileBlocked)}`);
    assert.deepEqual(
      { state: readWhileBlocked.state, readStatus: readWhileBlocked.receipt?.status },
      { state: "settled", readStatus: "ready" },
      JSON.stringify(snapshotWhileBlocked),
    );
    assert.deepEqual(snapshotTaskIds, [taskId], "the concurrent read must return the committed pre-write snapshot");

    const queuedSocket = await connectSocket(endpoint, 2_000);
    queuedClient = new JsonRpcLineClient(queuedSocket, queuedSocket);
    await queuedClient.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, 2_000);
    queuedWrite = queuedClient.request("repo.task.create", {
      repo: { repoId },
      payload: { taskId: "task-queued-write", title: "Queued Write" },
    }) as Promise<Record<string, unknown>>;
    const orderingStarted = performance.now();
    await queuedWrite;
    const orderingWhileBlocked = { state: "settled", elapsedMs: Math.round(performance.now() - orderingStarted) };
    context.diagnostic(`same-repo write ordering probe while script blocked: ${JSON.stringify(orderingWhileBlocked)}`);

    rmSync(blocker, { force: true });
    const [scriptReceipt, writeReceipt] = await Promise.all([scriptRequest, queuedWrite]);
    const orderingAfterRelease = {
      scriptOutcome: scriptReceipt.outcome,
      writeOutcome: writeReceipt.outcome,
      writeRevision: writeReceipt.revision,
    };
    context.diagnostic(
      `vertical settlement after independent same-repo write: ${JSON.stringify(orderingAfterRelease)}`,
    );
    assert.deepEqual(
      { scriptOutcome: scriptReceipt.outcome, writeOutcome: writeReceipt.outcome },
      { scriptOutcome: "pending", writeOutcome: "applied" },
    );
    assert.equal(writeReceipt.status, "accepted_durable");
    assertValidWriteReceipt(writeReceipt);
  } finally {
    rmSync(blocker, { force: true });
    await Promise.all([scriptRequest?.catch(() => undefined), queuedWrite?.catch(() => undefined)]);
    client?.close();
    readClient?.close();
    queuedClient?.close();
  }
};
test(
  "a blocked vertical script keeps handshakes, snapshots, and same-repo writes live",
  { timeout: 120_000 },
  blockedVerticalScriptTest,
);
