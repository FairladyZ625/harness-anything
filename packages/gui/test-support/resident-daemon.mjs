import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { requestDaemonJsonRpcAt } from "../../daemon/src/client/local-json-rpc-client.ts";
import { startDaemon } from "../../daemon/src/runtime.ts";

export async function startGuiResidentDaemonFixture({
  prefix = "ha-gui-resident-daemon-",
  daemonId = "gui-integration",
  repoId = "gui-test",
  task,
  beforeStop,
  beforeRestart
} = {}) {
  const parent = mkdtempSync(path.join(tmpdir(), prefix));
  const rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user");
  let daemon = await startDaemon({ daemonId, userRoot });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await daemon.stop();
    rmSync(parent, { recursive: true, force: true });
  };
  try {
    const bootstrapped = await requestDaemonJsonRpcAt(daemon.endpoint, "daemon.repo.bootstrap",
      { rootDir, repoId, personId: "person-gui", displayName: "GUI Test" }, 1_000);
    if (bootstrapped.ok !== true) throw new Error(`GUI daemon bootstrap failed: ${JSON.stringify(bootstrapped)}`);
    if (task) {
      const created = await requestDaemonJsonRpcAt(daemon.endpoint, "repo.task.create", { repo: { repoId },
        payload: { taskId: task.taskId, title: task.title } }, 1_000);
      if (created.ok !== true) throw new Error(`GUI daemon task fixture failed: ${JSON.stringify(created)}`);
    }
    if (beforeRestart) { await beforeStop?.(daemon.endpoint, repoId); await daemon.stop(); await beforeRestart(rootDir, repoId); daemon = await startDaemon({ daemonId, userRoot }); }
    return { rootDir, userRoot, daemonId, repoId, endpoint: daemon.endpoint,
      env: { HARNESS_DAEMON_USER_ROOT: userRoot, HARNESS_DAEMON_ID: daemonId, HARNESS_DAEMON_REPO_ID: repoId }, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
