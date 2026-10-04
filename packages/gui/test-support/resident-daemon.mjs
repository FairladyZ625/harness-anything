import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { requestDaemonJsonRpcAt } from "@harness-anything/daemon/internal/client/local-json-rpc-client";
import { startDaemon } from "@harness-anything/daemon/internal/runtime";
import { openPersistentWriterEpoch, readLedgerWriterEpoch } from "@harness-anything/daemon/internal/writer-epoch";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import { serveKeycloak, signInAt } from "../../daemon/test/keycloak.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

export async function startGuiResidentDaemonFixture({
  prefix = "ha-gui-resident-daemon-",
  daemonId = "gui-integration",
  repoId = "gui-test",
  task,
  keycloakSetup,
  beforeStop,
  beforeRestart,
  afterRestart,
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
  const realm = await serveKeycloak();
  realm.keycloak.account("person-gui");
  realm.keycloak.permit("person-gui", repoId, effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"));
  realm.bind(userRoot);
  signInAt(userRoot, "person-gui");
  // 场景自备的额外账号/节点(如协作种子的指派对象)在 daemon 起来前登记。
  if (keycloakSetup) keycloakSetup(realm.keycloak);
  // 夹具是封闭的抛弃型 daemon:外层运行时注入的任务执行凭据与本夹具无关,留着会被
  // executionCredentialParams 附到每个请求上,被夹具 daemon 按「超出派工作用域」拒绝
  // (bootstrap 即 execution_credential_rejected)。夹具存续期间摘掉,stop 时恢复。
  const ambientExecutionCredential = process.env.HARNESS_EXECUTION_CREDENTIAL;
  delete process.env.HARNESS_EXECUTION_CREDENTIAL;
  let daemon = await startDaemon({ daemonId, userRoot, runtimeDiscover }).catch(async (error) => {
    await realm.close();
    throw error;
  });
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
    await realm.close();
    rmSync(parent, { recursive: true, force: true });
    if (ambientExecutionCredential !== undefined) process.env.HARNESS_EXECUTION_CREDENTIAL = ambientExecutionCredential;
  };
  try {
    const bootstrapped = await requestDaemonJsonRpcAt(
      daemon.endpoint,
      "daemon.repo.bootstrap",
      { rootDir, repoId, displayName: "GUI Test" },
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
        { repo: { repoId }, payload: task },
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
      await afterRestart?.(daemon.endpoint, repoId);
    }
    return {
      keycloak: realm.keycloak,
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
