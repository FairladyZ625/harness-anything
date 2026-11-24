// @vitest-environment node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import https from "node:https";
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
  requestDaemonJsonRpcAt,
} from "@harness-anything/daemon/client";
import { requestDaemonShutdownAt } from "../../daemon/src/daemon-host/client/local-json-rpc-shutdown.ts";
import {
  acquireDaemonProcessLock,
  acquireDaemonSingleton,
  daemonSocketProbe,
} from "@harness-anything/daemon/internal/daemon-singleton";
import {
  activateRemoteSwitchoverClient,
  centerSwitchoverCandidatePath,
  centerSymmetricIdentityPath,
  invalidateRemoteSwitchoverClient,
  prepareCenterSwitchoverCandidate,
  prepareCenterSymmetricIdentity,
  readCenterSwitchoverCandidate,
  relocateFleetCenter,
  signSwitchoverCededProof,
} from "@harness-anything/daemon/internal/fleet/center";
import { readDaemonRegistry, writeDaemonRegistryRepo } from "@harness-anything/kernel/daemon-registry";
import { openPersistentWriterEpoch, openReplicationSlots } from "@harness-anything/storage";
import { auth } from "../../daemon/test/daemon-host-recovery.fixture.ts";
import { fleetEdgeHostFixture } from "../../daemon/test/fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture } from "../../daemon/test/fleet-node-claim.fixtures.ts";
import {
  waitForFleetReplicaReady,
  waitForFleetReplicaRevision,
} from "../../daemon/src/daemon-host/fleet/replica-sync.ts";
import { measureSwitchoverRemoteActivationTransfer } from "../../daemon/src/daemon-host/fleet/center-switchover-transport.ts";
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

function createSelfSignedCert(
  directory: string,
  commonName = "localhost",
  san = `DNS:${commonName},IP:127.0.0.1`,
): {
  readonly keyPath: string;
  readonly certPath: string;
  readonly keyPem: string;
  readonly certPem: string;
  readonly spkiSha256: string;
} {
  mkdirSync(directory, { recursive: true });
  const keyPath = path.join(directory, `${commonName.replace(/[^a-z0-9.-]/giu, "_")}.key`);
  const certPath = path.join(directory, `${commonName.replace(/[^a-z0-9.-]/giu, "_")}.crt`);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      `/CN=${commonName}`,
      "-days",
      "1",
      "-addext",
      `subjectAltName=${san}`,
    ],
    { stdio: "ignore" },
  );
  const keyPem = readFileSync(keyPath, "utf8");
  const certPem = readFileSync(certPath, "utf8");
  return { keyPath, certPath, keyPem, certPem, spkiSha256: spkiSha256FromCertPem(Buffer.from(certPem, "utf8")) };
}

async function waitForCondition<T>(
  probe: () => T | null | undefined,
  timeoutMs: number,
  description: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== null && value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description} after ${String(timeoutMs)}ms.`);
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

async function startLiveDaemonSocketServer(input: {
  readonly userRoot: string;
  readonly daemonId: string;
  readonly host: Parameters<typeof createJsonRpcProtocolServer>[0]["host"];
  readonly onShutdown?: () => Promise<void>;
}) {
  const endpoint = localUserDaemonEndpoint(input.userRoot, input.daemonId);
  const singleton = await acquireDaemonSingleton({ userRoot: input.userRoot, daemonId: input.daemonId, endpoint });
  assert.equal(singleton.claim, "acquired");
  let releaseLock: (() => void) | null = singleton.release;
  let stopping = false;
  const transport = createUnixSocketTransportServer({
    daemonId: input.daemonId,
    socketPath: endpoint,
    createProtocolServer: (authContext, emit) =>
      createJsonRpcProtocolServer({
        host: input.host,
        build: { commit: null },
        authContext,
        emit,
        stopping: () => stopping,
        requestShutdown: () => {
          if (stopping) return;
          stopping = true;
          void (async () => {
            await input.onShutdown?.();
            await transport.stop();
            releaseLock?.();
            releaseLock = null;
          })();
        },
      }),
  });
  await transport.start();
  return {
    endpoint,
    stop: async () => {
      if (!stopping) {
        stopping = true;
        await transport.stop();
      }
      releaseLock?.();
      releaseLock = null;
    },
  };
}

it("F1/F3/F4/F10: real GUI centerSwitchPort executes live cross-host two-daemon TLS A->B->A round-trip, enforces zero-write dry-run on BOTH hosts, and binds rollback to immutable Phase 1 authority", async () => {
  await withCleanupContext(async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-gui-cross-host-switch-"));
    const repoId = "lease-repo";
    const nodeAId = "node-two";
    const nodeBId = "node-one";
    const daemonIdA = "lease-center";
    const daemonIdB = "edge-daemon";
    const nodeAViewRoot = path.join(root, "node-a-views-not-created-yet");
    let daemonSocketA: Awaited<ReturnType<typeof startLiveDaemonSocketServer>> | null = null;
    let daemonSocketB: Awaited<ReturnType<typeof startLiveDaemonSocketServer>> | null = null;

    try {
      // 1. Live Center Daemon A running its OWN real host-managed Fleet TLS listener (saving center.json for F1/F8).
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
      await nodeA.center.close();
      const certA = createSelfSignedCert(path.join(nodeA.userRoot, "center-a-cert"));
      writeFileSync(path.join(nodeA.root, "tls.crt"), certA.certPem, "utf8");
      writeFileSync(path.join(nodeA.root, "tls.key"), certA.keyPem, "utf8");
      nodeA.owners.keycloak.node(nodeAId, "person-one", `secret-${nodeAId}`);
      nodeA.owners.signIn(nodeA.userRoot, nodeAId, nodeA.repo);

      const startA = await nodeA.host.fleet.startCenter(
        {
          port: 0,
          bind: "127.0.0.1",
          keyPath: certA.keyPath,
          certPath: certA.certPath,
          repoId,
          quotaBytes: 64 * 1024 * 1024,
        },
        auth,
      );
      assert.equal(startA.ok, true, JSON.stringify(startA));
      const centerPortA = Number(startA.port);
      assert.ok(centerPortA > 0);

      daemonSocketA = await startLiveDaemonSocketServer({
        userRoot: nodeA.userRoot,
        daemonId: daemonIdA,
        host: nodeA.host,
      });

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
        (await nodeA.host.run(repoId, { kind: "task-create", taskId: "gui-sw-1", title: "Task 1 on A" }, auth)).outcome,
        "applied",
      );
      const ledgerAPath = path.join(nodeA.repo, ".harness", "store", "generations", "3", "ledger.sqlite");
      const cutA = readLedgerSnapshot(ledgerAPath);
      assert.ok(cutA.revision > 0);
      assert.ok(cutA.writerEpoch >= 1);

      // 2. Live independent Edge Daemon B on its OWN private disk, synced over Fleet TLS from Center A.
      const edgeB = await fleetEdgeHostFixture(
        t,
        { ...nodeA, center: { port: centerPortA } },
        {
          nodeId: nodeBId,
          beforeOpen: (_edgeRoot, edgeUser) => {
            nodeA.owners.bind(edgeUser);
          },
        },
      );
      daemonSocketB = await startLiveDaemonSocketServer({
        userRoot: edgeB.edgeUser,
        daemonId: daemonIdB,
        host: edgeB.host,
      });
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
        params: {
          payload: {
            ...initialConn,
            workspaceRoot: edgeB.edgeRoot,
            timeoutMs: 30_000,
          },
        },
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

      // F10 setup: pre-populate an existing writer-epochs SQLite DB on Candidate B (simulating a former center)
      // and pin both file & directory mtime so we can prove dry-run makes ZERO writes on Target B!
      const targetEpochsDir = path.join(edgeB.edgeUser, "fleet", "writer-epochs");
      const targetEpochDbPath = path.join(targetEpochsDir, `${repoId}.sqlite`);
      const preSeededB = openPersistentWriterEpoch({
        stateRoot: path.join(edgeB.edgeUser, "fleet"),
        holderId: "prior-b-center",
      });
      preSeededB.acquire(repoId, 0);
      preSeededB.close();
      utimesSync(targetEpochDbPath, pinnedTime, pinnedTime);
      utimesSync(targetEpochsDir, pinnedTime, pinnedTime);
      const targetEpochEntriesBefore = readdirSync(targetEpochsDir).sort();
      const targetEpochBytesBefore = readFileSync(targetEpochDbPath);
      const targetEpochMtimeBefore = statSync(targetEpochDbPath).mtimeMs;
      const targetEpochsDirMtimeBefore = statSync(targetEpochsDir).mtimeMs;

      // 3. F1 real runtime provisioning: Candidate B starts its OWN standby Fleet TLS listener with its own cert.
      const certB = createSelfSignedCert(path.join(edgeB.edgeUser, "candidate-cert"));
      const startB = await edgeB.host.fleet.startCenter(
        {
          port: 0,
          bind: "127.0.0.1",
          keyPath: certB.keyPath,
          certPath: certB.certPath,
          repoId,
          quotaBytes: 64 * 1024 * 1024,
        },
        auth,
      );
      assert.equal(startB.ok, true, JSON.stringify(startB));
      const candidatePortB = Number(startB.port);
      assert.ok(candidatePortB > 0);

      // Verify Center A received B's real network-only candidate record with ZERO target filesystem paths!
      const registeredCandidate = readCenterSwitchoverCandidate(nodeA.userRoot, repoId, nodeBId);
      assert.ok(registeredCandidate !== null, "F1: Candidate B must auto-register onto Center A over Fleet TLS");
      assert.equal(registeredCandidate.targetExternalUrl, `https://127.0.0.1:${String(candidatePortB)}`);
      assert.equal(registeredCandidate.targetLoginUrl, nodeA.owners.url);
      assert.equal(registeredCandidate.targetSpkiSha256, certB.spkiSha256);
      assert.equal(registeredCandidate.targetRoot, undefined);
      assert.equal(registeredCandidate.targetUserRoot, undefined);
      assert.equal(registeredCandidate.targetStateRoot, undefined);

      let readOnlyMode = true;
      const port = createCenterSwitchPort({
        userRoot: () => nodeA.userRoot,
        readOnly: () => readOnlyMode,
        daemonId: () => daemonIdA,
      });
      const { preload } = wireCenterSettingsPreload(port);

      // 4. F4 + F10 + F1 positive: read-only GUI dry-run probes live Daemon B with ZERO disk writes on BOTH A and B!
      const dryRunReply = await preload.centerSwitch!({
        repoId,
        targetNodeId: nodeBId,
        dryRun: true,
      });
      assert.equal(dryRunReply.ok, true, JSON.stringify(dryRunReply));
      assert.equal(dryRunReply.dryRun, true);
      assert.equal(dryRunReply.preflight?.ok, true, JSON.stringify(dryRunReply.preflight));
      assert.equal(readFileSync(identityPath, "utf8"), identityBytesBefore, "F4: dry-run must not rewrite identity");
      assert.equal(statSync(identityPath).mtimeMs, identityMtimeBefore, "F4: dry-run must preserve identity mtime");
      assert.equal(existsSync(nodeAViewRoot), false, "F4: dry-run must not mkdirp missing viewRoot");
      assert.deepEqual(
        readdirSync(targetEpochsDir).sort(),
        targetEpochEntriesBefore,
        "F10: dry-run on target with existing writer-epochs DB must not create -wal/-shm files",
      );
      assert.equal(
        Buffer.compare(readFileSync(targetEpochDbPath), targetEpochBytesBefore),
        0,
        "F10: target writer-epochs DB bytes must be unchanged",
      );
      assert.equal(
        statSync(targetEpochDbPath).mtimeMs,
        targetEpochMtimeBefore,
        "F10: target writer-epochs DB mtime must be unchanged",
      );
      assert.equal(
        statSync(targetEpochsDir).mtimeMs,
        targetEpochsDirMtimeBefore,
        "F10: target writer-epochs directory mtime must be unchanged",
      );

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

      // F1 negative: unconfigured candidate NEVER falls back to source host!
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

      // 5. F3 + F8 positive over live cross-host TLS (audited rollback using durably signed Phase 1 cededProof):
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
          "--daemon-id",
          daemonIdA,
          "--to",
          nodeBId,
          "--switchover-id",
          swRollbackId,
        ],
        nodeA.userRoot,
        {
          switchover: {
            beforeTargetActivation: async () => {
              throw Object.assign(new Error("simulated crash after Phase 1 fence"), { code: "simulated_p1_crash" });
            },
          },
        },
      );
      assert.equal(fencedOutcome.receipt.ok, false, JSON.stringify(fencedOutcome.receipt));
      assert.equal(fencedOutcome.receipt.fencedCeded, true, JSON.stringify(fencedOutcome.receipt));

      await daemonSocketA.stop();
      daemonSocketA = null;
      await nodeA.closeHost(nodeA.host);

      // Audited rollback via REAL GUI preload dials LIVE Candidate B with signed cededProof (`fleet.switchover.invalidate/v1`)!
      const rollbackReply = await preload.centerSwitch!({
        repoId,
        abortRollback: true,
        switchoverId: swRollbackId,
        reason: "Verified live target B never activated over TLS",
      });
      assert.equal(rollbackReply.ok, true, JSON.stringify(rollbackReply));
      assert.equal(rollbackReply.phase, "aborted_rolled_back");
      assert.equal(rollbackReply.rollback?.rollbackEpoch, cutA.writerEpoch + 2);
      const invalidatedPathB = path.join(edgeB.edgeUser, "fleet", "switchover-invalidated", `${repoId}.json`);
      assert.equal(existsSync(invalidatedPathB), true);
      assert.ok(readFileSync(invalidatedPathB, "utf8").includes(swRollbackId));

      // Reopen live Center A at oldEpoch + 2 (automatically restores A's Fleet TLS center from center.json!).
      const hostA2 = await nodeA.openHost();
      daemonSocketA = await startLiveDaemonSocketServer({
        userRoot: nodeA.userRoot,
        daemonId: daemonIdA,
        host: hostA2,
      });

      const postRbWrite = await hostA2.run(
        repoId,
        { kind: "task-create", taskId: "sw-post-rollback", title: "Post rollback write at oldEpoch+2" },
        auth,
      );
      assert.equal(postRbWrite.outcome, "applied", JSON.stringify(postRbWrite));
      const cutAfterRb = readLedgerSnapshot(ledgerAPath);
      assert.ok(cutAfterRb.revision > cutA.revision);
      assert.ok(cutAfterRb.writerEpoch >= cutA.writerEpoch + 2);
      const epochBeforeLive = cutAfterRb.writerEpoch;
      await waitForFleetReplicaRevision(
        { viewRoot: edgeB.viewRoot, repoId, nodeId: nodeBId },
        cutAfterRb.revision,
        AbortSignal.timeout(30_000),
      );

      // 6. F1 LIVE CROSS-HOST ROUND-TRIP: A -> B -> A WHILE BOTH DAEMONS REMAIN CONTINUOUSLY RUNNING!
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
      );
      assert.equal(
        readDaemonRegistry({ userRoot: nodeA.userRoot }).repos.find((r) => r.repoId === repoId)?.mode,
        "remote-edge",
      );
      const promotedB = readLedgerSnapshot(
        path.join(edgeB.edgeRoot, ".harness", "store", "generations", "3", "ledger.sqlite"),
      );
      assert.equal(promotedB.history, cutA.history);
      assert.equal(promotedB.writerEpoch, epochBeforeLive + 1);

      // Live write on New Center B -> Demoted live Daemon A replicates it immediately!
      const writeOnNewCenterB = await edgeB.host.run(
        repoId,
        { kind: "task-create", taskId: "sw-written-on-b", title: "Live write on New Center B" },
        auth,
      );
      assert.equal(writeOnNewCenterB.outcome, "applied", JSON.stringify(writeOnNewCenterB));
      const cutAfterBWrite = readLedgerSnapshot(
        path.join(edgeB.edgeRoot, ".harness", "store", "generations", "3", "ledger.sqlite"),
      );
      assert.ok(cutAfterBWrite.revision > cutAfterRb.revision);
      assert.equal(
        await waitForFleetReplicaReady(
          { viewRoot: nodeAViewRoot, repoId, nodeId: nodeAId },
          AbortSignal.timeout(30_000),
        ),
        true,
      );
      await waitForFleetReplicaRevision(
        { viewRoot: nodeAViewRoot, repoId, nodeId: nodeAId },
        cutAfterBWrite.revision,
        AbortSignal.timeout(30_000),
      );

      // F1 REVERSE CANDIDATE AUTO-PROVISIONING: Demoted Daemon A (keeping its existing TLS listener running!)
      // automatically registers itself as a network-only switchover candidate on New Center B!
      const reverseCandidateA = await waitForCondition(
        () => readCenterSwitchoverCandidate(edgeB.edgeUser, repoId, nodeAId),
        15_000,
        "F1: demoted live Daemon A auto-registering as candidate on Center B",
      );
      assert.equal(reverseCandidateA.targetExternalUrl, `https://127.0.0.1:${String(centerPortA)}`);
      assert.equal(reverseCandidateA.targetSpkiSha256, certA.spkiSha256);
      assert.equal(reverseCandidateA.targetRoot, undefined, "F1: Center B must NOT hold A's local targetRoot");
      assert.equal(reverseCandidateA.targetUserRoot, undefined);
      assert.equal(reverseCandidateA.targetStateRoot, undefined);

      // Use the EXACT SAME GUI createCenterSwitchPort on Center B to preflight & switchback B -> A!
      const portB = createCenterSwitchPort({
        userRoot: () => edgeB.edgeUser,
        readOnly: () => false,
        daemonId: () => daemonIdB,
      });
      const { preload: preloadB } = wireCenterSettingsPreload(portB);
      const dryRunBA = await preloadB.centerSwitch!({ repoId, targetNodeId: nodeAId, dryRun: true });
      assert.equal(dryRunBA.ok, true, JSON.stringify(dryRunBA));
      assert.equal(dryRunBA.preflight?.ok, true, JSON.stringify(dryRunBA.preflight));

      const swBackId = "sw_gui_live_ba";
      const liveBackReply = await preloadB.centerSwitch!({
        repoId,
        targetNodeId: nodeAId,
        dryRun: false,
        switchoverId: swBackId,
      });
      assert.equal(liveBackReply.ok, true, JSON.stringify(liveBackReply));
      assert.equal(liveBackReply.phase, "demoted_edge");
      assert.equal(liveBackReply.activation?.newEpoch, cutAfterBWrite.writerEpoch + 1);
      assert.equal(
        readDaemonRegistry({ userRoot: nodeA.userRoot }).repos.find((r) => r.repoId === repoId)?.mode,
        "local",
      );
      assert.equal(
        readDaemonRegistry({ userRoot: edgeB.edgeUser }).repos.find((r) => r.repoId === repoId)?.mode,
        "remote-edge",
      );
      const restoredA = readLedgerSnapshot(ledgerAPath);
      assert.equal(restoredA.history, cutA.history, "F1: round-trip A->B->A must preserve replication history");
      assert.equal(restoredA.writerEpoch, cutAfterBWrite.writerEpoch + 1);

      // Restored live Center A accepts a new write, and demoted live Daemon B immediately replicates it from A!
      const writeBackOnA = await hostA2.run(
        repoId,
        { kind: "task-create", taskId: "sw-back-on-a", title: "Live write after A->B->A round-trip" },
        auth,
      );
      assert.equal(writeBackOnA.outcome, "applied", JSON.stringify(writeBackOnA));
      const cutAfterRoundTrip = readLedgerSnapshot(ledgerAPath);
      assert.ok(cutAfterRoundTrip.revision > cutAfterBWrite.revision);
      await waitForFleetReplicaRevision(
        { viewRoot: edgeB.viewRoot, repoId, nodeId: nodeBId },
        cutAfterRoundTrip.revision,
        AbortSignal.timeout(30_000),
      );

      // 7. F3 HARD NEGATIVE CONTROL (tampered empty candidate directory must be ignored and untouched):
      const emptyTargetRoot = path.join(root, "tampered-empty-root");
      const emptyTargetUser = path.join(root, "tampered-empty-user");
      const emptyTargetState = path.join(emptyTargetUser, "fleet");
      mkdirSync(emptyTargetRoot, { recursive: true });
      mkdirSync(emptyTargetState, { recursive: true });
      prepareCenterSwitchoverCandidate(edgeB.edgeUser, {
        repoId,
        nodeId: nodeAId,
        targetExternalUrl: "https://127.0.0.1:1",
        targetLoginUrl: nodeA.owners.url,
        targetSpkiSha256: certA.spkiSha256,
        targetRoot: emptyTargetRoot,
        targetUserRoot: emptyTargetUser,
        targetStateRoot: emptyTargetState,
      });
      assert.equal(existsSync(centerSwitchoverCandidatePath(edgeB.edgeUser, repoId, nodeAId)), true);

      const fencePathB = path.join(edgeB.edgeUser, "fleet", "center-switchover-fence", `${repoId}.json`);
      const fenceB = JSON.parse(readFileSync(fencePathB, "utf8")) as Record<string, unknown>;
      writeFileSync(fencePathB, `${JSON.stringify({ ...fenceB, state: "fenced_ceded" }, null, 2)}\n`, "utf8");
      writeDaemonRegistryRepo({
        canonicalRoot: edgeB.edgeRoot,
        repoId,
        mode: "local",
        userRoot: edgeB.edgeUser,
        createConvenienceLinks: false,
      });

      const refusedRollback = await preloadB.centerSwitch!({
        repoId,
        abortRollback: true,
        switchoverId: swBackId,
        reason: "Must refuse rollback because original target A already activated",
      });
      assert.equal(refusedRollback.ok, false, JSON.stringify(refusedRollback));
      assert.equal(refusedRollback.code, "target_activation_not_disproven");
      assert.equal(existsSync(fencePathB), true);
      assert.equal((JSON.parse(readFileSync(fencePathB, "utf8")) as { readonly state?: string }).state, "fenced_ceded");
      assert.equal(existsSync(path.join(emptyTargetState, "writer-epochs", `${repoId}.sqlite`)), false);
      assert.equal(existsSync(path.join(emptyTargetState, "switchover-invalidated", `${repoId}.json`)), false);
      const fencedAuthorityB = openPersistentWriterEpoch({
        stateRoot: path.join(edgeB.edgeUser, "fleet"),
        holderId: "fenced-center-b-check",
      });
      try {
        assert.throws(() => fencedAuthorityB.acquire(repoId, cutAfterBWrite.writerEpoch), { code: "CENTER_MOVED" });
      } finally {
        fencedAuthorityB.close();
      }

      await daemonSocketB.stop();
      daemonSocketB = null;
      await daemonSocketA.stop();
      daemonSocketA = null;
      await nodeA.closeHost(hostA2);
    } finally {
      if (daemonSocketB) await daemonSocketB.stop();
      if (daemonSocketA) await daemonSocketA.stop();
      removeTempRepository(root);
    }
  });
}, 180_000);

it("F2/F7: real GUI promoteFromEdge stops live edge daemon, rotates history, switches to local, and F7 retries from stale window/IPC refuse WITHOUT stopping healthy local center daemon", async () => {
  await withCleanupContext(async (t) => {
    const repoId = "lease-repo";
    const nodeBId = "node-one";
    const daemonId = "edge-desktop-live";
    let runningServer: Awaited<ReturnType<typeof startLiveDaemonSocketServer>> | null = null;
    let promotedCenterServer: Awaited<ReturnType<typeof startLiveDaemonSocketServer>> | null = null;

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
      runningServer = await startLiveDaemonSocketServer({
        userRoot: edgeB.edgeUser,
        daemonId,
        host: edgeB.host,
        onShutdown: async () => {
          edgeB.rpc.close();
          await edgeB.host.close();
        },
      });
      const endpoint = runningServer.endpoint;
      assert.equal(await daemonSocketProbe(endpoint), true, "edge daemon socket must be live before break-glass");

      const port = createCenterSwitchPort({
        userRoot: () => edgeB.edgeUser,
        readOnly: () => false,
        daemonId: () => daemonId,
      });
      const window1 = wireCenterSettingsPreload(port);
      const window2 = wireCenterSettingsPreload(port);

      // Local edge state reads purely from disk with old center offline and omits credentials.
      const localState = await window1.preload.edgeLocalState!({ repoId });
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
        window1.rawInvoke({
          operation: "promote-from-edge",
          repoId,
          forceNewEpoch: true,
          confirmPossibleTailLoss: false,
        }),
        /forceNewEpoch=true and confirmPossibleTailLoss=true/u,
      );
      assert.equal(await daemonSocketProbe(endpoint), true, "failed confirmation must not stop local edge daemon");

      // Positive: real GUI desktop break-glass continuation stops edge daemon -> promotes with history rotation -> switches registry to local!
      const promoted = await window1.preload.promoteFromEdge!({
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
      runningServer = null;
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

      // Local edge state now reports canPromote === false!
      const localStateAfter = await window2.preload.edgeLocalState!({ repoId });
      assert.equal(localStateAfter.ok, true);
      assert.equal(localStateAfter.mode, "local");
      assert.equal(localStateAfter.canPromote, false);

      // F7 NEGATIVE CONTROL:
      // Operator restarts the promoted daemon in healthy `local` center mode on the same daemonId/socket!
      // A stale second GUI window AND a direct `--stop-edge-daemon` CLI/IPC retry BOTH submit break-glass promotion;
      // BOTH MUST be rejected BEFORE stopping the daemon, and the healthy local center daemon socket MUST remain online!
      const { openDaemonHost } = await import("../../daemon/src/daemon-host/daemon-host.ts");
      const promotedHost = await openDaemonHost({
        daemonId,
        userRoot: edgeB.edgeUser,
      });
      t.after(() => promotedHost.close());
      await promotedHost.attachmentsSettled();

      let unexpectedStopRequested = false;
      promotedCenterServer = await startLiveDaemonSocketServer({
        userRoot: edgeB.edgeUser,
        daemonId,
        host: promotedHost,
        onShutdown: async () => {
          unexpectedStopRequested = true;
        },
      });
      assert.equal(await daemonSocketProbe(endpoint), true, "healthy local center daemon must be online");

      // Stale GUI window #2 submits duplicate break-glass promotion via preload IPC.
      const staleWindowRetry = await window2.preload.promoteFromEdge!({
        repoId,
        forceNewEpoch: true,
        confirmPossibleTailLoss: true,
      });
      assert.equal(staleWindowRetry.ok, false, JSON.stringify(staleWindowRetry));
      assert.equal(staleWindowRetry.code, "repo_not_remote_edge");
      assert.equal(unexpectedStopRequested, false, "F7: stale GUI window retry MUST NOT send daemon.stop");
      assert.equal(await daemonSocketProbe(endpoint), true, "F7: healthy local center socket must remain online");

      // Direct daemon command boundary retry with `--stop-edge-daemon --switch-to-local` MUST ALSO refuse without stopping!
      const directCommandRetry = await relocateFleetCenter(
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
          "--stop-edge-daemon",
          "--switch-to-local",
        ],
        edgeB.edgeUser,
      );
      assert.equal(directCommandRetry.exitCode, 2, JSON.stringify(directCommandRetry.receipt));
      assert.equal(directCommandRetry.receipt.code, "already_promoted");
      assert.equal(unexpectedStopRequested, false, "F7: daemon command retry MUST NOT send daemon.stop");
      assert.equal(await daemonSocketProbe(endpoint), true, "F7: healthy local center socket must remain online");

      // F7 CROSS-PROCESS ATOMIC PRECONDITION + REAL DUAL-PROCESS RACE:
      // 1) Even if a racing second process already passed its pre-stop checks before the promoted center restarted,
      //    sending `daemon.stop` with `expectedRepoMode: { repoId, mode: "remote-edge" }` is atomically refused by
      //    the running `local` center daemon without initiating shutdown!
      const atomicRefusal = await requestDaemonShutdownAt(endpoint, 5_000, 5_000, {
        expectedRepoMode: { repoId, mode: "remote-edge" },
      });
      assert.equal(atomicRefusal.stopReply?.ok, false, JSON.stringify(atomicRefusal));
      assert.equal(atomicRefusal.stopReply?.code, "repo_not_remote_edge", JSON.stringify(atomicRefusal));
      assert.equal(
        unexpectedStopRequested,
        false,
        "F7: atomic expectedRepoMode mismatch MUST NOT stop healthy local center",
      );
      assert.equal(await daemonSocketProbe(endpoint), true, "F7: healthy local center socket must remain online");

      // 2) Real separate OS child process competing under cross-process promotion lock AND against the healthy local center:
      const relocationModuleUrl = new URL(
        "../../daemon/src/daemon-host/fleet/center-relocation-command.ts",
        import.meta.url,
      ).href;
      const runChildPromote = async (): Promise<{ readonly exitCode: number; readonly code?: string }> =>
        await new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `import { relocateFleetCenter } from ${JSON.stringify(relocationModuleUrl)};
               const out = await relocateFleetCenter(${JSON.stringify([
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
                 "--stop-edge-daemon",
                 "--switch-to-local",
               ])}, ${JSON.stringify(edgeB.edgeUser)});
               process.stdout.write(JSON.stringify({ exitCode: out.exitCode, code: out.receipt.code }));`,
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let stdout = "",
            stderr = "";
          child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
          });
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });
          child.once("error", reject);
          child.once("close", (code) => {
            if (code !== 0) reject(new Error(`Child promote exited ${String(code)}: ${stderr}`));
            else resolve(JSON.parse(stdout) as { readonly exitCode: number; readonly code?: string });
          });
        });

      const promotionLockPath = path.join(path.dirname(auditPath), `.${repoId}.promote.lock`);
      const heldLock = await acquireDaemonProcessLock(promotionLockPath);
      assert.equal(heldLock.owner, true);
      try {
        const lockedChildResult = await runChildPromote();
        assert.equal(lockedChildResult.exitCode, 2, JSON.stringify(lockedChildResult));
        assert.equal(lockedChildResult.code, "promotion_in_progress", JSON.stringify(lockedChildResult));
      } finally {
        heldLock.release();
      }
      const racingChildResult = await runChildPromote();
      assert.equal(racingChildResult.exitCode, 2, JSON.stringify(racingChildResult));
      assert.equal(racingChildResult.code, "already_promoted", JSON.stringify(racingChildResult));
      assert.equal(unexpectedStopRequested, false, "F7: racing child process MUST NOT stop healthy local center");
      assert.equal(await daemonSocketProbe(endpoint), true, "F7: healthy local center socket must remain online");

      // Prove the healthy local center daemon socket is actively serving JSON-RPC requests!
      const liveStatus = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 5_000, 5_000);
      assert.equal(liveStatus.daemonId, daemonId, JSON.stringify(liveStatus));
      const statusRepos = Array.isArray(liveStatus.repos)
        ? (liveStatus.repos as readonly Record<string, unknown>[])
        : [];
      const promotedRepoStatus = statusRepos.find((r) => r.repoId === repoId);
      assert.equal(promotedRepoStatus?.mode, "local", JSON.stringify(promotedRepoStatus));
    } finally {
      if (promotedCenterServer) await promotedCenterServer.stop();
      if (runningServer) await runningServer.stop();
    }
  });
}, 180_000);

it("F8/F9/F11: target TLS rejects repository-read & forged ceded proofs, separates independent HTTPS IdP TLS trust, rejects untransferable payloads pre-Phase-1, and migrates >1024 replication slots in bounded batches", async () => {
  await withCleanupContext(async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-gui-f8-f9-f11-"));
    const repoId = "lease-repo";
    const nodeAId = "node-two";
    const nodeBId = "node-one";
    const readerNodeId = "node-reader-only";
    const daemonIdA = "lease-center";
    const nodeAViewRoot = path.join(root, "node-a-views");
    let daemonSocketA: Awaited<ReturnType<typeof startLiveDaemonSocketServer>> | null = null;
    let idpServer: https.Server | null = null;

    try {
      // 1. Live Center A with real host-managed Fleet TLS listener (distinct Fleet CA #1: fleet-a.example.test).
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
      await nodeA.center.close();
      const certA = createSelfSignedCert(
        path.join(nodeA.userRoot, "cert-a"),
        "fleet-a.example.test",
        "DNS:fleet-a.example.test,DNS:localhost,IP:127.0.0.1",
      );
      writeFileSync(path.join(nodeA.root, "tls.crt"), certA.certPem, "utf8");
      writeFileSync(path.join(nodeA.root, "tls.key"), certA.keyPem, "utf8");
      nodeA.owners.keycloak.node(nodeAId, "person-one", `secret-${nodeAId}`);
      nodeA.owners.signIn(nodeA.userRoot, nodeAId, nodeA.repo);

      // Register a pure repository-read user + node (NO daemon-fleet-center-switch permission!) for F8 negative control.
      nodeA.owners.keycloak.account("person-reader");
      nodeA.owners.keycloak.permit("person-reader", repoId, ["repository-read"]);
      nodeA.owners.keycloak.node(readerNodeId, "person-reader", `secret-${readerNodeId}`);
      nodeA.owners.keycloak.interactiveSession(
        "person-reader",
        readerNodeId,
        nodeA.owners.url,
        `device-token-${readerNodeId}`,
      );

      const startA = await nodeA.host.fleet.startCenter(
        {
          port: 0,
          bind: "127.0.0.1",
          keyPath: certA.keyPath,
          certPath: certA.certPath,
          repoId,
          quotaBytes: 64 * 1024 * 1024,
        },
        auth,
      );
      assert.equal(startA.ok, true, JSON.stringify(startA));
      const centerPortA = Number(startA.port);

      daemonSocketA = await startLiveDaemonSocketServer({
        userRoot: nodeA.userRoot,
        daemonId: daemonIdA,
        host: nodeA.host,
      });
      prepareCenterSymmetricIdentity(nodeA.userRoot, {
        repoId,
        nodeId: nodeAId,
        credential: `secret-${nodeAId}`,
        viewRoot: nodeAViewRoot,
        quotaBytes: 64 * 1024 * 1024,
      });

      assert.equal(
        (await nodeA.host.run(repoId, { kind: "task-create", taskId: "f8-9-11-seed", title: "Seed" }, auth)).outcome,
        "applied",
      );
      const ledgerAPath = path.join(nodeA.repo, ".harness", "store", "generations", "3", "ledger.sqlite");
      const cutA = readLedgerSnapshot(ledgerAPath);

      // 2. Live Candidate Edge B with its OWN Fleet cert (CA #2: fleet-b.example.test)
      //    AND an independent HTTPS IdP server with a COMPLETELY DIFFERENT CA (#3: idp.example.test)!
      const edgeB = await fleetEdgeHostFixture(
        t,
        { ...nodeA, center: { port: centerPortA } },
        {
          nodeId: nodeBId,
          beforeOpen: (_edgeRoot, edgeUser) => {
            nodeA.owners.bind(edgeUser);
          },
        },
      );
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
        id: 401,
        method: "daemon.fleet.edge.sync",
        params: { payload: { ...initialConn, workspaceRoot: edgeB.edgeRoot, timeoutMs: 30_000 } },
      });
      assert.equal((syncRes as { readonly result?: { readonly ok?: boolean } }).result?.ok, true);
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

      const certB = createSelfSignedCert(
        path.join(edgeB.edgeUser, "cert-fleet-b"),
        "fleet-b.example.test",
        "DNS:fleet-b.example.test,IP:127.0.0.1",
      );
      const startB = await edgeB.host.fleet.startCenter(
        {
          port: 0,
          bind: "127.0.0.1",
          keyPath: certB.keyPath,
          certPath: certB.certPath,
          repoId,
          quotaBytes: 64 * 1024 * 1024,
        },
        auth,
      );
      assert.equal(startB.ok, true, JSON.stringify(startB));
      const candidatePortB = Number(startB.port);

      // Start an independent HTTPS IdP server on 127.0.0.1 with its own CA & DNS name `idp.example.test`.
      const certIdp = createSelfSignedCert(
        path.join(root, "cert-idp"),
        "idp.example.test",
        "DNS:idp.example.test,IP:127.0.0.1",
      );
      idpServer = https.createServer({ key: certIdp.keyPem, cert: certIdp.certPem }, (_req, res) => {
        res.writeHead(200);
        res.end();
      });
      await new Promise<void>((resolve) => idpServer!.listen(0, "127.0.0.1", resolve));
      const idpAddress = idpServer.address() as { readonly port: number };
      const independentLoginUrl = `https://127.0.0.1:${String(idpAddress.port)}`;

      // F8 SECURITY CONTRACT TESTS against LIVE Candidate B:
      const validSignedProof = signSwitchoverCededProof({
        repoId,
        switchoverId: "sw_f8_auth_check",
        sourceNodeId: nodeAId,
        targetNodeId: nodeBId,
        oldEpoch: cutA.writerEpoch,
        cededEpoch: cutA.writerEpoch + 1,
        finalRevision: cutA.revision,
        tipHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        fencedAt: new Date().toISOString(),
        sourceKeyPem: certA.keyPem,
        sourceCertificatePem: certA.certPem,
      });
      const readerPeerOptions = {
        hostname: "127.0.0.1",
        port: candidatePortB,
        ca: certB.certPem,
        servername: "fleet-b.example.test",
        spkiSha256: certB.spkiSha256.slice("sha256:".length),
        nodeId: readerNodeId,
        credential: `secret-${readerNodeId}`,
        readAccessToken: async () => `device-token-${readerNodeId}`,
      };
      // F8.1: Pure repository-read principal calling activate MUST be hard-rejected with authorization_denied!
      await assert.rejects(
        activateRemoteSwitchoverClient(readerPeerOptions, {
          repoId,
          switchoverId: "sw_f8_auth_check",
          expectedTargetNodeId: nodeBId,
          expectedOldEpoch: cutA.writerEpoch,
          newEpoch: cutA.writerEpoch + 1,
          frozenCut: {
            repoId,
            finalRevision: cutA.revision,
            tipHash: validSignedProof.tipHash,
            history: cutA.history,
            sequence: cutA.revision,
          },
          sourceReplicationLogWindow: [],
          retentionWindowCommits: 100,
          cededProof: { ...validSignedProof, sourceNodeId: readerNodeId },
        }),
        (error: unknown) => {
          assert.equal((error as { readonly code?: unknown }).code, "authorization_denied", String(error));
          return true;
        },
      );
      // F8.2: Pure repository-read principal calling invalidate MUST be hard-rejected with authorization_denied!
      await assert.rejects(
        invalidateRemoteSwitchoverClient(readerPeerOptions, {
          repoId,
          switchoverId: "sw_f8_auth_check",
          expectedTargetNodeId: nodeBId,
          cededEpoch: cutA.writerEpoch + 1,
          cededProof: { ...validSignedProof, sourceNodeId: readerNodeId },
        }),
        (error: unknown) => {
          assert.equal((error as { readonly code?: unknown }).code, "authorization_denied", String(error));
          return true;
        },
      );
      // F8.3: Missing human admin session (replica machine / unauthenticated token) MUST be rejected!
      await assert.rejects(
        activateRemoteSwitchoverClient(
          {
            hostname: "127.0.0.1",
            port: candidatePortB,
            ca: certB.certPem,
            servername: "fleet-b.example.test",
            spkiSha256: certB.spkiSha256.slice("sha256:".length),
            nodeId: nodeAId,
            credential: `secret-${nodeAId}`,
          },
          {
            repoId,
            switchoverId: "sw_f8_auth_check",
            expectedTargetNodeId: nodeBId,
            expectedOldEpoch: cutA.writerEpoch,
            newEpoch: cutA.writerEpoch + 1,
            frozenCut: {
              repoId,
              finalRevision: cutA.revision,
              tipHash: validSignedProof.tipHash,
              history: cutA.history,
              sequence: cutA.revision,
            },
            sourceReplicationLogWindow: [],
            retentionWindowCommits: 100,
            cededProof: validSignedProof,
          },
        ),
        (error: unknown) => {
          assert.equal((error as { readonly code?: unknown }).code, "authentication_required", String(error));
          return true;
        },
      );
      // F8.4: Authorized admin with a forged cededProof (signed by untrusted certB key instead of Center A's key!) MUST be rejected!
      const forgedProof = signSwitchoverCededProof({
        repoId,
        switchoverId: "sw_f8_forged",
        sourceNodeId: nodeAId,
        targetNodeId: nodeBId,
        oldEpoch: cutA.writerEpoch,
        cededEpoch: cutA.writerEpoch + 1,
        finalRevision: cutA.revision,
        tipHash: validSignedProof.tipHash,
        fencedAt: new Date().toISOString(),
        sourceKeyPem: certB.keyPem,
        sourceCertificatePem: certB.certPem,
      });
      const adminPeerOptions = {
        hostname: "127.0.0.1",
        port: candidatePortB,
        ca: certB.certPem,
        servername: "fleet-b.example.test",
        spkiSha256: certB.spkiSha256.slice("sha256:".length),
        nodeId: nodeAId,
        credential: `secret-${nodeAId}`,
        readAccessToken: async () => `device-token-${nodeAId}`,
      };
      await assert.rejects(
        activateRemoteSwitchoverClient(adminPeerOptions, {
          repoId,
          switchoverId: "sw_f8_forged",
          expectedTargetNodeId: nodeBId,
          expectedOldEpoch: cutA.writerEpoch,
          newEpoch: cutA.writerEpoch + 1,
          frozenCut: {
            repoId,
            finalRevision: cutA.revision,
            tipHash: validSignedProof.tipHash,
            history: cutA.history,
            sequence: cutA.revision,
          },
          sourceReplicationLogWindow: [],
          retentionWindowCommits: 100,
          cededProof: forgedProof,
        }),
        (error: unknown) => {
          assert.equal((error as { readonly code?: unknown }).code, "switchover_ceded_proof_invalid", String(error));
          return true;
        },
      );
      await assert.rejects(
        invalidateRemoteSwitchoverClient(adminPeerOptions, {
          repoId,
          switchoverId: "sw_f8_forged",
          expectedTargetNodeId: nodeBId,
          cededEpoch: cutA.writerEpoch + 1,
          cededProof: forgedProof,
        }),
        (error: unknown) => {
          assert.equal((error as { readonly code?: unknown }).code, "switchover_ceded_proof_invalid", String(error));
          return true;
        },
      );
      // Target B must remain untouched in remote-edge mode!
      assert.equal(
        readDaemonRegistry({ userRoot: edgeB.edgeUser }).repos.find((r) => r.repoId === repoId)?.mode,
        "remote-edge",
      );

      // F9 SEPARATE HTTPS LOGIN TRUST TESTS (Fleet CA #2 `fleet-b.example.test` vs Independent IdP CA #3 `idp.example.test`):
      // Negative control: without loginCertificate, probing the untrusted self-signed IdP fails (Fleet cert is NOT forced onto IdP!).
      prepareCenterSwitchoverCandidate(nodeA.userRoot, {
        repoId,
        nodeId: nodeBId,
        targetExternalUrl: `https://127.0.0.1:${String(candidatePortB)}`,
        targetLoginUrl: independentLoginUrl,
        targetSpkiSha256: certB.spkiSha256,
        targetServername: "fleet-b.example.test",
      });
      const portA = createCenterSwitchPort({
        userRoot: () => nodeA.userRoot,
        readOnly: () => false,
        daemonId: () => daemonIdA,
      });
      const { preload: preloadA } = wireCenterSettingsPreload(portA);
      const untrustedIdpDryRun = await preloadA.centerSwitch!({ repoId, targetNodeId: nodeBId, dryRun: true });
      assert.equal(untrustedIdpDryRun.ok, false, JSON.stringify(untrustedIdpDryRun));
      assert.ok(
        untrustedIdpDryRun.preflight?.blockingCodes.includes("auth_surface_unreachable"),
        JSON.stringify(untrustedIdpDryRun.preflight),
      );

      // Positive control: with loginCertificate + loginServername for the independent IdP (`idp.example.test`, CA #3),
      // CH5 preflight PASSES even though Fleet uses a different CA (#2) and different DNS name (`fleet-b.example.test`)!
      prepareCenterSwitchoverCandidate(nodeA.userRoot, {
        repoId,
        nodeId: nodeBId,
        targetExternalUrl: `https://127.0.0.1:${String(candidatePortB)}`,
        targetLoginUrl: independentLoginUrl,
        targetSpkiSha256: certB.spkiSha256,
        targetServername: "fleet-b.example.test",
        targetLoginCertificate: certIdp.certPem,
        targetLoginServername: "idp.example.test",
      });
      const separateIdpDryRun = await preloadA.centerSwitch!({ repoId, targetNodeId: nodeBId, dryRun: true });
      assert.equal(separateIdpDryRun.ok, true, JSON.stringify(separateIdpDryRun));
      assert.equal(separateIdpDryRun.preflight?.ok, true, JSON.stringify(separateIdpDryRun.preflight));

      // F11 (>1024 REPLICATION SLOTS + PRE-CEDE TRANSFER VALIDATION):
      // Seed 1,030 replication slots on Source Center A (> 1024 old single-frame cap!).
      const sourceSlotsPath = path.join(nodeA.writerEpochStateRoot, "replication-slots.sqlite");
      const seededSlots = openReplicationSlots(sourceSlotsPath);
      const totalSeededSlots = 1030;
      try {
        for (let i = 0; i < totalSeededSlots; i += 1) {
          const slotNodeId = `edge-slot-${String(i).padStart(4, "0")}`;
          const lease = seededSlots.claim({ repoId, nodeId: slotNodeId }, cutA.history);
          seededSlots.acknowledge(
            lease,
            {
              durable: { history: cutA.history, sequence: cutA.revision, revision: cutA.revision },
              applied: { history: cutA.history, sequence: cutA.revision, revision: cutA.revision },
            },
            { history: cutA.history, sequence: cutA.revision, revision: cutA.revision },
          );
        }
      } finally {
        seededSlots.close();
      }

      // F11 negative control 1: validateSwitchoverRemoteActivationTransfer rejects >100,000 slots & >4096 log window!
      const oversizeLogRows = Array.from({ length: 4097 }, (_, idx) => ({
        sequence: idx,
        revision: idx,
        outcomeOpId: null,
        writerJson: null,
      }));
      const invalidTransfer = measureSwitchoverRemoteActivationTransfer({
        repoId,
        switchoverId: "sw_f11_oversize",
        expectedTargetNodeId: nodeBId,
        expectedOldEpoch: cutA.writerEpoch,
        newEpoch: cutA.writerEpoch + 1,
        frozenCut: {
          repoId,
          finalRevision: cutA.revision,
          tipHash: validSignedProof.tipHash,
          history: cutA.history,
          sequence: cutA.revision,
        },
        sourceReplicationLogWindow: oversizeLogRows,
        retentionWindowCommits: 5000,
        replicationSlots: [],
        cededProof: validSignedProof,
      });
      assert.equal(invalidTransfer.ok, false);

      // F11 negative control 2: an untransferable pre-Phase-1 failure (missing source TLS key for signing)
      // rejects BEFORE Phase 1 fence is written, leaving Source A unfenced and writable!
      const prePhase1Failure = await relocateFleetCenter(
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
          "--daemon-id",
          daemonIdA,
          "--to",
          nodeBId,
          "--source-key",
          path.join(root, "nonexistent.key"),
          "--switchover-id",
          "sw_f11_pre_cede_reject",
        ],
        nodeA.userRoot,
      );
      assert.equal(prePhase1Failure.receipt.ok, false, JSON.stringify(prePhase1Failure.receipt));
      assert.equal(
        prePhase1Failure.receipt.fencedCeded,
        undefined,
        "F11: pre-cede rejection MUST NOT leave source fenced",
      );
      assert.equal(
        existsSync(path.join(nodeA.userRoot, "fleet", "center-switchover-fence", `${repoId}.json`)),
        false,
        "F11: no Phase 1 fence file may exist after pre-cede rejection",
      );
      // Confirm Source A remains 100% writable!
      const postRejectWrite = await nodeA.host.run(
        repoId,
        { kind: "task-create", taskId: "f11-still-writable", title: "Writable after pre-cede reject" },
        auth,
      );
      assert.equal(postRejectWrite.outcome, "applied", JSON.stringify(postRejectWrite));
      const cutBefore1030 = readLedgerSnapshot(ledgerAPath);
      await waitForFleetReplicaRevision(
        { viewRoot: edgeB.viewRoot, repoId, nodeId: nodeBId },
        cutBefore1030.revision,
        AbortSignal.timeout(30_000),
      );

      // F8 + F9 + F11 POSITIVE: Authorized switchover with independent HTTPS IdP AND 1,030 (>1024) replication slots
      // succeeds cleanly via bounded batched staging (`fleet.switchover.slots.stage/v1`) + signed cededProof!
      const live1030 = await preloadA.centerSwitch!({
        repoId,
        targetNodeId: nodeBId,
        dryRun: false,
        switchoverId: "sw_f8_f9_f11_1030",
      });
      assert.equal(live1030.ok, true, JSON.stringify(live1030));
      assert.equal(live1030.phase, "demoted_edge");
      assert.equal(
        readDaemonRegistry({ userRoot: edgeB.edgeUser }).repos.find((r) => r.repoId === repoId)?.mode,
        "local",
      );

      // Verify ALL 1,030 replication slots (and their durable/applied ACKs) were migrated intact onto Target B!
      const targetSlotsPath = path.join(edgeB.edgeUser, "fleet", "replication-slots.sqlite");
      assert.equal(existsSync(targetSlotsPath), true, "F11: target must have migrated replication-slots.sqlite");
      const migratedSlots = openReplicationSlots(targetSlotsPath);
      try {
        const rows = migratedSlots.list().filter((row) => row.repoId === repoId);
        assert.ok(
          rows.length >= totalSeededSlots,
          `F11: expected >= ${String(totalSeededSlots)} slots, got ${String(rows.length)}`,
        );
        const firstSlot = rows.find((r) => r.nodeId === "edge-slot-0000");
        const lastSlot = rows.find((r) => r.nodeId === "edge-slot-1029");
        assert.ok(firstSlot && firstSlot.ack?.durable.revision === cutA.revision, JSON.stringify(firstSlot));
        assert.ok(lastSlot && lastSlot.ack?.applied.revision === cutA.revision, JSON.stringify(lastSlot));
      } finally {
        migratedSlots.close();
      }

      await daemonSocketA.stop();
      daemonSocketA = null;
    } finally {
      if (idpServer) await new Promise<void>((resolve) => idpServer!.close(() => resolve()));
      if (daemonSocketA) await daemonSocketA.stop();
      removeTempRepository(root);
    }
  });
}, 180_000);
