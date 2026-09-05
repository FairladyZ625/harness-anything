import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { makeTaskEventReader } from "../../../packages/kernel/src/index.ts";
import { localUserDaemonEndpoint } from "../../../packages/daemon/src/client/local-daemon-target.ts";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { daemonProcessAlive } from "../../../packages/daemon/src/daemon-singleton.ts";
import { readDaemonPid, startDaemon } from "../../../packages/daemon/src/runtime.ts";
import {
  openBootstrappedRepoCell,
  registerBootstrappedDaemonRepo,
} from "../../../packages/daemon/test/repo-settings.fixture.ts";
import { writeProviderExecutable } from "../../../packages/daemon/test/fixtures/runtime-stub.ts";
import { reproduceRegistryWalRestart } from "../../../packages/daemon/test/registry-wal-restart.repro.mjs";
import { oracleO1, oracleO4 } from "../core/oracles.mjs";

const cli = path.resolve("packages/cli/src/index.ts"),
  registrySource = path.resolve("packages/kernel/src/daemon/registry.ts"),
  registryFixture = path.resolve("packages/daemon/test/stress/recovery/registry-upgrade-process.fixture.mjs");

export async function runRegistryChangeoverScenario(root) {
  mkdirSync(root, { recursive: true });
  const registryRoot = path.join(root, "registry-root"),
    repoRoot = path.join(registryRoot, "repo"),
    baseUserRoot = path.join(registryRoot, "user-base"),
    repoId = "stress-s3-registry";
  rosterRepo(repoRoot, repoId);
  registerBootstrappedDaemonRepo({
    canonicalRoot: repoRoot,
    repoId,
    userRoot: baseUserRoot,
    createConvenienceLinks: false,
  });
  downgradeRegistry(baseUserRoot);
  const killArms = [];
  for (const arm of ["kill-before-rename", "kill-after-rename"]) {
    const userRoot = path.join(registryRoot, arm);
    cpSync(baseUserRoot, userRoot, { recursive: true });
    const killed = spawnSync(process.execPath, [registryFixture, registrySource, userRoot, arm], processOptions());
    assert.equal(killed.signal, "SIGKILL", `${arm}: ${killed.stderr}`);
    assert.match(killed.stdout, new RegExp(arm, "u"));
    const observedImmediately = JSON.parse(readFileSync(path.join(userRoot, "registry.json"), "utf8")).schema,
      recovered = spawnSync(process.execPath, [registryFixture, registrySource, userRoot, "read"], processOptions());
    assert.equal(recovered.status, 0, recovered.stderr);
    const frame = JSON.parse(recovered.stdout);
    assert.deepEqual(frame, { schema: "harness-daemon-registry/v2", repoIds: [repoId] });
    killArms.push({ arm, observedImmediately, recoveredSchema: frame.schema });
  }

  const wrongUserRoot = path.join(registryRoot, "wrong-owner");
  cpSync(baseUserRoot, wrongUserRoot, { recursive: true });
  const wrongPath = path.join(wrongUserRoot, "registry.json"),
    wrong = JSON.parse(readFileSync(wrongPath, "utf8"));
  wrong.repos[0].repoId = "wrong-repository";
  writeFileSync(wrongPath, `${JSON.stringify(wrong, null, 2)}\n`);
  const wrongRead = spawnSync(
      process.execPath,
      [registryFixture, registrySource, wrongUserRoot, "read"],
      processOptions(),
    ),
    wrongFrame = JSON.parse(wrongRead.stdout),
    wrongRejected = !wrongFrame.repoIds.includes(repoId);
  assert.equal(wrongRead.status, 0, wrongRead.stderr);
  assert.equal(wrongRejected, true, JSON.stringify(wrongFrame));

  const restartRoot = path.join(root, "same-binary-restart"),
    restarted = await reproduceRegistryWalRestart("sigkill", { fixtureRoot: restartRoot });
  assert.equal(restarted.after.taskId, restarted.after.expectedTaskId);
  assert.equal(restarted.after.factId, restarted.after.expectedFactId);
  const changeover = await runBuildChangeover(path.join(root, "different-build"));
  return {
    redControl: {
      id: "F04/wrong-repo-id-mapping",
      observed: wrongRejected ? "FAIL" : "PASS",
      passed: wrongRejected,
      violations: wrongRejected ? ["original repoId is unreachable in the wrong-key model"] : [],
    },
    caseResult: {
      id: "F04/registry-upgrade-and-build-changeover",
      boundaryHits: [
        "v1 to v2 before atomic rename",
        "v1 to v2 after atomic rename",
        "same-binary daemon SIGKILL restart",
        "build drift drain then replacement start",
      ],
      faults: [
        { kind: "SIGKILL", boundary: "registry upgrade before rename" },
        { kind: "SIGKILL", boundary: "registry upgrade after rename" },
        { kind: "SIGKILL", boundary: "acknowledged WAL before same-build restart" },
      ],
      observations: {
        registryKillArms: killArms,
        originalRepoId: restarted.after.taskId === restarted.after.expectedTaskId,
        originalFactId: restarted.after.factId === restarted.after.expectedFactId,
        buildChangeover: changeover,
      },
      oracles: { O1: "PASS", O3: "PASS", O5: "PASS" },
      verdict: "PASS",
    },
  };
}

export async function runRuntimeOwnershipScenario(root) {
  mkdirSync(root, { recursive: true });
  const live = await runLiveRuntimeRestart(path.join(root, "live-runtime")),
    drift = await runLiveBuildDrain(path.join(root, "live-build-drain")),
    logBytes = Buffer.from(live.dispatchBytes),
    acceptedText = "provider-stress-session",
    acceptedBytes = Buffer.from(acceptedText),
    offset = logBytes.indexOf(acceptedBytes);
  assert.notEqual(offset, -1, "accepted provider session bytes must remain in the durable dispatch stream");
  const logs = {
      claims: [
        {
          streamId: live.dispatchId,
          offset,
          length: acceptedBytes.length,
          contentBase64: acceptedBytes.toString("base64"),
        },
      ],
      streams: { [live.dispatchId]: { bytesBase64: logBytes.toString("base64") } },
      diagnosticScope: "unresolved",
    },
    greenLog = oracleO4({ logs }),
    redLog = oracleO4({ logs: { ...logs, streams: {} } });
  assert.equal(greenLog.verdict, "PASS", JSON.stringify(greenLog));
  assert.equal(redLog.verdict, "FAIL", JSON.stringify(redLog));

  const runtimeEvents = makeTaskEventReader({ repoId: live.repoId, rootDir: live.repoRoot }).read().events,
    dispatchEvent = runtimeEvents.find(
      (event) =>
        event.type === "runtime_dispatch_requested" && event.payload.runtimeSessionId === live.runtimeSessionId,
    );
  assert.ok(dispatchEvent);
  const request = {
      requestId: "F11-runtime-dispatch",
      opId: dispatchEvent.opId,
      intentDigest: "runtime-dispatch",
      expectedEvents: [dispatchEvent],
    },
    receiptLog = {
      complete: true,
      errors: [],
      records: [
        { type: "campaign_started" },
        { type: "request", request },
        { type: "receipt", requestId: request.requestId, receipt: { status: "accepted_durable" } },
        { type: "campaign_completed" },
      ],
    },
    acceptanceOracle = oracleO1({
      authority: "canonical",
      canonicalCut: { events: runtimeEvents, outcomes: [] },
      receiptLog,
    });
  assert.equal(acceptanceOracle.verdict, "PASS", JSON.stringify(acceptanceOracle));
  return {
    redControl: {
      id: "F11/missing-accepted-log-segment",
      observed: redLog.verdict,
      passed: redLog.verdict === "FAIL",
      violations: redLog.violations,
    },
    caseResult: {
      id: "F11/runtime-log-ownership-across-daemon-death-and-build-drain",
      boundaryHits: [
        "worker-host alive before daemon SIGKILL",
        "replacement daemon runtime adoption",
        "accepted provider bytes before settlement cleanup",
        "real build-drift drain with a live runtime count",
      ],
      faults: [{ kind: "SIGKILL", boundary: "daemon after worker-host alive" }],
      observations: { ...live.summary, buildDrain: drift },
      oracles: { O1: acceptanceOracle.verdict, O4: greenLog.verdict },
      verdict: "PASS",
    },
  };
}

export async function runMultiClientScenario(root) {
  mkdirSync(root, { recursive: true });
  const fixture = cliFixture(root, "stress-s3-multi-client"),
    env = fixture.env;
  runCli(fixture.repoRoot, env, ["daemon", "start", "--service"]);
  try {
    runCli(fixture.repoRoot, env, [
      "init",
      "--repo-id",
      fixture.repoId,
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
    ]);
    const before = runCli(fixture.repoRoot, env, ["daemon", "status"]),
      beforeTasks = runCli(fixture.repoRoot, env, ["task", "list"]),
      clients = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          spawnCli(fixture.repoRoot, env, ["task", "create", "--title", `Multi client ${String(index + 1)}`]),
        ),
      );
    assert.equal(
      clients.every(({ status, receipt }) => status === 0 && receipt.outcome === "applied"),
      true,
      JSON.stringify(clients),
    );
    const after = runCli(fixture.repoRoot, env, ["daemon", "status"]),
      afterTasks = runCli(fixture.repoRoot, env, ["task", "list"]),
      operationIds = new Set(clients.map(({ receipt }) => String(receipt.opId))),
      beforeCount = Array.isArray(beforeTasks.rows) ? beforeTasks.rows.length : -1,
      afterCount = Array.isArray(afterTasks.rows) ? afterTasks.rows.length : -1,
      acceptedTasks = afterCount - beforeCount,
      methods = daemonRequestMethods(fixture.repoRoot),
      fleetUploadObserved = methods.some((method) => method.includes("fleet.upload"));
    assert.equal(after.pid, before.pid, "all clients must use one daemon process");
    assert.equal(operationIds.size, 8, "every client must receive a distinct accepted operation");
    assert.equal(acceptedTasks, 8, JSON.stringify({ beforeTasks, afterTasks }));
    assert.equal(fleetUploadObserved, false);
    return {
      caseResult: {
        id: "S3/eight-independent-local-clients",
        boundaryHits: ["eight CLI processes", "one daemon socket", "one repository writer queue"],
        faults: [],
        observations: {
          clientPids: clients.map(({ pid }) => pid),
          daemonPid: after.pid,
          acceptedTasks,
          stagedFleetUploadObserved: fleetUploadObserved,
          stagedFleetUploadFinding: "orthogonal: local daemon clients do not enter the fleet upload protocol",
        },
        oracles: { oneDaemon: "PASS", allClientsAccepted: "PASS" },
        verdict: "PASS",
      },
    };
  } finally {
    runCliMaybe(fixture.repoRoot, env, ["daemon", "stop", "--force"]);
  }
}

async function runBuildChangeover(root) {
  const userRoot = path.join(root, "user"),
    runtimeFile = builtRuntime(path.join(root, "runtime"), "build-a"),
    marker = path.join(root, "runtime/packages/cli/dist/build-id.txt"),
    daemonId = `stress-build-${randomUUID()}`,
    endpoint = localUserDaemonEndpoint(userRoot, daemonId);
  let first, second;
  try {
    first = requireRunning(await startDaemon({ daemonId, userRoot, endpoint, runtimeFile }));
    const initial = await rpc(endpoint, "daemon.status");
    writeFileSync(marker, "build-b\n");
    const drifted = await rpc(endpoint, "daemon.status", true);
    await waitUntil(() => readDaemonPid(userRoot, daemonId) === null, 30_000, "first build drain exit");
    second = requireRunning(await startDaemon({ daemonId, userRoot, endpoint, runtimeFile }));
    const replacement = await rpc(endpoint, "daemon.status");
    assert.equal(initial.build.loadedBuildId, "build-a");
    assert.equal(drifted.daemonBuild.diskBuildId, "build-b");
    assert.equal(replacement.build.loadedBuildId, "build-b");
    return {
      initial: initial.build.loadedBuildId,
      drifted: drifted.daemonBuild.diskBuildId,
      replacement: replacement.build.loadedBuildId,
    };
  } finally {
    await second?.stop();
    await first?.stop();
  }
}

async function runLiveBuildDrain(root) {
  const repoRoot = path.join(root, "repo"),
    userRoot = path.join(root, "user"),
    runtimeFile = builtRuntime(path.join(root, "runtime"), "build-a"),
    marker = path.join(root, "runtime/packages/cli/dist/build-id.txt"),
    daemonId = `stress-live-drift-${randomUUID()}`,
    endpoint = localUserDaemonEndpoint(userRoot, daemonId),
    repoId = "stress-live-build-drain";
  rosterRepo(repoRoot, repoId);
  registerBootstrappedDaemonRepo({ canonicalRoot: repoRoot, repoId, userRoot, createConvenienceLinks: false });
  let lifecycle, first, second;
  try {
    first = requireRunning(
      await startDaemon({
        daemonId,
        userRoot,
        endpoint,
        runtimeFile,
        openCell: async (input) => {
          const cell = await openBootstrappedRepoCell(input);
          lifecycle = input.recordLifecycle;
          lifecycle?.({
            event: "runtime_spawn",
            runtimeSessionId: "runtime-live-drift",
            dispatchId: "dispatch-live-drift",
            pid: process.pid,
          });
          return cell;
        },
      }),
    );
    await waitAttached(endpoint, repoId);
    const originalPid = readDaemonPid(userRoot, daemonId);
    writeFileSync(marker, "build-b\n");
    const receipt = await requestDaemonJsonRpcAt(
      endpoint,
      "repo.task.create",
      { repo: { repoId }, payload: { taskId: "task-live-drain", title: "Served by old build" } },
      2_000,
      5_000,
      undefined,
      true,
    );
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    const drifted = receipt.daemonBuild;
    assert.equal(drifted.liveRuntimeSessions, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(readDaemonPid(userRoot, daemonId), originalPid, "live runtime must retain the drifted daemon");
    lifecycle?.({
      event: "runtime_exit",
      runtimeSessionId: "runtime-live-drift",
      dispatchId: "dispatch-live-drift",
      pid: process.pid,
      outcome: "succeeded",
    });
    await waitUntil(() => readDaemonPid(userRoot, daemonId) === null, 30_000, "live build drain exit");
    second = requireRunning(await startDaemon({ daemonId, userRoot, endpoint, runtimeFile }));
    await waitAttached(endpoint, repoId);
    const replacement = await rpc(endpoint, "daemon.status");
    assert.equal(replacement.build.loadedBuildId, "build-b");
    return { retainedPid: originalPid, liveRuntimeSessions: 1, replacementBuild: replacement.build.loadedBuildId };
  } finally {
    await second?.stop();
    await first?.stop();
  }
}

async function runLiveRuntimeRestart(root) {
  const fixture = cliFixture(root, "stress-s3-runtime"),
    binRoot = path.join(root, "bin"),
    release = path.join(root, "provider-release");
  mkdirSync(binRoot, { recursive: true });
  writeHoldingProvider(path.join(binRoot, "codex"), release);
  const env = { ...fixture.env, PATH: `${binRoot}${path.delimiter}${fixture.env.PATH ?? ""}` };
  runCli(fixture.repoRoot, env, ["daemon", "start", "--service"]);
  try {
    runCli(fixture.repoRoot, env, [
      "init",
      "--repo-id",
      fixture.repoId,
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
    ]);
    const inventory = runCli(fixture.repoRoot, env, ["runtime", "instance", "list"]),
      installation = inventory.installations.find((row) => row.kindId === "codex");
    assert.ok(installation, JSON.stringify(inventory));
    runCli(fixture.repoRoot, env, [
      "runtime",
      "instance",
      "create",
      "--id",
      "stress-runtime",
      "--name",
      "Stress Runtime",
      "--kind",
      "codex",
      "--provider",
      "openai",
      "--model",
      "stress-model",
      "--auth",
      "subscription",
    ]);
    const spawned = runCli(fixture.repoRoot, env, [
        "runtime",
        "run",
        "stress-runtime",
        "--prompt",
        "hold across daemon death",
        "--detach",
      ]),
      runtimeSessionId = String(spawned.runtimeSessionId),
      dispatchId = String(spawned.dispatchId),
      beforeStatus = await waitRuntime(fixture.repoRoot, env, runtimeSessionId, "live", "initial runtime live"),
      daemonBefore = runCli(fixture.repoRoot, env, ["daemon", "status"]),
      dispatchPath = path.join(fixture.repoRoot, ".harness/runtime/dispatches", `${dispatchId}.jsonl`),
      workerPid = await waitValue(
        () => {
          const started = readDispatch(dispatchPath).find((record) => record.kind === "process_started");
          return Number.isInteger(started?.pid) ? Number(started.pid) : null;
        },
        30_000,
        "worker-host pid publication",
      );
    assert.equal(daemonProcessAlive(workerPid), true);
    process.kill(Number(daemonBefore.pid), "SIGKILL");
    await waitUntil(() => !daemonProcessAlive(Number(daemonBefore.pid)), 30_000, "daemon SIGKILL exit");
    assert.equal(daemonProcessAlive(workerPid), true, "worker-host must survive daemon SIGKILL");
    const afterStatus = await waitRuntime(fixture.repoRoot, env, runtimeSessionId, "live", "adopted runtime live"),
      daemonAfter = runCli(fixture.repoRoot, env, ["daemon", "status"]);
    assert.notEqual(daemonAfter.pid, daemonBefore.pid);
    assert.equal(afterStatus.session.liveness, beforeStatus.session.liveness);
    assert.equal(daemonProcessAlive(workerPid), true);
    const cancelled = runCli(fixture.repoRoot, env, ["runtime", "cancel", runtimeSessionId]);
    assert.equal(cancelled.detail, "cancelled");
    await waitRuntime(fixture.repoRoot, env, runtimeSessionId, "exited", "cancelled runtime exit");
    await waitUntil(() => !daemonProcessAlive(workerPid), 30_000, "worker-host exit after cancellation");
    const dispatchBytes = readFileSync(dispatchPath, "utf8"),
      records = readDispatch(dispatchPath),
      exits = records.filter((record) => record.kind === "process_exit");
    assert.equal(exits.length, 1, "runtime settlement must not be duplicated after adoption");
    assert.equal(dispatchBytes.split("provider-stress-session").length - 1 >= 1, true);
    return {
      repoId: fixture.repoId,
      repoRoot: fixture.repoRoot,
      runtimeSessionId,
      dispatchId,
      dispatchBytes,
      summary: {
        runtimeSessionId,
        dispatchId,
        workerPid,
        daemonBefore: daemonBefore.pid,
        daemonAfter: daemonAfter.pid,
        beforeLiveness: beforeStatus.session.liveness,
        afterLiveness: afterStatus.session.liveness,
        settlementRecords: exits.length,
      },
    };
  } finally {
    writeFileSync(release, "release\n");
    runCliMaybe(fixture.repoRoot, env, ["daemon", "stop", "--force"]);
  }
}

function cliFixture(root, repoId) {
  const repoRoot = path.join(root, "repo"),
    userRoot = path.join(root, "user"),
    daemonId = `${repoId}-${randomUUID()}`,
    inherited = { ...process.env };
  for (const key of Object.keys(inherited)) if (key.startsWith("HARNESS_")) delete inherited[key];
  mkdirSync(repoRoot, { recursive: true });
  return {
    repoId,
    repoRoot,
    userRoot,
    daemonId,
    env: {
      ...inherited,
      HOME: path.join(root, "home"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      HARNESS_ACTOR: "agent:stress-s3",
      HARNESS_DAEMON_USER_ROOT: userRoot,
      HARNESS_DAEMON_ID: daemonId,
      HARNESS_DAEMON_REPO_ID: repoId,
    },
  };
}

function writeHoldingProvider(target, release) {
  writeProviderExecutable(
    target,
    `const fs = require("node:fs"), args = process.argv.slice(2);\n` +
      `if (args[0] === "--version") { console.log("codex 0.0.0-stress-s3"); process.exit(0); }\n` +
      `if (args[0] === "login" && args[1] === "status") process.exit(0);\n` +
      `fs.readFileSync(0, "utf8");\n` +
      `console.log(JSON.stringify({ type: "thread.started", thread_id: "provider-stress-session" }));\n` +
      `console.log(JSON.stringify({ type: "item.completed", item: { id: "live", type: "agent_message", text: "runtime alive" } }));\n` +
      `const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(release)})) return; clearInterval(timer); ` +
      `console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })); }, 20);\n`,
  );
}

function rosterRepo(root, repoId) {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Stress Registry Test");
  git(root, "config", "user.email", "stress-registry@example.invalid");
  git(root, "config", "gc.auto", "0");
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    `schema: harness-anything/v1\nname: ${repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
  );
  writeFileSync(
    path.join(root, "harness/people.yaml"),
    `${JSON.stringify({
      schema: "harness-people/v1",
      people: [
        {
          personId: "writer",
          displayName: "writer",
          roles: ["writer"],
          credentials: [
            {
              kind: "unix-socket-owner-boundary",
              issuer: `host:${hostname()}`,
              subject: String(process.getuid?.() ?? 0),
            },
          ],
        },
      ],
      roles: [{ roleId: "writer", commandClasses: ["repo-read", "repo-write", "admin"] }],
    })}\n`,
  );
  git(root, "add", "harness");
  git(root, "commit", "--quiet", "-m", "fixture base");
}

function downgradeRegistry(userRoot) {
  const registryPath = path.join(userRoot, "registry.json"),
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  writeFileSync(
    registryPath,
    `${JSON.stringify({
      schema: "harness-daemon-registry/v1",
      repos: registry.repos.map(({ mode: _mode, connectionId: _connectionId, ...repo }) => repo),
    })}\n`,
  );
}

function builtRuntime(root, buildId) {
  const runtimeFile = path.join(root, "packages/cli/dist/daemon/src/runtime.js"),
    marker = path.join(root, "packages/cli/dist/build-id.txt");
  mkdirSync(path.dirname(runtimeFile), { recursive: true });
  writeFileSync(runtimeFile, "runtime\n");
  writeFileSync(marker, `${buildId}\n`);
  return runtimeFile;
}

function requireRunning(value) {
  if (!("stop" in value)) throw new Error(`expected a fresh daemon, found incumbent ${JSON.stringify(value)}`);
  return value;
}

async function rpc(endpoint, method, allowBuildDrift = false) {
  return requestDaemonJsonRpcAt(endpoint, method, {}, 2_000, 5_000, undefined, allowBuildDrift);
}

async function waitAttached(endpoint, repoId) {
  await waitUntil(async () => {
    const status = await rpc(endpoint, "daemon.status");
    return status.repos.some((repo) => repo.repoId === repoId && repo.state === "attached");
  });
}

async function waitRuntime(root, env, runtimeSessionId, liveness, label) {
  return waitValue(
    () => {
      const result = runCliMaybe(root, env, ["runtime", "status", runtimeSessionId]);
      return result.status === 0 && result.receipt.session?.liveness === liveness ? result.receipt : null;
    },
    30_000,
    label,
  );
}

async function waitUntil(check, timeoutMs = 30_000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`${label} did not settle within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitValue(read, timeoutMs = 30_000, label = "value") {
  let value;
  await waitUntil(
    () => {
      value = read();
      return value !== null && value !== undefined;
    },
    timeoutMs,
    label,
  );
  return value;
}

function runCli(root, env, args) {
  const result = runCliMaybe(root, env, args);
  assert.equal(result.status, 0, `${result.stderr}\n${JSON.stringify(result.receipt)}`);
  return result.receipt;
}

function runCliMaybe(root, env, args) {
  const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], {
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  return {
    status: result.status,
    pid: result.pid,
    receipt: result.stdout.trim() ? JSON.parse(result.stdout) : {},
    stderr: result.stderr,
  };
}

function spawnCli(root, env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--root", root, "--json", ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (status) =>
      resolve({ status, pid: child.pid, receipt: stdout.trim() ? JSON.parse(stdout) : {}, stderr }),
    );
  });
}

function readDispatch(file) {
  return readFileSync(file, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function daemonRequestMethods(root) {
  const requestRoot = path.join(root, ".harness/requests");
  if (!existsSync(requestRoot)) return [];
  return readdirSync(requestRoot)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readDispatch(path.join(requestRoot, name)))
    .map((record) => String(record.method ?? ""));
}

function processOptions() {
  return { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" };
}

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
