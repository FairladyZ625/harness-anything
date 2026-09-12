import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { requestDaemonJsonRpcAt } from "../../daemon/src/client/local-json-rpc-client.ts";
import { startDaemon } from "../../daemon/src/runtime.ts";
import { openPersistentWriterEpoch, readLedgerWriterEpoch } from "../../daemon/src/writer-epoch.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

export async function startGuiResidentDaemonFixture({
  prefix = "ha-gui-resident-daemon-",
  daemonId = "gui-integration",
  repoId = "gui-test",
  task,
  beforeStop,
  beforeRestart,
  runtimeInstance,
} = {}) {
  const parent = mkdtempSync(path.join(tmpdir(), prefix));
  const rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user");
  const runtimeDiscover = runtimeInstance
    ? () => [
        {
          installationId: `installation-${runtimeInstance.instanceId}`,
          kindId: runtimeInstance.kindId,
          executablePath: process.execPath,
          version: "fixture",
          observedAt: "2026-09-12T00:00:00.000Z",
        },
      ]
    : undefined;
  let daemon = await startDaemon({ daemonId, userRoot, runtimeDiscover });
  let stopped = false;
  const pauseDaemon = async () => {
    await daemon.stop();
  };
  const resumeDaemon = async () => {
    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = "/tmp";
    try {
      daemon = await startDaemon({ daemonId, userRoot, runtimeDiscover });
      return daemon.endpoint;
    } finally {
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
    }
  };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await daemon.stop();
    rmSync(parent, { recursive: true, force: true });
  };
  try {
    const bootstrapped = await requestDaemonJsonRpcAt(
      daemon.endpoint,
      "daemon.repo.bootstrap",
      { rootDir, repoId, personId: "person-gui", displayName: "GUI Test" },
      1_000,
    );
    if (bootstrapped.ok !== true) throw new Error(`GUI daemon bootstrap failed: ${JSON.stringify(bootstrapped)}`);
    if (runtimeInstance) {
      const created = await requestDaemonJsonRpcAt(
        daemon.endpoint,
        "daemon.runtimeInstance.create",
        {
          payload: {
            ...runtimeInstance,
            installationId: `installation-${runtimeInstance.instanceId}`,
            authMode: "subscription",
          },
        },
        1_000,
      );
      if (created.ok !== true) throw new Error(`GUI runtime fixture failed: ${JSON.stringify(created)}`);
    }
    let packagePath = null;
    if (task) {
      const created = await requestDaemonJsonRpcAt(
        daemon.endpoint,
        "repo.task.create",
        { repo: { repoId }, payload: { taskId: task.taskId, title: task.title } },
        1_000,
      );
      if (created.ok !== true) throw new Error(`GUI daemon task fixture failed: ${JSON.stringify(created)}`);
      const visible = await requestDaemonJsonRpcAt(
        daemon.endpoint,
        "repo.task.read",
        {
          repo: { repoId },
          payload: {
            action: {
              kind: "receipt-show",
              opId: created.opId,
              waitFor: ["git_verified", "worktree_visible"],
              timeoutMs: 5000,
            },
          },
        },
        1000,
        10000,
      );
      if (visible.wait?.state !== "satisfied")
        throw new Error(`GUI task publication pending: ${JSON.stringify(visible)}`);
      packagePath = String(created.packagePath);
      await realizeTaskPlanFixture(
        rootDir,
        String(created.packagePath),
        (planPath) =>
          requestDaemonJsonRpcAt(
            daemon.endpoint,
            "repo.task.run",
            { repo: { repoId }, payload: { action: { kind: "doc-submit", paths: [planPath] } } },
            1_000,
          ),
        task.title,
      );
    }
    if (beforeRestart) {
      await beforeStop?.(daemon.endpoint, repoId);
      await daemon.stop();
      const stateRoot = path.join(userRoot, "fleet"),
        authority = openPersistentWriterEpoch({ stateRoot, holderId: "gui-stopped-fixture" });
      let writerFence;
      try {
        const lease = authority.acquire(repoId, readLedgerWriterEpoch(repoId, rootDir));
        writerFence = Object.freeze({
          schema: "harness-writer-epoch-fence/v1",
          stateRoot,
          repoId,
          holderId: lease.holderId,
          epoch: lease.epoch,
        });
      } finally {
        authority.close();
      }
      await beforeRestart(rootDir, repoId, writerFence);
      daemon = await startDaemon({ daemonId, userRoot });
    }
    return {
      rootDir,
      userRoot,
      daemonId,
      repoId,
      packagePath,
      endpoint: daemon.endpoint,
      env: { HARNESS_DAEMON_USER_ROOT: userRoot, HARNESS_DAEMON_ID: daemonId, HARNESS_DAEMON_REPO_ID: repoId },
      pauseDaemon,
      resumeDaemon,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
