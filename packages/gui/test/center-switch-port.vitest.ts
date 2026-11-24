// @vitest-environment node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
import { acquireDaemonSingleton, daemonSocketProbe } from "@harness-anything/daemon/internal/daemon-singleton";
import {
  centerSwitchoverCandidatePath,
  centerSymmetricIdentityPath,
  prepareCenterSwitchoverCandidate,
  prepareCenterSymmetricIdentity,
  readCenterSwitchoverCandidate,
  relocateFleetCenter,
} from "@harness-anything/daemon/internal/fleet/center";
import { readDaemonRegistry, writeDaemonRegistryRepo } from "@harness-anything/kernel/daemon-registry";
import { openPersistentWriterEpoch } from "@harness-anything/storage";
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

function createSelfSignedCert(directory: string): {
  readonly keyPath: string;
  readonly certPath: string;
  readonly spkiSha256: string;
} {
  mkdirSync(directory, { recursive: true });
  const keyPath = path.join(directory, "candidate-tls.key");
  const certPath = path.join(directory, "candidate-tls.crt");
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
      "/CN=localhost",
      "-days",
      "1",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  return { keyPath, certPath, spkiSha256: spkiSha256FromCertPem(readFileSync(certPath)) };
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

it("F1/F3/F4: real GUI centerSwitchPort executes live cross-host two-daemon TLS switchover (zero shared disk paths), enforces zero-write dry-run, and binds rollback to immutable Phase 1 authority", async () => {
  await withCleanupContext(async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-gui-cross-host-switch-"));
    const repoId = "lease-repo";
    const nodeAId = "node-two";
    const nodeBId = "node-one";
    const daemonIdA = "node-a-live-gui";
    const nodeAViewRoot = path.join(root, "node-a-views-not-created-yet");
    let daemonSocketA: Awaited<ReturnType<typeof startLiveDaemonSocketServer>> | null = null;

    try {
      // 1. Live Center Daemon A (with real local Unix socket server so Phase 0 drain and Phase 3 live demotion execute against running Daemon A).
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
      nodeA.owners.signIn(nodeA.userRoot, nodeAId, nodeA.repo);

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
        (await nodeA.command("center-node", { kind: "task-create", taskId: "gui-sw-1", title: "Task 1 on A" })).outcome,
        "applied",
      );
      const ledgerAPath = path.join(nodeA.repo, ".harness", "store", "generations", "3", "ledger.sqlite");
      const cutA = readLedgerSnapshot(ledgerAPath);
      assert.ok(cutA.revision > 0);
      assert.ok(cutA.writerEpoch >= 1);

      // 2. Live independent Edge Daemon B on its OWN private disk, synced over Fleet TLS from Center A.
      const edgeB = await fleetEdgeHostFixture(t, nodeA, {
        nodeId: nodeBId,
        beforeOpen: (_edgeRoot, edgeUser) => {
          // Bind candidate B to the shared independent Keycloak login surface (dec_AAEC26DBB6F23BDF80876ABB2C CH5 Mode 1).
          nodeA.owners.bind(edgeUser);
        },
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

      // 3. F1 real runtime provisioning: Candidate B starts its OWN standby Fleet TLS listener with its own cert.
      // Daemon B automatically announces its external URL, login URL, and SPKI to Center A over authenticated Fleet TLS!
      // Notice: this test NEVER calls prepareCenterSwitchoverCandidate and NEVER gives Center A any of B's disk paths!
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
      assert.equal(registeredCandidate.targetRoot, undefined, "F1: Center A must NOT hold B's local targetRoot");
      assert.equal(
        registeredCandidate.targetUserRoot,
        undefined,
        "F1: Center A must NOT hold B's local targetUserRoot",
      );
      assert.equal(
        registeredCandidate.targetStateRoot,
        undefined,
        "F1: Center A must NOT hold B's local targetStateRoot",
      );

      let readOnlyMode = true;
      const port = createCenterSwitchPort({
        userRoot: () => nodeA.userRoot,
        readOnly: () => readOnlyMode,
        daemonId: () => daemonIdA,
      });
      const { preload } = wireCenterSettingsPreload(port);

      // 4. F4 + F1 positive: read-only GUI dry-run probes live Daemon B over SPKI-pinned TLS with ZERO disk writes on A!
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

      // 5. F3 positive over live cross-host TLS:
      // Simulate crash after Phase 1 fence persisted on A (target B never activated).
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

      // Pause A's local center writers briefly only to commit oldEpoch+2 rollback cleanly, while Candidate B stays LIVE!
      await daemonSocketA.stop();
      daemonSocketA = null;
      await nodeA.center.close();
      await nodeA.closeHost(nodeA.host);

      // Audited rollback via REAL GUI preload dials LIVE Candidate B over SPKI-pinned TLS (`fleet.switchover.invalidate/v1`)!
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
      assert.equal(
        existsSync(invalidatedPathB),
        true,
        "F3: live target B must durably persist invalidation on B's disk",
      );
      assert.ok(readFileSync(invalidatedPathB, "utf8").includes(swRollbackId));

      // Reopen live Center A at oldEpoch + 2 (with live Unix socket server) and write a post-rollback task;
      // BOTH Daemon A and Daemon B remain LIVE through the entire live switchover!
      const hostA2 = await nodeA.openHost();
      const centerA2 = await nodeA.openCenter(hostA2, nodeA.center.port);
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

      // 6. F1 LIVE CROSS-HOST SWITCHOVER A -> B WHILE BOTH DAEMONS REMAIN RUNNING!
      // Neither Daemon A nor Daemon B is stopped, and Source A has ZERO knowledge of B's filesystem paths!
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
        "F1: live target B must switch to local center mode",
      );
      assert.equal(
        readDaemonRegistry({ userRoot: nodeA.userRoot }).repos.find((r) => r.repoId === repoId)?.mode,
        "remote-edge",
        "F1: live source A must demote to remote-edge mode",
      );
      const promotedB = readLedgerSnapshot(
        path.join(edgeB.edgeRoot, ".harness", "store", "generations", "3", "ledger.sqlite"),
      );
      assert.equal(promotedB.history, cutA.history, "F1: planned switchover must preserve replication history");
      assert.equal(promotedB.writerEpoch, epochBeforeLive + 1);

      // 7. F1 live continuity proof:
      // New Center B (still running, never restarted!) immediately accepts a brand-new write,
      // and Demoted Old Center A (reloaded live in-place to remote-edge!) automatically replicates it from B!
      const writeOnNewCenterB = await edgeB.host.run(
        repoId,
        { kind: "task-create", taskId: "sw-written-on-b", title: "Live write on New Center B" },
        auth,
      );
      assert.equal(writeOnNewCenterB.outcome, "applied", JSON.stringify(writeOnNewCenterB));
      const cutAfterBWrite = readLedgerSnapshot(
        path.join(edgeB.edgeRoot, ".harness", "store", "generations", "3", "ledger.sqlite"),
      );
      assert.ok(cutAfterBWrite.revision > cutAfterRb.revision, "F1: New Center B must advance canonical revision");

      assert.equal(
        await waitForFleetReplicaReady(
          { viewRoot: nodeAViewRoot, repoId, nodeId: nodeAId },
          AbortSignal.timeout(30_000),
        ),
        true,
        "F1: Demoted live Daemon A must connect to New Center B and publish its replica",
      );
      await waitForFleetReplicaRevision(
        { viewRoot: nodeAViewRoot, repoId, nodeId: nodeAId },
        cutAfterBWrite.revision,
        AbortSignal.timeout(30_000),
      );

      // 8. F3 HARD NEGATIVE CONTROL:
      // Original target B HAS already activated `swLiveId`. Now simulate a crash window where A still holds
      // `fenced_ceded` AND an attacker/misconfiguration rewrites A's candidate record to point to an EMPTY directory!
      // Rollback MUST ignore the tampered candidate record, verify against the immutable Phase 1 fence authority (B),
      // hard-refuse rollback, leave A fenced (`CENTER_MOVED`), and create ZERO files in the empty directory!
      const emptyTargetRoot = path.join(root, "tampered-empty-root");
      const emptyTargetUser = path.join(root, "tampered-empty-user");
      const emptyTargetState = path.join(emptyTargetUser, "fleet");
      mkdirSync(emptyTargetRoot, { recursive: true });
      mkdirSync(emptyTargetState, { recursive: true });
      prepareCenterSwitchoverCandidate(nodeA.userRoot, {
        repoId,
        nodeId: nodeBId,
        targetExternalUrl: "https://127.0.0.1:1",
        targetLoginUrl: nodeA.owners.url,
        targetSpkiSha256: certB.spkiSha256,
        targetRoot: emptyTargetRoot,
        targetUserRoot: emptyTargetUser,
        targetStateRoot: emptyTargetState,
      });
      assert.equal(existsSync(centerSwitchoverCandidatePath(nodeA.userRoot, repoId, nodeBId)), true);

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
        reason: "Must refuse rollback because original target B already activated (ignoring tampered empty candidate)",
      });
      assert.equal(refusedRollback.ok, false, JSON.stringify(refusedRollback));
      assert.equal(refusedRollback.code, "target_activation_not_disproven");
      assert.equal(existsSync(fencePathA), true, "F3: source fence must remain intact when rollback is refused");
      const fenceAfterRefusal = JSON.parse(readFileSync(fencePathA, "utf8")) as { readonly state?: string };
      assert.equal(fenceAfterRefusal.state, "fenced_ceded");
      assert.equal(
        existsSync(path.join(emptyTargetState, "writer-epochs", `${repoId}.sqlite`)),
        false,
        "F3: tampered empty target directory must NEVER get a newly created writer-epoch DB",
      );
      assert.equal(
        existsSync(path.join(emptyTargetState, "switchover-invalidated", `${repoId}.json`)),
        false,
        "F3: tampered empty target directory must NEVER get an invalidation record",
      );
      // Confirm old center A still cannot acquire a write lease while fenced!
      const fencedAuthorityA = openPersistentWriterEpoch({
        stateRoot: nodeA.writerEpochStateRoot,
        holderId: "fenced-center-a-check",
      });
      try {
        assert.throws(() => fencedAuthorityA.acquire(repoId, epochBeforeLive), { code: "CENTER_MOVED" });
      } finally {
        fencedAuthorityA.close();
      }

      await daemonSocketA.stop();
      daemonSocketA = null;
      await centerA2.close();
      await nodeA.closeHost(hostA2);
    } finally {
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
