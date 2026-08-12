// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { daemonGuiReadMethods, jsonRpcMethodContracts, parseDaemonGuiReadResponse, parseDaemonGuiReadResult,
  type DaemonGuiReadMethod } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { apiRouteContracts, createLocalGuiServiceBridge } from "../src/index.ts";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";
import { writeTriadicLedger } from "../test-support/triadic-ledger.mjs";

test("GUI client reaches every shipped read through a real resident daemon", async () => {
  const fixture = await startGuiResidentDaemonFixture({ task: { taskId: "task-gui", title: "Resident GUI task" } });
  const previous = { userRoot: process.env.HARNESS_DAEMON_USER_ROOT, daemonId: process.env.HARNESS_DAEMON_ID,
    repoId: process.env.HARNESS_DAEMON_REPO_ID };
  Object.assign(process.env, fixture.env);
  try {
    writeTriadicLedger(fixture.rootDir);
    const bridge = createLocalGuiServiceBridge(fixture.rootDir);
    const results = new Map<DaemonGuiReadMethod, unknown>();
    for (const contract of daemonGuiReadMethods) {
      const result = await bridge.invoke(contract.guiBridgeMethod, null);
      assert.equal(parseDaemonGuiReadResponse(contract.method, result).ok, true, contract.method);
      results.set(contract.method, result);
    }
    assert.deepEqual([...results.keys()], daemonGuiReadMethods.map(({ method }) => method));
    const tasks = parseDaemonGuiReadResult("repo.tasks.list", results.get("repo.tasks.list"));
    assert.deepEqual(tasks.rows.map(({ taskId }) => taskId), ["task-gui"]);
    assert.equal(tasks.rows[0]?.snapshot.task?.title, "Resident GUI task");
    const graph = parseDaemonGuiReadResult("repo.triadic.relationGraph", results.get("repo.triadic.relationGraph"));
    assert.equal(graph.edges.length, 3); assert.equal(graph.factAnchors.length, 1);
    const decisions = parseDaemonGuiReadResult("repo.decisions.list", results.get("repo.decisions.list"));
    assert.deepEqual(decisions.decisions.map(({ decisionId }) => decisionId), ["dec_gui_smoke"]);
  } finally {
    await fixture.stop();
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previous.userRoot); restoreEnv("HARNESS_DAEMON_ID", previous.daemonId);
    restoreEnv("HARNESS_DAEMON_REPO_ID", previous.repoId);
  }
});

test("GUI contract rejects any shipped bridge method missing from the daemon protocol", () => {
  const daemonMethods = new Set(jsonRpcMethodContracts.map(({ method }) => method));
  const missing = apiRouteContracts.filter(({ guiBridgeMethod }) => guiBridgeMethod !== undefined)
    .map(({ rpcMethod }) => rpcMethod).filter((method) => method === undefined || !daemonMethods.has(method));
  assert.deepEqual(missing, []);
});

test("local GUI bridge fails closed without explicit daemon registration and never autostarts", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-explicit-daemon-")), userRoot = path.join(rootDir, "user-daemon");
  const previous = process.env.HARNESS_DAEMON_USER_ROOT; process.env.HARNESS_DAEMON_USER_ROOT = userRoot;
  try {
    const result = await createLocalGuiServiceBridge(rootDir).invoke("getTasks", null) as Failure;
    assert.equal(result.ok, false); assert.equal(result.error?.code, "daemon_unavailable");
    assert.match(result.error?.hint ?? "", /workspace is not registered/u);
    assert.equal(existsSync(path.join(userRoot, "registry.json")), false);
  } finally { restoreEnv("HARNESS_DAEMON_USER_ROOT", previous); rmSync(rootDir, { recursive: true, force: true }); }
});

function restoreEnv(name: string, value: string | undefined): void { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
interface Failure { readonly ok: boolean; readonly error?: { readonly code: string; readonly hint: string } }
