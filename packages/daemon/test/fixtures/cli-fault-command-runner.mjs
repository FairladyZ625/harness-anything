import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { observeDaemonBuild } from "../../src/build-identity.ts";
import { openDaemonHost } from "../../src/daemon-host.ts";
import { openRepoWriterCell } from "../../src/repo-cell-open.ts";
import { acquireWorkspaceLock } from "../../src/repo-cell-lock.ts";
import { localUserDaemonEndpoint } from "../../src/client/local-daemon-target.ts";
import { createJsonRpcProtocolServer } from "../../src/protocol/json-rpc-server.ts";
import { createUnixSocketTransportServer } from "../../src/transport/unix-socket.ts";
import { registerBootstrappedDaemonRepo } from "../repo-settings.fixture.ts";
import { createRealizedTaskPlanFixture } from "../../../../tools/fixtures/task-plan.mjs";
import { initIngressRepo, spawnCli } from "./runtime-ingress.ts";

const parent = mkdtempSync(path.join(tmpdir(), "ha-cli-fault-")),
  root = path.join(parent, "repo"),
  userRoot = path.join(parent, "user"),
  uid = process.getuid?.() ?? 0,
  repoId = "cli-fault-sentinel",
  taskId = "task-active";
let host, transport;
try {
  initIngressRepo(root, uid);
  registerBootstrappedDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });
  const auth = {
    transportKind: "unix-socket",
    unixSocketOwnerBoundary: {
      ownerUid: uid,
      source: "unix-socket-filesystem-owner-boundary",
    },
  };
  // The supported host injection seam runs the real writer in this process so the
  // loader can instrument it. This does not claim worker-thread isolation coverage.
  host = await openDaemonHost({
    daemonId: repoId,
    userRoot,
    openCell: async (input) => openRepoWriterCell(input, await acquireWorkspaceLock(input.rootDir)),
  });
  await host.attachmentsSettled();
  transport = createUnixSocketTransportServer({
    daemonId: repoId,
    socketPath: localUserDaemonEndpoint(userRoot, repoId),
    createProtocolServer: (authContext, emit) =>
      createJsonRpcProtocolServer({ host, build: { commit: null }, authContext, emit }),
  });
  await transport.start();
  const { HARNESS_ACTOR: _actor, ...baseEnv } = process.env;
  const env = {
    ...baseEnv,
    HOME: path.join(parent, "home"),
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_ID: repoId,
  };
  const requests = [];
  async function cli(args) {
    const started = performance.now();
    const result = await spawnCli(["--root", root, "--json", ...args], env);
    const receipt = JSON.parse(result.stdout);
    requests.push({ args, status: result.status, latencyMs: performance.now() - started, receipt });
    return receipt;
  }
  await createRealizedTaskPlanFixture(
    root,
    async () => {
      const created = await host.run(repoId, { kind: "task-create", taskId, title: "Active execution" }, auth);
      const published = await host.run(
        repoId,
        { kind: "receipt-show", opId: created.opId, waitFor: ["git_verified", "worktree_visible"], timeoutMs: 5000 },
        auth,
      );
      assert.equal(published.wait?.state, "satisfied");
      return created;
    },
    (planPath) => host.run(repoId, { kind: "doc-submit", paths: [planPath] }, auth),
  );
  const started = await cli(["task", "start", taskId]);
  assert.equal(started.ok, true, JSON.stringify(started));
  const shown = await cli(["task", "show", taskId]);
  const snapshot = JSON.parse(shown.evidence);
  assert.ok(snapshot.executions.some((execution) => execution.state === "active" && execution.submission === null));
  const state = globalThis.cliFaultState;
  state.uncached = process.argv[2] === "uncached";
  state.armed = true;
  const beforeCpu = process.cpuUsage(),
    beforeWall = performance.now();
  // Independent CLI clients model multiple edges converging on one center queue.
  // Task-create reaches the lookup under test; list/show independently probe service availability.
  for (let round = 0; round < 4; round += 1) {
    const [created, listed, read] = await Promise.all([
      cli(["task", "create", "--title", `Child ${round}`, "--parent", taskId, "--no-wait"]),
      cli(["task", "list", "--limit", "1"]),
      cli(["task", "show", taskId]),
    ]);
    assert.equal(created.code, "parent_not_found", JSON.stringify(created));
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.equal(read.ok, true, JSON.stringify(read));
  }
  const cpu = process.cpuUsage(beforeCpu),
    wallMs = performance.now() - beforeWall;
  assert.ok(state.scans > 0 && state.rows > 0, "fault must reach real SQLite rows");
  const latencies = requests
    .slice(2)
    .map((request) => request.latencyMs)
    .sort((a, b) => a - b);
  console.log(
    `CLI_FAULT_REPORT\t${JSON.stringify({
      schema: "cli-fault-sentinel/v1",
      arm: process.argv[2],
      pid: process.pid,
      loadedBuild: observeDaemonBuild().status(),
      topology: "real-daemon-host/in-process-writer/Unix-socket/CLI",
      scans: state.scans,
      scannedRows: state.rows,
      scanCpuMicros: state.cpuMicros,
      cpuMicros: cpu.user + cpu.system,
      wallMs,
      p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1],
      requests,
      boundedScanOracle: state.scans === 1 ? "PASS" : "FAIL",
    })}`,
  );
} finally {
  globalThis.cliFaultState.armed = false;
  try {
    await transport?.stop();
  } finally {
    try {
      await host?.close();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }
}
