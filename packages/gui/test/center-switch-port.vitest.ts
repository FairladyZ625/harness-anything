// @vitest-environment node
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { it } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import {
  createJsonRpcProtocolServer,
  createUnixSocketTransportServer,
  localUserDaemonEndpoint,
} from "@harness-anything/daemon/client";
import { acquireDaemonSingleton, daemonSocketProbe } from "@harness-anything/daemon/internal/daemon-singleton";
import {
  centerSymmetricIdentityPath,
  prepareCenterSwitchoverCandidate,
  prepareCenterSymmetricIdentity,
  relocateFleetCenter,
} from "@harness-anything/daemon/internal/fleet/center";
import { readDaemonRegistry, writeDaemonRegistryRepo } from "@harness-anything/kernel/daemon-registry";
import { auth } from "../../daemon/test/daemon-host-recovery.fixture.ts";
import { fleetEdgeHostFixture } from "../../daemon/test/fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture } from "../../daemon/test/fleet-node-claim.fixtures.ts";
import {
  waitForFleetReplicaReady,
  waitForFleetReplicaRevision,
} from "../../daemon/src/daemon-host/fleet/replica-sync.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { registerCenterSettingsIpc } from "../src/main/center-settings-ipc.ts";
import { createCenterSwitchPort } from "../src/main/center-switch-port.ts";
import { centerSettingsPreloadApi } from "../src/preload/center-settings-preload.ts";

function spkiSha256FromCertPem(certPem: Buffer): string {
  const x509 = new X509Certificate(certPem);
  return `sha256:${createHash("sha256")
    .update(x509.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
}

function readLedgerSnapshot(databasePath: string): {
  readonly revision: number;
  readonly history: string;
  readonly writerEpoch: number;
} {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const revRow = db.prepare("SELECT COALESCE(MAX(revision), 0) AS rev FROM event").get() as { readonly rev: unknown };
    const repRow = db.prepare("SELECT history FROM replication_state LIMIT 1").get() as { readonly history: unknown };
    const fenceRow = db.prepare("SELECT epoch FROM writer_lease LIMIT 1").get() as
      | { readonly epoch: unknown }
      | undefined;
    return {
      revision: Number(revRow?.rev ?? 0),
      history: String(repRow?.history ?? ""),
      writerEpoch: Number(fenceRow?.epoch ?? 0),
    };
  } finally {
    db.close();
  }
}

async function listenHttpsProbe(
  t: TestContext,
  key: Buffer,
  cert: Buffer,
): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const server = createHttpsServer({ key, cert }, (_req, res) => {
    res.statusCode = 200;
    res.end("ok");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let closed = false;
  const close = () =>
    closed
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          closed = true;
          server.closeAllConnections();
          server.close(() => resolve());
        });
  t.after(close);
  return { url: `https://127.0.0.1:${address.port}`, close };
}

function wireCenterSettingsPreload(port: ReturnType<typeof createCenterSwitchPort>) {
  let handler: ((event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>) | undefined;
  registerCenterSettingsIpc(
    {
      handle: (_channel, listener) => {
        handler = listener;
      },
    },
    { isTrustedWebContentsId: (id) => id === 9, rendererUrl: { packagedRendererUrl: "file:///renderer/index.html" } },
    {
      daemonRequest: async () => ({ ok: true }),
      fleetRequest: async () => ({ ok: true }),
      centerSwitch: port.centerSwitch,
      promoteFromEdge: port.promoteFromEdge,
      edgeLocalState: port.edgeLocalState,
      dialog: { selectFile: async () => null },
    },
  );
  const sender = Object.assign(new EventEmitter(), { id: 9 });
  const event = { sender, senderFrame: { url: "file:///renderer/index.html" } } as IpcMainInvokeEvent;
  return {
    rawInvoke: (request: unknown) => handler!(event, request),
    preload: centerSettingsPreloadApi((_channel, request) => handler!(event, request)),
  };
}

async function withCleanupContext(fn: (t: TestContext) => Promise<void>): Promise<void> {
  const cleanups: Array<() => unknown> = [];
  const t = {
    after: (cleanup: () => unknown) => {
      cleanups.push(cleanup);
    },
  } as unknown as TestContext;
  try {
    await fn(t);
  } finally {
    for (let index = cleanups.length - 1; index >= 0; index -= 1) {
      await cleanups[index]!();
    }
  }
}

it("F1/F3/F4: real GUI centerSwitchPort resolves trusted two-node candidate, preserves zero-write read-only dry-run, proves rollback target invalidation, and switches A -> B", async () => {
  await withCleanupContext(async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-gui-center-switch-port-"));
    const repoId = "lease-repo";
    const nodeAId = "node-two";
    const nodeBId = "node-one";
    const nodeAViewRoot = path.join(root, "node-a-views-not-created-yet");

    try {
      const nodeA = await fleetNodeClaimFixture(
        t,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        { replicaAdmission: true },
      );
      nodeA.owners.keycloak.node(nodeAId, "person-one", `secret-${nodeAId}`);
      const tlsCertPath = path.join(nodeA.root, "tls.crt");
      const tlsKeyPath = path.join(nodeA.root, "tls.key");
      const tlsCertPem = readFileSync(tlsCertPath);
      const tlsKeyPem = readFileSync(tlsKeyPath);
      const spkiSha256 = spkiSha256FromCertPem(tlsCertPem);

      // Prepare Node A's symmetric identity, then remove viewRoot to verify F4 dry-run never mkdirp's or rewrites identity.
      prepareCenterSymmetricIdentity(nodeA.userRoot, {
        repoId,
        nodeId: nodeAId,
        credential: `secret-${nodeAId}`,
        viewRoot: nodeAViewRoot,
        quotaBytes: 64 * 1024 * 1024,
        updatedAt: "2025-01-01T00:00:00.000Z",
      });
      removeTempRepository(nodeAViewRoot);
      assert.equal(existsSync(nodeAViewRoot), false);
      const identityPath = centerSymmetricIdentityPath(nodeA.userRoot, repoId);
      const identityBytesBefore = readFileSync(identityPath, "utf8");
      const pinnedTime = new Date("2025-01-01T00:00:00.000Z");
      utimesSync(identityPath, pinnedTime, pinnedTime);
      const identityMtimeBefore = statSync(identityPath).mtimeMs;

      assert.equal(
        (await nodeA.command("center-node", { kind: "task-create", taskId: "gui-sw-1", title: "Task 1" })).outcome,
        "applied",
      );
      const ledgerAPath = path.join(nodeA.repo, ".harness", "store", "generations", "3", "ledger.sqlite");
      const cutA = readLedgerSnapshot(ledgerAPath);
      assert.ok(cutA.revision > 0);
      assert.ok(cutA.writerEpoch >= 1);

      // Sync real independent Edge B over Fleet TLS from Center A.
      const edgeB = await fleetEdgeHostFixture(t, nodeA, { nodeId: nodeBId });
      const {
        schema: _schema,
        loginUrl: _loginUrl,
        loginRealm: _loginRealm,
        loginServername: _loginServername,
        loginBrowserUrl: _loginBrowserUrl,
        loginCertificate: _loginCertificate,
        waitTimeoutMs: _waitTimeoutMs,
        ...initialConn
      } = edgeB.config;
      const syncRes = await edgeB.rpc.handle({
        jsonrpc: "2.0",
        id: 201,
        method: "daemon.fleet.edge.sync",
        params: { payload: { ...initialConn, workspaceRoot: edgeB.edgeRoot, timeoutMs: 30_000 } },
      });
      assert.ok(syncRes && !Array.isArray(syncRes) && "result" in syncRes, JSON.stringify(syncRes));
      assert.equal((syncRes.result as Record<string, unknown>).ok, true, JSON.stringify(syncRes.result));
      assert.equal(
        await waitForFleetReplicaReady(
          { viewRoot: edgeB.viewRoot, repoId, nodeId: nodeBId },
          AbortSignal.timeout(30_000),
        ),
        true,
      );
      await waitForFleetReplicaRevision(
        { viewRoot: edgeB.viewRoot, repoId, nodeId: nodeBId },
        cutA.revision,
        AbortSignal.timeout(30_000),
      );

      // Real TLS listener and Auth HTTP(S) probe endpoints for candidate B.
      const targetTlsProbe = await listenHttpsProbe(t, tlsKeyPem, tlsCertPem);
      const targetAuthProbe = await listenHttpsProbe(t, tlsKeyPem, tlsCertPem);

      // Register trusted candidate B on center A (the production source of truth for GUI preflight, switch, and rollback).
      prepareCenterSwitchoverCandidate(nodeA.userRoot, {
        repoId,
        nodeId: nodeBId,
        targetExternalUrl: targetTlsProbe.url,
        targetLoginUrl: targetAuthProbe.url,
        targetSpkiSha256: spkiSha256,
        targetRoot: edgeB.edgeRoot,
        targetUserRoot: edgeB.edgeUser,
        targetStateRoot: path.join(edgeB.edgeUser, "fleet"),
        targetCaPath: tlsCertPath,
        targetServername: "localhost",
      });

      let readOnlyMode = true;
      const port = createCenterSwitchPort({
        userRoot: () => nodeA.userRoot,
        readOnly: () => readOnlyMode,
        daemonId: () => "node-a-gui",
      });
      const { preload } = wireCenterSettingsPreload(port);

      // F4 + F1 positive: read-only GUI dry-run passes real TLS/auth/replica preflight with ZERO disk writes!
      const dryRunReply = await preload.centerSwitch!({
        repoId,
        targetNodeId: nodeBId,
        dryRun: true,
      });
      assert.equal(dryRunReply.ok, true, JSON.stringify(dryRunReply));
      assert.equal(dryRunReply.dryRun, true);
      assert.equal(dryRunReply.preflight?.ok, true, JSON.stringify(dryRunReply.preflight));
      assert.equal(
        readFileSync(identityPath, "utf8"),
        identityBytesBefore,
        "F4: dry-run must not rewrite identity file",
      );
      assert.equal(statSync(identityPath).mtimeMs, identityMtimeBefore, "F4: dry-run must preserve identity mtime");
      assert.equal(existsSync(nodeAViewRoot), false, "F4: dry-run must not mkdirp missing viewRoot");

      // Read-only mode still rejects mutating switch and rollback.
      const readOnlyLive = await preload.centerSwitch!({ repoId, targetNodeId: nodeBId, dryRun: false });
      assert.equal(readOnlyLive.ok, false);
      assert.equal(readOnlyLive.code, "gui_read_only");
      const readOnlyRollback = await preload.centerSwitch!({
        repoId,
        abortRollback: true,
        switchoverId: "sw_ro_check",
        reason: "must fail in read-only mode",
      });
      assert.equal(readOnlyRollback.ok, false);
      assert.equal(readOnlyRollback.code, "gui_read_only");

      readOnlyMode = false;

      // F1 negative 1: unconfigured candidate NEVER falls back to source host!
      const unconfigured = await preload.centerSwitch!({
        repoId,
        targetNodeId: "unconfigured-edge",
        dryRun: true,
      });
      assert.equal(unconfigured.ok, false);
      assert.equal(unconfigured.preflight?.ok, false);
      assert.ok(unconfigured.preflight?.blockingCodes.includes("target_tls_unreachable"));
      assert.ok(unconfigured.preflight?.blockingCodes.includes("replica_disconnected"));
      const replicaCheck = unconfigured.preflight?.checks.find((check) => check.check === "replica_healthy");
      assert.ok(
        replicaCheck?.detail.includes("sync_failure:target_candidate_unconfigured"),
        JSON.stringify(replicaCheck),
      );

      // F1 negative 2: real TLS outage fails real TLS probe.
      await targetTlsProbe.close();
      const tlsBlocked = await preload.centerSwitch!({
        repoId,
        targetNodeId: nodeBId,
        dryRun: true,
      });
      assert.equal(tlsBlocked.ok, false);
      assert.equal(tlsBlocked.preflight?.ok, false);
      assert.ok(tlsBlocked.preflight?.blockingCodes.includes("target_tls_unreachable"));

      // Reopen target TLS probe and update candidate URL for the remaining F3 + F1 live tests.
      const targetTlsProbe2 = await listenHttpsProbe(t, tlsKeyPem, tlsCertPem);
      prepareCenterSwitchoverCandidate(nodeA.userRoot, {
        repoId,
        nodeId: nodeBId,
        targetExternalUrl: targetTlsProbe2.url,
        targetLoginUrl: targetAuthProbe.url,
        targetSpkiSha256: spkiSha256,
        targetRoot: edgeB.edgeRoot,
        targetUserRoot: edgeB.edgeUser,
        targetStateRoot: path.join(edgeB.edgeUser, "fleet"),
        targetCaPath: tlsCertPath,
        targetServername: "localhost",
      });

      // F3 positive: create real fenced_ceded on A while A & B are both healthy (target B never activated),
      // then stop A's live host and roll back via REAL GUI port!
      const swRollbackId = "sw_gui_rb_safe";
      const fencedOutcome = await relocateFleetCenter(
        [
          "fleet",
          "center",
          "switch",
          "--root",
          nodeA.repo,
          "--repo",
          repoId,
          "--user-root",
          nodeA.userRoot,
          "--state-root",
          nodeA.writerEpochStateRoot,
          "--to",
          nodeBId,
          "--switchover-id",
          swRollbackId,
        ],
        nodeA.userRoot,
        {
          switchover: {
            freezeAndDrain: async () => undefined,
            beforeTargetActivation: async () => {
              throw Object.assign(new Error("simulated crash after Phase 1 fence"), { code: "simulated_p1_crash" });
            },
          },
        },
      );
      assert.equal(fencedOutcome.receipt.ok, false, JSON.stringify(fencedOutcome.receipt));
      assert.equal(fencedOutcome.receipt.fencedCeded, true, JSON.stringify(fencedOutcome.receipt));
      assert.equal(
        (fencedOutcome.receipt.state as { readonly switchoverId?: string } | undefined)?.switchoverId,
        swRollbackId,
      );

      await nodeA.center.close();
      await nodeA.closeHost(nodeA.host);

      const rollbackReply = await preload.centerSwitch!({
        repoId,
        abortRollback: true,
        switchoverId: swRollbackId,
        reason: "Verified target B never activated",
      });
      assert.equal(rollbackReply.ok, true, JSON.stringify(rollbackReply));
      assert.equal(rollbackReply.phase, "aborted_rolled_back");
      assert.equal(rollbackReply.rollback?.rollbackEpoch, cutA.writerEpoch + 2);
      const invalidatedPath = path.join(edgeB.edgeUser, "fleet", "switchover-invalidated", `${repoId}.json`);
      assert.equal(existsSync(invalidatedPath), true, "F3: rollback must durably invalidate attempt on target B");
      assert.ok(readFileSync(invalidatedPath, "utf8").includes(swRollbackId));

      // Reopen A at oldEpoch + 2 on the same port so edge B replicates the post-rollback sequence,
      // then stop edge B FIRST (so it never records ECONNREFUSED in replica-health.json) before stopping A.
      let epochBeforeLive = cutA.writerEpoch + 2;
      const hostA2 = await nodeA.openHost();
      const centerA2 = await nodeA.openCenter(hostA2, nodeA.center.port);
      try {
        const postRbWrite = await hostA2.run(
          repoId,
          { kind: "task-create", taskId: "sw-post-rollback", title: "Post rollback write at oldEpoch+2" },
          auth,
        );
        assert.equal(postRbWrite.outcome, "applied", JSON.stringify(postRbWrite));
        const cutAfterRb = readLedgerSnapshot(
          path.join(nodeA.repo, ".harness", "store", "generations", "3", "ledger.sqlite"),
        );
        assert.ok(cutAfterRb.revision > cutA.revision);
        assert.ok(cutAfterRb.writerEpoch >= cutA.writerEpoch + 2);
        epochBeforeLive = cutAfterRb.writerEpoch;
        await waitForFleetReplicaRevision(
          { viewRoot: edgeB.viewRoot, repoId, nodeId: nodeBId },
          cutAfterRb.revision,
          AbortSignal.timeout(30_000),
        );
      } finally {
        edgeB.rpc.close();
        await edgeB.host.close();
        await centerA2.close();
        await nodeA.closeHost(hostA2);
      }

      // F1 positive: execute full real two-node live switchover A -> B through REAL GUI port (no URL/root args)!
      const swLiveId = "sw_gui_live_ab";
      const liveReply = await preload.centerSwitch!({
        repoId,
        targetNodeId: nodeBId,
        dryRun: false,
        switchoverId: swLiveId,
      });
      assert.equal(liveReply.ok, true, JSON.stringify(liveReply));
      assert.equal(liveReply.phase, "demoted_edge");
      assert.equal(liveReply.activation?.newEpoch, epochBeforeLive + 1);
      assert.equal(
        readDaemonRegistry({ userRoot: edgeB.edgeUser }).repos.find((r) => r.repoId === repoId)?.mode,
        "local",
        "F1: target B must switch to local center mode",
      );
      assert.equal(
        readDaemonRegistry({ userRoot: nodeA.userRoot }).repos.find((r) => r.repoId === repoId)?.mode,
        "remote-edge",
        "F1: source A must demote to remote-edge mode",
      );
      const promotedB = readLedgerSnapshot(
        path.join(edgeB.edgeRoot, ".harness", "store", "generations", "3", "ledger.sqlite"),
      );
      assert.equal(promotedB.history, cutA.history, "F1: planned switchover must preserve replication history");
      assert.equal(promotedB.writerEpoch, epochBeforeLive + 1);

      // F3 negative: when target B HAS activated, GUI audited rollback MUST hard refuse!
      // Simulate the crash window where B already activated swLiveId at newEpoch, while A still has fenced_ceded.
      const fencePathA = path.join(nodeA.userRoot, "fleet", "center-switchover-fence", `${repoId}.json`);
      const fenceA = JSON.parse(readFileSync(fencePathA, "utf8")) as Record<string, unknown>;
      writeFileSync(fencePathA, `${JSON.stringify({ ...fenceA, state: "fenced_ceded" }, null, 2)}\n`, "utf8");
      writeDaemonRegistryRepo({
        canonicalRoot: nodeA.repo,
        repoId,
        mode: "local",
        userRoot: nodeA.userRoot,
        createConvenienceLinks: false,
      });
      const refusedRollback = await preload.centerSwitch!({
        repoId,
        abortRollback: true,
        switchoverId: swLiveId,
        reason: "Must refuse rollback because target B already activated",
      });
      assert.equal(refusedRollback.ok, false, JSON.stringify(refusedRollback));
      assert.equal(refusedRollback.code, "target_activation_not_disproven");
      assert.equal(existsSync(fencePathA), true, "F3: source fence must remain intact when rollback is refused");
    } finally {
      removeTempRepository(root);
    }
  });
}, 180_000);

it("F2: real GUI promoteFromEdge stops a live local edge daemon, rotates history, switches registry to local, and returns localized recovery steps", async () => {
  await withCleanupContext(async (t) => {
    const repoId = "lease-repo";
    const nodeBId = "node-one";
    const daemonId = "edge-desktop-live";
    let stopServer: (() => Promise<void>) | null = null;
    let releaseLock: (() => void) | null = null;

    try {
      const oldCenter = await fleetNodeClaimFixture(
        t,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        { replicaAdmission: true },
      );
      assert.equal(
        (await oldCenter.command("center-node", { kind: "task-create", taskId: "bg-1", title: "Before outage" }))
          .outcome,
        "applied",
      );
      const centerCut = readLedgerSnapshot(
        path.join(oldCenter.repo, ".harness", "store", "generations", "3", "ledger.sqlite"),
      );

      // Sync real edge B so it has a real published generation-3 replica.
      const edgeB = await fleetEdgeHostFixture(t, oldCenter, { nodeId: nodeBId });
      const {
        schema: _schema,
        loginUrl: _loginUrl,
        loginRealm: _loginRealm,
        loginServername: _loginServername,
        loginBrowserUrl: _loginBrowserUrl,
        loginCertificate: _loginCertificate,
        waitTimeoutMs: _waitTimeoutMs,
        ...initialConn
      } = edgeB.config;
      const syncRes = await edgeB.rpc.handle({
        jsonrpc: "2.0",
        id: 301,
        method: "daemon.fleet.edge.sync",
        params: { payload: { ...initialConn, workspaceRoot: edgeB.edgeRoot, timeoutMs: 30_000 } },
      });
      assert.ok(syncRes && !Array.isArray(syncRes) && "result" in syncRes);
      assert.equal((syncRes.result as Record<string, unknown>).ok, true);
      assert.equal(
        await waitForFleetReplicaReady(
          { viewRoot: edgeB.viewRoot, repoId, nodeId: nodeBId },
          AbortSignal.timeout(30_000),
        ),
        true,
      );
      await waitForFleetReplicaRevision(
        { viewRoot: edgeB.viewRoot, repoId, nodeId: nodeBId },
        centerCut.revision,
        AbortSignal.timeout(30_000),
      );

      // Physically take old center offline!
      await oldCenter.center.close();
      await oldCenter.closeHost(oldCenter.host);

      // Bind a real local edge daemon JSON-RPC Unix socket server + real singleton lock (simulating active `ha gui`).
      const endpoint = localUserDaemonEndpoint(edgeB.edgeUser, daemonId);
      const singleton = await acquireDaemonSingleton({ userRoot: edgeB.edgeUser, daemonId, endpoint });
      assert.equal(singleton.claim, "acquired");
      releaseLock = singleton.release;

      let stopping = false;
      const transport = createUnixSocketTransportServer({
        daemonId,
        socketPath: endpoint,
        createProtocolServer: (authContext, emit) =>
          createJsonRpcProtocolServer({
            host: edgeB.host,
            build: { commit: null },
            authContext,
            emit,
            stopping: () => stopping,
            requestShutdown: () => {
              if (stopping) return;
              stopping = true;
              void (async () => {
                edgeB.rpc.close();
                await edgeB.host.close();
                await transport.stop();
                releaseLock?.();
                releaseLock = null;
              })();
            },
          }),
      });
      await transport.start();
      stopServer = async () => {
        if (!stopping) {
          stopping = true;
          edgeB.rpc.close();
          await edgeB.host.close();
          await transport.stop();
        }
        releaseLock?.();
        releaseLock = null;
      };
      assert.equal(await daemonSocketProbe(endpoint), true, "edge daemon socket must be live before break-glass");

      const port = createCenterSwitchPort({
        userRoot: () => edgeB.edgeUser,
        readOnly: () => false,
        daemonId: () => daemonId,
      });
      const { rawInvoke, preload } = wireCenterSettingsPreload(port);

      // Local edge state reads purely from disk with old center offline and omits credentials.
      const localState = await preload.edgeLocalState!({ repoId });
      assert.equal(localState.ok, true, JSON.stringify(localState));
      assert.equal(localState.mode, "remote-edge");
      assert.equal(localState.canPromote, true);
      assert.equal(localState.localRevision, centerCut.revision);
      assert.equal(JSON.stringify(localState).includes("secret-node-one"), false);

      // Negative control 1: direct CLI promote-from-edge without --stop-edge-daemon still refuses with edge_daemon_running.
      const rawCliAttempt = await relocateFleetCenter(
        [
          "fleet",
          "center",
          "promote-from-edge",
          "--root",
          edgeB.edgeRoot,
          "--repo",
          repoId,
          "--user-root",
          edgeB.edgeUser,
          "--state-root",
          path.join(edgeB.edgeUser, "fleet"),
          "--daemon-id",
          daemonId,
          "--force-new-epoch",
          "--confirm-possible-tail-loss",
        ],
        edgeB.edgeUser,
      );
      assert.equal(rawCliAttempt.exitCode, 2);
      assert.equal(rawCliAttempt.receipt.code, "edge_daemon_running");

      // Negative control 2: IPC rejects missing double confirmation WITHOUT stopping the running edge daemon.
      await assert.rejects(
        rawInvoke({
          operation: "promote-from-edge",
          repoId,
          forceNewEpoch: true,
          confirmPossibleTailLoss: false,
        }),
        /forceNewEpoch=true and confirmPossibleTailLoss=true/u,
      );
      assert.equal(await daemonSocketProbe(endpoint), true, "failed confirmation must not stop local edge daemon");

      // Positive: real GUI desktop break-glass continuation stops edge daemon -> promotes with history rotation -> switches registry to local!
      const promoted = await preload.promoteFromEdge!({
        repoId,
        forceNewEpoch: true,
        confirmPossibleTailLoss: true,
        rbacBackupStatus: "unknown",
      });
      assert.equal(promoted.ok, true, JSON.stringify(promoted));
      assert.equal(promoted.stoppedEdgeDaemon, true);
      assert.equal(promoted.registryMode, "local");
      assert.equal(promoted.newEpoch, centerCut.writerEpoch + 1);
      assert.ok(promoted.replicationHistory && promoted.replicationHistory !== centerCut.history);
      assert.equal(promoted.rbacBackupStatus, "unknown");
      assert.deepEqual(promoted.nextSteps, [
        "restart_daemon",
        "restore_or_verify_rbac",
        "start_center_listener",
        "repoint_other_edges",
      ]);

      // Verify post-conditions on disk & daemon runtime.
      assert.equal(await daemonSocketProbe(endpoint), false, "edge daemon socket must be stopped after promotion");
      assert.equal(
        readDaemonRegistry({ userRoot: edgeB.edgeUser }).repos.find((r) => r.repoId === repoId)?.mode,
        "local",
        "local daemon registry must be switched to local",
      );
      const promotedLedger = readLedgerSnapshot(
        path.join(edgeB.edgeRoot, ".harness", "store", "generations", "3", "ledger.sqlite"),
      );
      assert.equal(promotedLedger.history, promoted.replicationHistory);
      assert.notEqual(promotedLedger.history, centerCut.history);
      assert.equal(promotedLedger.writerEpoch, promoted.newEpoch);
      assert.equal(promotedLedger.revision, centerCut.revision);

      const auditPath = path.join(edgeB.edgeUser, "fleet", "governance", "center-emergency-promoted", `${repoId}.json`);
      assert.equal(existsSync(auditPath), true);
      const audit = JSON.parse(readFileSync(auditPath, "utf8")) as Record<string, unknown>;
      assert.equal(audit.forceNewEpoch, true);
      assert.equal(audit.possibleTailLossConfirmed, true);
    } finally {
      if (stopServer) await stopServer();
      releaseLock?.();
    }
  });
}, 180_000);
