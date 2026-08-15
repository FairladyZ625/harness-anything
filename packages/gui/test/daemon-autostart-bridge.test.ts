// harness-test-tier: integration
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { requestDaemonJsonRpcAt } from "../../daemon/src/client/local-json-rpc-client.ts";
import { terminateProcess } from "../../daemon/src/process-port.ts";
import { readDaemonPid, startDaemon } from "../../daemon/src/runtime.ts";
import { createLocalGuiServiceBridge } from "../src/index.ts";

interface Failure { readonly ok: boolean; readonly error?: { readonly code: string; readonly hint: string } }

test("GUI bridge auto-starts an unreachable daemon, retries the read, and reaches the resident daemon", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-gui-autostart-")), rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user"), daemonId = "gui-autostart";
  const previous = process.env.HARNESS_DAEMON_USER_ROOT, previousId = process.env.HARNESS_DAEMON_ID;
  process.env.HARNESS_DAEMON_USER_ROOT = userRoot; process.env.HARNESS_DAEMON_ID = daemonId;
  const daemon = await startDaemon({ daemonId, userRoot });
  try {
    assert.equal((await requestDaemonJsonRpcAt(daemon.endpoint, "daemon.repo.bootstrap", { rootDir, repoId: "gui-autostart", personId: "person-gui", displayName: "GUI Autostart" }, 1_000)).ok, true);
    assert.equal((await requestDaemonJsonRpcAt(daemon.endpoint, "repo.task.create", { repo: { repoId: "gui-autostart" }, payload: { taskId: "task-gui-autostart", title: "GUI autostart task" } }, 1_000)).ok, true);
    const beforePid = readDaemonPid(userRoot, daemonId); assert.ok(beforePid);
    await daemon.stop();
    // No in-process daemon and no pid file: the first bridge read must launch a
    // detached daemon through the main-process launch seam and then answer.
    const tasks = await createLocalGuiServiceBridge(rootDir).invoke("getTasks", { repoId: "gui-autostart" });
    assert.equal(tasks.ok, true, JSON.stringify(tasks));
    const rows = (tasks as { rows?: Array<{ taskId?: string }> }).rows ?? [];
    assert.deepEqual(rows.map((row) => row.taskId), ["task-gui-autostart"], JSON.stringify(tasks));
    const afterPid = readDaemonPid(userRoot, daemonId); assert.ok(afterPid, "bridge autostart must leave a resident daemon pid file"); assert.notEqual(afterPid, beforePid);
    await stopResident(userRoot, daemonId);
  } finally {
    process.env.HARNESS_DAEMON_USER_ROOT = previous; process.env.HARNESS_DAEMON_ID = previousId;
    await daemon.stop().catch(() => undefined); rmSync(parent, { recursive: true, force: true });
  }
});

test("GUI bridge reports a classified error after two failed autostart attempts", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "requires POSIX non-root permission semantics" : false }, async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-gui-autostart-fail-")), rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user"), daemonId = "gui-autostart-fail";
  const previous = process.env.HARNESS_DAEMON_USER_ROOT, previousId = process.env.HARNESS_DAEMON_ID;
  process.env.HARNESS_DAEMON_USER_ROOT = userRoot; process.env.HARNESS_DAEMON_ID = daemonId;
  const daemon = await startDaemon({ daemonId, userRoot });
  try {
    assert.equal((await requestDaemonJsonRpcAt(daemon.endpoint, "daemon.repo.bootstrap", { rootDir, repoId: "gui-autostart-fail", personId: "person-gui", displayName: "GUI Autostart" }, 1_000)).ok, true);
    await daemon.stop();
    chmodSync(userRoot, 0o555);
    const failure = await createLocalGuiServiceBridge(rootDir).invoke("getTasks", { repoId: "gui-autostart-fail" }) as Failure;
    assert.equal(failure.ok, false); assert.equal(failure.error?.code, "daemon_bind_timeout");
    assert.match(failure.error?.hint ?? "", /did not accept connections/u);
  } finally {
    process.env.HARNESS_DAEMON_USER_ROOT = previous; process.env.HARNESS_DAEMON_ID = previousId;
    chmodSync(userRoot, 0o755); await daemon.stop().catch(() => undefined); rmSync(parent, { recursive: true, force: true });
  }
});

async function stopResident(userRoot: string, daemonId: string): Promise<void> { const pid = readDaemonPid(userRoot, daemonId);
  if (pid === null) return; terminateProcess(pid); for (let attempt = 0; attempt < 200; attempt += 1) { try { process.kill(pid, 0); } catch { return; } await new Promise((resolve) => setTimeout(resolve, 10)); } }
