// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { requestDaemonJsonRpcAt } from "../../daemon/src/client/local-json-rpc-client.ts";
import { jsonRpcMethodContracts } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { startDaemon } from "../../daemon/src/runtime.ts";
import { apiRouteContracts, createLocalGuiServiceBridge } from "../src/index.ts";

test("GUI client reaches every shipped read through a real resident daemon", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-gui-resident-daemon-"));
  const rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user"), daemonId = "gui-integration";
  const previous = { userRoot: process.env.HARNESS_DAEMON_USER_ROOT, daemonId: process.env.HARNESS_DAEMON_ID,
    repoId: process.env.HARNESS_DAEMON_REPO_ID };
  process.env.HARNESS_DAEMON_USER_ROOT = userRoot;
  process.env.HARNESS_DAEMON_ID = daemonId;
  process.env.HARNESS_DAEMON_REPO_ID = "gui-test";
  const daemon = await startDaemon({ daemonId, userRoot });
  try {
    const bootstrapped = await requestDaemonJsonRpcAt(daemon.endpoint, "daemon.repo.bootstrap",
      { rootDir, repoId: "gui-test", personId: "person-gui", displayName: "GUI Test" }, 1_000);
    assert.equal(bootstrapped.ok, true);
    const created = await requestDaemonJsonRpcAt(daemon.endpoint, "repo.task.run", { repo: { repoId: "gui-test" },
      payload: { action: { kind: "task-create", taskId: "task-gui", title: "Resident GUI task", completionGateIds: [] } } }, 1_000);
    assert.equal(created.ok, true, JSON.stringify(created));

    const bridge = createLocalGuiServiceBridge(rootDir);
    const tasks = await bridge.invoke("getTasks", null) as { readonly ok: boolean; readonly rows: readonly { readonly taskId: string; readonly snapshot: { readonly task: { readonly title: string } } }[] };
    assert.equal(tasks.ok, true);
    assert.deepEqual(tasks.rows.map(({ taskId }) => taskId), ["task-gui"]);
    assert.equal(tasks.rows[0]?.snapshot.task.title, "Resident GUI task");
    const graph = await bridge.invoke("getRelationGraph", null) as { readonly ok: boolean; readonly edges: readonly unknown[] };
    assert.equal(graph.ok, true); assert.ok(Array.isArray(graph.edges));
    const decisions = await bridge.invoke("getDecisions", null) as { readonly ok: boolean; readonly decisions: readonly unknown[] };
    assert.equal(decisions.ok, true); assert.ok(Array.isArray(decisions.decisions));
  } finally {
    await daemon.stop();
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previous.userRoot); restoreEnv("HARNESS_DAEMON_ID", previous.daemonId);
    restoreEnv("HARNESS_DAEMON_REPO_ID", previous.repoId); rmSync(parent, { recursive: true, force: true });
  }
});

test("GUI contract rejects any shipped bridge method missing from the daemon protocol", () => {
  const daemonMethods = new Set(jsonRpcMethodContracts.map(({ method }) => method));
  const missing = apiRouteContracts.filter(({ guiBridgeMethod }) => guiBridgeMethod !== undefined)
    .map(({ id }) => `repo.${id}`).filter((method) => !daemonMethods.has(method));
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
