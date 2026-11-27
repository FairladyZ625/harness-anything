// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  EDGE_UPGRADE_PROGRESS_EVENT,
  EDGE_UPGRADE_RELAUNCH_CHANNEL,
  EDGE_UPGRADE_RUN_CHANNEL,
  EDGE_UPGRADE_STATUS_CHANNEL,
  type EdgeUpgradeGuiProgress,
  type EdgeUpgradeGuiStatus,
} from "../src/api/edge-upgrade-contract.ts";
import { registerEdgeUpgradeIpc, type EdgeUpgradeIpcPorts } from "../src/main/edge-upgrade-ipc.ts";

const trustedEvent = {
  sender: { id: 11 },
  senderFrame: { url: "file:///Applications/Harness/renderer/index.html" },
};
const untrustedEvent = {
  sender: { id: 99 },
  senderFrame: { url: "https://untrusted.example/" },
};
const trustPolicy = {
  isTrustedWebContentsId: (id: number) => id === 11,
  rendererUrl: { packagedRendererUrl: trustedEvent.senderFrame.url },
};

function setupIpc(overrides: Partial<EdgeUpgradeIpcPorts> = {}) {
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  const progressEvents: EdgeUpgradeGuiProgress[] = [];
  let relaunched = 0;
  registerEdgeUpgradeIpc(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener as never);
      },
    },
    trustPolicy,
    {
      isPackaged: false,
      userRoot: () => "/tmp/edge-user",
      daemonId: () => "default",
      targets: () => [
        {
          isDestroyed: () => false,
          webContents: {
            send: (channel, payload) => {
              if (channel === EDGE_UPGRADE_PROGRESS_EVENT) progressEvents.push(payload);
            },
          },
        },
      ],
      relaunch: () => {
        relaunched += 1;
      },
      ...overrides,
    },
  );
  return {
    invoke: (channel: string, payload?: unknown, event: unknown = trustedEvent) =>
      handlers.get(channel)!(event, payload),
    progressEvents,
    getRelaunched: () => relaunched,
  };
}

test("edge upgrade IPC rejects untrusted senders and validates run inputs", async () => {
  const api = setupIpc();
  await assert.rejects(() => api.invoke(EDGE_UPGRADE_STATUS_CHANNEL, null, untrustedEvent));
  await assert.rejects(() => api.invoke(EDGE_UPGRADE_RUN_CHANNEL, {}, untrustedEvent));
  await assert.rejects(() => api.invoke(EDGE_UPGRADE_RELAUNCH_CHANNEL, null, untrustedEvent));
  await assert.rejects(() => api.invoke(EDGE_UPGRADE_RUN_CHANNEL, { unknownKey: true }), /does not take/u);
  await assert.rejects(() => api.invoke(EDGE_UPGRADE_RUN_CHANNEL, { toRef: "--evil" }), /valid git ref/u);
  await assert.rejects(
    () => api.invoke(EDGE_UPGRADE_RUN_CHANNEL, { rollback: true, toRef: "abc1234" }),
    /cannot combine/u,
  );
  await assert.rejects(() => api.invoke(EDGE_UPGRADE_RELAUNCH_CHANNEL, { extra: 1 }), /does not accept/u);
});

test("packaged desktop app reports packaged mode and blocks source-checkout edge upgrade", async () => {
  const api = setupIpc({ isPackaged: true });
  const status = (await api.invoke(EDGE_UPGRADE_STATUS_CHANNEL, null)) as EdgeUpgradeGuiStatus;
  assert.equal(status.mode, "packaged");
  await assert.rejects(() => api.invoke(EDGE_UPGRADE_RUN_CHANNEL, {}), /signed release updater/u);
});

test("source mode runs shared edge upgrade orchestrator, broadcasts progress, guards concurrency, and relaunches", async () => {
  let releaseUpgrade!: () => void;
  const upgradeGate = new Promise<void>((resolve) => {
    releaseUpgrade = resolve;
  });
  const api = setupIpc({
    checkStatus: async () => ({
      ok: true,
      channel: "source",
      installRoot: "/tmp/source",
      repoId: "demo",
      localCommit: "a".repeat(40),
      daemonCommit: "a".repeat(40),
      centerCommit: "b".repeat(40),
      centerCommitSource: "fleet_overview_center",
      updateAvailable: true,
      canRollback: false,
      previousCommit: null,
    }),
    executeUpgrade: async (options) => {
      options.onProgress?.({ stage: "installing", message: "building source" });
      await upgradeGate;
      options.onProgress?.({ stage: "completed", message: "done" });
      return {
        schema: "edge-upgrade-receipt/v1",
        ok: true,
        command: "edge-upgrade",
        outcome: "upgraded",
        installRoot: "/tmp/source",
        repoId: "demo",
        fromCommit: "a".repeat(40),
        toCommit: "b".repeat(40),
        targetCommit: "b".repeat(40),
        daemonPid: 2222,
        daemonBuildId: "b".repeat(40),
        daemonRestarted: true,
        syncedRepos: [{ repoId: "demo", revision: 7, lagRevisions: 0, mirrorOutcome: "materialized" }],
        rolledBack: false,
        guiRestartRequired: true,
      };
    },
  });

  const status = (await api.invoke(EDGE_UPGRADE_STATUS_CHANNEL, { repoId: "demo" })) as EdgeUpgradeGuiStatus;
  assert.equal(status.mode, "source");
  assert.equal(status.updateAvailable, true);

  const firstRun = api.invoke(EDGE_UPGRADE_RUN_CHANNEL, { repoId: "demo" });
  await assert.rejects(() => api.invoke(EDGE_UPGRADE_RUN_CHANNEL, { repoId: "demo" }), /already in progress/u);
  releaseUpgrade();
  const receipt = (await firstRun) as { readonly ok: boolean; readonly outcome: string };
  assert.equal(receipt.ok, true);
  assert.equal(receipt.outcome, "upgraded");
  assert.deepEqual(
    api.progressEvents.map((item) => item.stage),
    ["installing", "completed"],
  );

  await api.invoke(EDGE_UPGRADE_RELAUNCH_CHANNEL, null);
  assert.equal(api.getRelaunched(), 1);
});
