// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRuntimeSessionResult } from "../src/agent-runtime-contract.ts";
import { openDaemonJsonRpcClientAt, type JsonRpcLineClient } from "../src/client/local-json-rpc-client.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { readDaemonLifecycleRecords } from "../src/lifecycle-log.ts";
import { startDaemon, type RunningDaemon } from "../src/runtime.ts";
import { openBootstrappedRepoCell, registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";

function deferred<T = void>() {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, message: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function running(start: Awaited<ReturnType<typeof startDaemon>>): RunningDaemon {
  assert.ok("stop" in start, JSON.stringify(start));
  return start;
}

// The runtime result is a fixture; daemon lifecycle, socket, authorization, parked-wait
// orchestration and the CLI's reconnect loop all use their real implementations.
test("a parked await observes drift without a completed RPC and the CLI reconnects to the successor", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-drain-recheck-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "drain-recheck",
    runtimeFile = path.join(parent, "runtime/dist/daemon/src/runtime.js"),
    marker = path.join(parent, "runtime/dist/build-id.txt"),
    endpoint = localUserDaemonEndpoint(userRoot, repoId),
    attached = deferred(),
    cliParked = deferred(),
    successorStarted = deferred(),
    sessionId = "session-drain-recheck";
  mkdirSync(path.dirname(runtimeFile), { recursive: true });
  writeFileSync(runtimeFile, "// fixture runtime\n");
  writeFileSync(marker, "build-a\n");
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    `schema: harness-anything/v1\nname: ${repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
  );
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.name", "Daemon Drain Test"],
    ["config", "user.email", "drain@example.invalid"],
    ["add", "harness"],
    ["commit", "--quiet", "-m", "fixture"],
  ])
    execFileSync("git", ["-C", rootDir, ...args]);
  registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
  let old: RunningDaemon | undefined,
    replacement: RunningDaemon | undefined,
    successorStart: Promise<void> | undefined,
    trigger: JsonRpcLineClient | undefined,
    cli: ReturnType<typeof spawn> | undefined,
    successorReads = 0;
  const openCell = (successor: boolean) => async (input: Parameters<typeof openBootstrappedRepoCell>[0]) => {
    const cell = await openBootstrappedRepoCell(input),
      observed = Object.create(cell);
    Object.defineProperties(observed, {
      read: {
        value: (...args: Parameters<typeof cell.read>) => {
          if (args[0] !== "repo.agentRuntime.sessions.read") return cell.read(...args);
          if (successor) successorReads++;
          return Promise.resolve({
            ok: true,
            status: "ready",
            session: {
              runtimeSessionId: sessionId,
              providerSessionId: null,
              instanceId: "fixture-runtime",
              installationId: "fixture-installation",
              kindId: "codex",
              definitionSnapshotRef: "fixture-definition",
              definitionSnapshot: null,
              definitionSnapshotPersisted: false,
              liveness: successor ? "exited" : "live",
              attachCapability: "unsupported",
              streamCursor: null,
              associations: [],
              activity: {
                lastObservedAt: "2026-11-04T00:00:00.000Z",
                outcome: successor ? "succeeded" : null,
                exitCode: successor ? 0 : null,
                resultRef: successor ? "result:fixture" : null,
                missingEvidence: null,
              },
            },
            settlement: successor ? { outcome: "succeeded", exitCode: 0, code: null, reason: null } : null,
            result: successor ? { ref: "result:fixture", text: "reconnected after supersession" } : null,
            watermark: 1,
            sourceRevision: 1,
          } satisfies AgentRuntimeSessionResult);
        },
      },
      awaitRuntimeSignal: {
        value: () => {
          cliParked.resolve();
          return new Promise<void>(() => undefined);
        },
      },
    });
    // startDaemon publishes the actual attached status after openCell resolves.
    if (!successor) setImmediate(() => attached.resolve());
    return observed;
  };
  try {
    old = running(
      await startDaemon({
        daemonId: repoId,
        userRoot,
        endpoint,
        runtimeFile,
        openCell: openCell(false),
        onSupersededExit: () => {
          successorStart = (async () => {
            replacement = running(
              await startDaemon({
                daemonId: repoId,
                userRoot,
                endpoint,
                runtimeFile,
                openCell: openCell(true),
              }),
            );
            successorStarted.resolve();
          })();
          return successorStart;
        },
      }),
    );
    await bounded(attached.promise, "repository did not attach");
    // This hello is sent before drift. Its reservation is released BEFORE the parked
    // request discovers drift, so there is no onRequestSettled callback afterwards.
    trigger = await openDaemonJsonRpcClientAt(endpoint, 2_000);
    const {
      HARNESS_ACTOR: _actor,
      HARNESS_DAEMON_ENDPOINT: _endpoint,
      HARNESS_DAEMON_RELAY: _relay,
      ...env
    } = process.env;
    cli = spawn(
      process.execPath,
      [
        path.resolve("packages/cli/src/index.ts"),
        "--root",
        rootDir,
        "--json",
        "runtime",
        "status",
        sessionId,
        "--wait",
        "--no-stream",
      ],
      {
        env: { ...env, HARNESS_DAEMON_USER_ROOT: userRoot, HARNESS_DAEMON_ID: repoId, HARNESS_DAEMON_REPO_ID: repoId },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    cli.stdout!.on("data", (chunk) => {
      stdout += String(chunk);
    });
    cli.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const cliExit = new Promise<number | null>((resolve, reject) => {
      cli!.once("error", reject);
      cli!.once("close", resolve);
    });
    await bounded(
      Promise.race([
        cliParked.promise,
        cliExit.then((code) => {
          throw new Error(`CLI exited before parking: ${code}\n${stdout}\n${stderr}`);
        }),
      ]),
      "CLI did not park its sessions.await",
    );
    writeFileSync(marker, "build-b\n");
    const interrupted = trigger
      .request("repo.agentRuntime.sessions.await", {
        repo: { repoId },
        payload: { runtimeSessionIds: [sessionId] },
      })
      .then(
        () => "unexpected-reply",
        (error: unknown) => (error as { code?: string }).code,
      );
    // No status probes or other RPCs here: those would conceal the missing trigger.
    await bounded(successorStarted.promise, "parked drift observation did not start the successor");
    assert.equal(await interrupted, "daemon_closed", "connection close is the existing retryable handoff signal");
    assert.ok(
      readDaemonLifecycleRecords(userRoot, repoId).some(
        (entry) => entry.event === "process_exit" && entry.outcome === "build_superseded",
      ),
    );
    const code = await bounded(cliExit, "CLI did not reconnect and settle", 30_000);
    assert.equal(code, 0, `${stderr}\n${stdout}`);
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.outcome, "succeeded");
    assert.equal(receipt.runtimeSessionId, sessionId);
    assert.ok(successorReads > 0, "the same CLI must read the successor");
  } finally {
    cli?.kill("SIGKILL");
    trigger?.close();
    await old?.stop();
    await successorStart;
    await replacement?.stop();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("observed drift rechecks a queued write without another request or status notification", async (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-drain-quiet-queue-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "quiet-queue",
    runtimeFile = path.join(parent, "runtime/dist/daemon/src/runtime.js"),
    marker = path.join(parent, "runtime/dist/build-id.txt"),
    attached = deferred(),
    queueObserved = deferred(),
    superseded = deferred();
  mkdirSync(path.dirname(runtimeFile), { recursive: true });
  writeFileSync(runtimeFile, "// fixture runtime\n");
  writeFileSync(marker, "build-a\n");
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    `schema: harness-anything/v1\nname: ${repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
  );
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.name", "Daemon Drain Test"],
    ["config", "user.email", "drain@example.invalid"],
    ["add", "harness"],
    ["commit", "--quiet", "-m", "fixture"],
  ])
    execFileSync("git", ["-C", rootDir, ...args]);
  registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
  let daemon: RunningDaemon | undefined,
    client: JsonRpcLineClient | undefined,
    pendingWrites = 0,
    closing = false,
    queueReads = 0;
  try {
    daemon = running(
      await startDaemon({
        daemonId: repoId,
        userRoot,
        runtimeFile,
        onSupersededExit: () => superseded.resolve(),
        openCell: async (input) => {
          const cell = await openBootstrappedRepoCell(input);
          setImmediate(() => attached.resolve());
          return {
            ...cell,
            status: () => {
              if (pendingWrites > 0) {
                queueReads++;
                queueObserved.resolve();
              }
              return { ...cell.status(), queueDepth: cell.status().queueDepth + pendingWrites };
            },
            close: async () => {
              closing = true;
              await cell.close();
            },
          };
        },
      }),
    );
    await bounded(attached.promise, "repository did not attach");
    client = await openDaemonJsonRpcClientAt(daemon.endpoint, 2_000);
    context.mock.timers.enable({ apis: ["setInterval"] });
    pendingWrites = 1;
    writeFileSync(marker, "build-b\n");
    await client.request("daemon.status", {});
    await bounded(queueObserved.promise, "drain did not inspect the queue");
    await new Promise((resolve) => setImmediate(resolve));
    const initialReads = queueReads;
    context.mock.timers.tick(5_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closing, false, "elapsed time must never force a pending write to close");
    assert.ok(queueReads > initialReads, "a blocked drain must recheck independently of RPC completion");
    pendingWrites = 0;
    // Intentionally emit no onStatus event: the lifecycle must make bounded progress itself.
    context.mock.timers.tick(1_000);
    await bounded(superseded.promise, "empty queue did not permit supersession without another RPC");
    assert.equal(closing, true);
  } finally {
    pendingWrites = 0;
    client?.close();
    await daemon?.stop();
    context.mock.timers.reset();
    rmSync(parent, { recursive: true, force: true });
  }
});
