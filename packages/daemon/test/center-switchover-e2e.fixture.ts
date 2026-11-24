import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { managedRbacSessionStore } from "@harness-anything/authorization/keycloak/managed-rbac-service";
import {
  closeSqliteEventStoresUnder,
  openSqliteEventStore,
  promoteReplicaForSwitchover,
  readCenterMigrating,
  readCenterSwitchoverFence,
  switchoverActivationAuditPath,
} from "@harness-anything/storage";
import { readDaemonRegistry } from "@harness-anything/kernel";
import { createIdentitySession } from "../src/daemon-host/authorization-provider.ts";
import { readFleetEdgeConfig } from "../src/daemon-host/client/fleet-edge-config.ts";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { openDaemonWriterEpochs } from "../src/daemon-host/daemon-host-writer-epoch.ts";
import {
  listenFleetTls,
  prepareCenterSymmetricIdentity,
  relocateFleetCenter,
} from "../src/daemon-host/fleet/center.ts";
import {
  FleetRemoteError,
  readFleetRepositoryMetadataClient,
  runFleetTaskCommandClient,
} from "../src/daemon-host/fleet/peer.ts";
import { readFleetRepointLineage } from "../src/daemon-host/fleet/repoint-lineage.ts";
import { waitForFleetReplicaReady, waitForFleetReplicaRevision } from "../src/daemon-host/fleet/replica-sync.ts";
import { readReplicaGeneration } from "../src/fleet-sync/fleet/replica-generation.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetHostWriterOptions } from "./fleet-store.fixture.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

function spkiSha256FromCertPem(certPem: Buffer): string {
  const x509 = new X509Certificate(certPem);
  return `sha256:${createHash("sha256")
    .update(x509.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
}

export async function runCenterSwitchoverSlice1E2e(t: TestContext): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "ha-switchover-e2e-")),
    repoId = "lease-repo",
    nodeAViewRoot = path.join(root, "node-a-views"),
    nodeAId = "node-two",
    nodeBId = "node-one";
  let restartedHostA: Awaited<ReturnType<typeof openDaemonHost>> | null = null,
    restartedCenterA: Awaited<ReturnType<typeof listenFleetTls>> | null = null,
    hostBAsCenter: Awaited<ReturnType<typeof openDaemonHost>> | null = null,
    centerB: Awaited<ReturnType<typeof listenFleetTls>> | null = null,
    hostAAsEdge: Awaited<ReturnType<typeof openDaemonHost>> | null = null,
    hostAAsCenterAgain: Awaited<ReturnType<typeof openDaemonHost>> | null = null,
    centerAAgain: Awaited<ReturnType<typeof listenFleetTls>> | null = null,
    hostBAsEdgeAgain: Awaited<ReturnType<typeof openDaemonHost>> | null = null;

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
    // Register node-a in Keycloak so A can symmetrically demote to remote-edge and sync from B!
    nodeA.owners.keycloak.node(nodeAId, "person-one", `secret-${nodeAId}`);
    const tlsCertPath = path.join(nodeA.root, "tls.crt"),
      tlsKeyPath = path.join(nodeA.root, "tls.key"),
      tlsCertPem = readFileSync(tlsCertPath),
      tlsKeyPem = readFileSync(tlsKeyPath),
      spkiSha256 = spkiSha256FromCertPem(tlsCertPem);

    // Prepare symmetric identity for initial center A (CH3 / F3).
    prepareCenterSymmetricIdentity(nodeA.userRoot, {
      repoId,
      nodeId: nodeAId,
      credential: `secret-${nodeAId}`,
      viewRoot: nodeAViewRoot,
      quotaBytes: 64 * 1024 * 1024,
    });

    const readRev = (repoRoot: string): number => {
      const s = openSqliteEventStore({ rootInput: repoRoot, repoId, readOnly: true });
      try {
        return s.revision();
      } finally {
        s.close();
      }
    };

    const baseRevision = readRev(nodeA.repo);

    // Write initial tasks on center A.
    assert.equal(
      (await nodeA.command("center-node", { kind: "task-create", taskId: "sw-task-1", title: "Task 1 on A" })).outcome,
      "applied",
    );
    assert.equal(
      (await nodeA.command("center-node", { kind: "task-create", taskId: "sw-task-2", title: "Task 2 on A" })).outcome,
      "applied",
    );
    // Capture a lagging edge position before task-3 to verify zero-basebackup repoint later!
    const ledgerAfter2 = openSqliteEventStore({ rootInput: nodeA.repo, repoId, readOnly: true });
    const laggingEdgePos = ledgerAfter2.replicationPosition();
    const revAfter2 = ledgerAfter2.revision();
    const initialHistory = laggingEdgePos.history;
    ledgerAfter2.close();
    assert.ok(revAfter2 > baseRevision);

    assert.equal(
      (await nodeA.command("center-node", { kind: "task-create", taskId: "sw-task-3", title: "Task 3 on A" })).outcome,
      "applied",
    );
    const ledgerAfter3 = openSqliteEventStore({ rootInput: nodeA.repo, repoId, readOnly: true });
    const epochA1 = ledgerAfter3.writerFence()?.epoch ?? 0;
    const revAfter3 = ledgerAfter3.revision();
    ledgerAfter3.close();
    assert.ok(epochA1 >= 1);
    assert.ok(revAfter3 > revAfter2);

    // Start real edge B (node-one) and sync it from center A.
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
    const initialSync = await edgeB.rpc.handle({
      jsonrpc: "2.0",
      id: 101,
      method: "daemon.fleet.edge.sync",
      params: { payload: { ...initialConn, workspaceRoot: edgeB.edgeRoot, timeoutMs: 30_000 } },
    });
    assert.ok(initialSync && !Array.isArray(initialSync) && "result" in initialSync, JSON.stringify(initialSync));
    assert.equal((initialSync.result as Record<string, unknown>).ok, true, JSON.stringify(initialSync.result));
    assert.equal(
      await waitForFleetReplicaReady(
        { viewRoot: edgeB.viewRoot, repoId, nodeId: nodeBId },
        AbortSignal.timeout(30_000),
      ),
      true,
    );
    await waitForFleetReplicaRevision(
      { viewRoot: edgeB.viewRoot, repoId, nodeId: nodeBId },
      revAfter3,
      AbortSignal.timeout(30_000),
    );

    // Copy RBAC config onto B userRoot so B can act as center later.
    mkdirSync(path.join(edgeB.edgeUser, "rbac"), { recursive: true });
    if (existsSync(path.join(nodeA.userRoot, "rbac", "config.json"))) {
      writeFileSync(
        path.join(edgeB.edgeUser, "rbac", "config.json"),
        readFileSync(path.join(nodeA.userRoot, "rbac", "config.json")),
      );
    }

    const commonSwitchFlags = [
      "fleet",
      "center",
      "switch",
      "--root",
      nodeA.repo,
      "--repo",
      repoId,
      "--to",
      nodeBId,
      "--user-root",
      nodeA.userRoot,
      "--state-root",
      nodeA.writerEpochStateRoot,
      "--target-root",
      edgeB.edgeRoot,
      "--target-user-root",
      edgeB.edgeUser,
      "--target-state-root",
      path.join(edgeB.edgeUser, "fleet"),
      "--target-external-url",
      "https://127.0.0.1:9443",
      "--target-login-url",
      nodeA.owners.url,
      "--target-spki-sha256",
      spkiSha256,
      "--target-ca",
      tlsCertPath,
      "--target-servername",
      "localhost",
    ];

    // ---------------------------------------------------------------------
    // Evidence 1: RPO=0 catch-up barrier negative control (lagging by 1 rev)
    // ---------------------------------------------------------------------
    const rpoLagOutcome = await relocateFleetCenter(
      [...commonSwitchFlags, "--switchover-id", "sw_neg_rpo"],
      nodeA.userRoot,
      {
        switchover: {
          probeTls: async () => ({ ok: true }),
          probeAuth: async () => ({ ok: true }),
          freezeAndDrain: async () => undefined,
          awaitTargetCatchup: async ({ frozenCut }) => ({
            repoId,
            revision: frozenCut.finalRevision - 1,
            tipHash: frozenCut.tipHash,
            history: frozenCut.history,
            sequence: frozenCut.sequence - 1,
          }),
        },
      },
    );
    assert.equal(rpoLagOutcome.exitCode, 2, JSON.stringify(rpoLagOutcome.receipt));
    assert.equal(rpoLagOutcome.receipt.code, "rpo_zero_barrier_unmet");
    // Old center A is safely unfrozen and still writable; B is NOT promoted.
    assert.equal(readCenterMigrating(nodeA.userRoot, repoId), null);
    assert.equal(readCenterSwitchoverFence(nodeA.userRoot, repoId), null);
    assert.equal(
      readDaemonRegistry({ userRoot: edgeB.edgeUser }).repos.find((r) => r.repoId === repoId)?.mode,
      "remote-edge",
    );
    assert.notEqual(readFleetEdgeConfig(edgeB.edgeUser, repoId), null);
    assert.equal(existsSync(switchoverActivationAuditPath(path.join(edgeB.edgeUser, "fleet"), repoId)), false);
    const writeAfterRpoAbort = await nodeA.command("center-node", {
      kind: "task-create",
      taskId: "sw-task-after-rpo-abort",
      title: "Still writable on A after RPO abort",
    });
    assert.equal(writeAfterRpoAbort.outcome, "applied", JSON.stringify(writeAfterRpoAbort));
    const revAfter4 = readRev(nodeA.repo);
    assert.ok(revAfter4 > revAfter3);
    await waitForFleetReplicaRevision(
      { viewRoot: edgeB.viewRoot, repoId, nodeId: nodeBId },
      revAfter4,
      AbortSignal.timeout(30_000),
    );

    // ---------------------------------------------------------------------
    // Evidence 2: Phase 1 crash/restart防脑裂 + audited oldEpoch+2 rollback + delayed activation refusal
    // ---------------------------------------------------------------------
    const phase1Crash = await relocateFleetCenter(
      [...commonSwitchFlags, "--switchover-id", "sw_crash_p1"],
      nodeA.userRoot,
      {
        switchover: {
          probeTls: async () => ({ ok: true }),
          probeAuth: async () => ({ ok: true }),
          freezeAndDrain: async () => undefined,
          beforeTargetActivation: async () => {
            throw Object.assign(new Error("injected crash right after Phase 1 fsync before Phase 2"), {
              code: "injected_phase1_crash",
            });
          },
        },
      },
    );
    assert.equal(phase1Crash.receipt.ok, false);
    assert.equal(phase1Crash.receipt.fencedCeded, true);
    assert.equal(phase1Crash.receipt.phase, "fenced_ceded");
    assert.equal(readCenterSwitchoverFence(nodeA.userRoot, repoId)?.state, "fenced_ceded");

    // Crash/restart node A completely: fresh openDaemonHost + fresh listenFleetTls!
    // Because Phase 1 retired A's writer lease and persisted the ceded fence, A has no active writer lease
    // and its TLS listener serves structured CENTER_MOVED to any edge that reconnects.
    await nodeA.center.close();
    await nodeA.closeHost(nodeA.host);
    restartedHostA = await nodeA.openHost();
    restartedCenterA = await listenFleetTls({
      host: restartedHostA,
      stateRoot: nodeA.writerEpochStateRoot,
      relocationRoot: nodeA.userRoot,
      writerEpochStateRoot: nodeA.writerEpochStateRoot,
      centerRepoId: repoId,
      key: tlsKeyPem,
      cert: tlsCertPem,
      hostname: "127.0.0.1",
      port: 0,
      authenticate: (nodeId, credential) => credential === `secret-${nodeId}`,
      nodeOwner: nodeA.owners.nodeOwner,
      verifyHuman: nodeA.owners.verifyHuman,
    });

    // Restarted A MUST refuse local writes, refuse writer-epoch acquire, and return CENTER_MOVED over Fleet TLS!
    const fencedLocalWrite = (await restartedHostA.run(
      repoId,
      { kind: "task-create", taskId: "sw-must-not-revive", title: "Must not revive" },
      auth,
    )) as { readonly outcome?: string; readonly code?: string; readonly centerMoved?: Record<string, unknown> };
    assert.equal(fencedLocalWrite.outcome, "op_rejected", JSON.stringify(fencedLocalWrite));
    assert.equal(fencedLocalWrite.code, "CENTER_MOVED", JSON.stringify(fencedLocalWrite));
    assert.equal(fencedLocalWrite.centerMoved?.newEpoch, epochA1 + 1);

    const restartedEpochCheck = openDaemonWriterEpochs({
      userRoot: nodeA.userRoot,
      daemonId: "restarted-check",
      now: () => new Date().toISOString(),
    });
    try {
      assert.throws(() => restartedEpochCheck.writerEpochLease(repoId), { code: "CENTER_MOVED" });
    } finally {
      restartedEpochCheck.closeDaemonWriterEpoch();
    }

    const peerBaseA = {
      hostname: "127.0.0.1",
      port: restartedCenterA.port,
      ca: tlsCertPem,
      servername: "localhost",
      nodeId: nodeBId,
      credential: `secret-${nodeBId}`,
      readAccessToken: nodeA.owners.readAccessToken(nodeBId),
      accessToken: `device-token-${nodeBId}`,
    };
    await assert.rejects(readFleetRepositoryMetadataClient({ ...peerBaseA, repoId }), (error: unknown) => {
      assert.ok(error instanceof FleetRemoteError);
      assert.equal(error.code, "CENTER_MOVED");
      assert.equal(error.centerMoved?.newEpoch, epochA1 + 1);
      return true;
    });
    await assert.rejects(
      runFleetTaskCommandClient({
        ...peerBaseA,
        writerEpoch: epochA1,
        repoId,
        taskId: "sw-remote-fenced",
        opId: "op_remote_fenced",
        waitMs: 5_000,
        action: { kind: "task-create", taskId: "sw-remote-fenced", title: "Remote fenced" },
      }),
      (error: unknown) => {
        assert.ok(error instanceof FleetRemoteError);
        assert.equal(error.code, "CENTER_MOVED");
        return true;
      },
    );

    // Unverified rollback without target invalidation MUST fail.
    const unverifiedRollback = await relocateFleetCenter(
      [
        "fleet",
        "center",
        "switch",
        "--abort-rollback",
        "--root",
        nodeA.repo,
        "--repo",
        repoId,
        "--switchover-id",
        "sw_crash_p1",
        "--reason",
        "no target state root supplied",
        "--user-root",
        nodeA.userRoot,
        "--state-root",
        nodeA.writerEpochStateRoot,
      ],
      nodeA.userRoot,
    );
    assert.equal(unverifiedRollback.exitCode, 2, JSON.stringify(unverifiedRollback.receipt));
    assert.equal(unverifiedRollback.receipt.code, "target_activation_not_disproven");

    // Audited rollback: proves target B never activated epochA1+1, invalidates sw_crash_p1 on B, bumps A to epochA1+2!
    await restartedCenterA.close();
    restartedCenterA = null;
    await restartedHostA.close();
    restartedHostA = null;

    const auditedRollback = await relocateFleetCenter(
      [
        "fleet",
        "center",
        "switch",
        "--abort-rollback",
        "--root",
        nodeA.repo,
        "--repo",
        repoId,
        "--switchover-id",
        "sw_crash_p1",
        "--reason",
        "Phase 2 never reached target B after Phase 1 crash",
        "--user-root",
        nodeA.userRoot,
        "--state-root",
        nodeA.writerEpochStateRoot,
        "--target-user-root",
        edgeB.edgeUser,
        "--target-state-root",
        path.join(edgeB.edgeUser, "fleet"),
        "--target-root",
        edgeB.edgeRoot,
      ],
      nodeA.userRoot,
    );
    assert.equal(auditedRollback.exitCode, 0, JSON.stringify(auditedRollback.receipt));
    const rollbackInfo = auditedRollback.receipt.rollback as { readonly rollbackEpoch: number };
    assert.equal(rollbackInfo.rollbackEpoch, epochA1 + 2);
    assert.equal(readCenterSwitchoverFence(nodeA.userRoot, repoId), null);

    // Delayed Phase 2 activation for invalidated sw_crash_p1 arriving on target B MUST be rejected!
    const bGenBefore = readReplicaGeneration(path.join(edgeB.viewRoot, "repos", repoId, "views", nodeBId));
    assert.ok(bGenBefore);
    await assert.rejects(
      promoteReplicaForSwitchover({
        rootInput: edgeB.edgeRoot,
        userRoot: edgeB.edgeUser,
        stateRoot: path.join(edgeB.edgeUser, "fleet"),
        repoId,
        switchoverId: "sw_crash_p1",
        replicaDatabasePath: bGenBefore.ledgerPath,
        replicaGeneration: bGenBefore.metadata.ledgerGeneration,
        replicaPosition: bGenBefore.metadata.position,
        expectedOldEpoch: epochA1,
        newEpoch: epochA1 + 1,
        expectedFrozenCut: {
          repoId,
          finalRevision: revAfter4,
          tipHash: "sha256:ignored",
          history: initialHistory,
          sequence: bGenBefore.metadata.position.sequence,
        },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "switchover_attempt_invalidated");
        return true;
      },
    );

    // Reopen A after rollback on the SAME port so edge B reconnects automatically and receives revAfter5!
    restartedHostA = await nodeA.openHost();
    restartedCenterA = await nodeA.openCenter(restartedHostA, nodeA.center.port);
    const writeAfterRollback = await restartedHostA.run(
      repoId,
      { kind: "task-create", taskId: "sw-task-5-after-rollback", title: "Task 5 after rollback" },
      auth,
    );
    assert.equal(writeAfterRollback.outcome, "applied", JSON.stringify(writeAfterRollback));
    const revAfter5 = readRev(nodeA.repo);
    assert.ok(revAfter5 > revAfter4);
    await waitForFleetReplicaRevision(
      { viewRoot: edgeB.viewRoot, repoId, nodeId: nodeBId },
      revAfter5,
      AbortSignal.timeout(30_000),
    );

    const ledgerBeforeSwitchAB = openSqliteEventStore({ rootInput: nodeA.repo, repoId, readOnly: true });
    const epochBeforeAB = ledgerBeforeSwitchAB.writerFence()?.epoch ?? 0;
    ledgerBeforeSwitchAB.close();
    assert.ok(epochBeforeAB >= epochA1 + 2);

    // ---------------------------------------------------------------------
    // Evidence 3 & 4: Dry-run preflight, Online Switchover A -> B (history + log window + lagging edge resume),
    //                 new writes on B synced back to demoted A, and reverse Switchover B -> A!
    // ---------------------------------------------------------------------
    const dryRunAB = await relocateFleetCenter(
      [...commonSwitchFlags, "--dry-run", "--switchover-id", "sw_dry_ab"],
      nodeA.userRoot,
      {
        switchover: {
          probeTls: async () => ({ ok: true }),
          probeAuth: async () => ({ ok: true }),
        },
      },
    );
    assert.equal(dryRunAB.exitCode, 0, JSON.stringify(dryRunAB.receipt));
    assert.equal(dryRunAB.receipt.dryRun, true);
    assert.equal((dryRunAB.receipt.preflight as { readonly ok: boolean }).ok, true);

    // Stop edge B's receiver & A's center cleanly right as we cut over (without deleting edgeB's temp root!), then run Switchover A -> B!
    edgeB.rpc.close();
    await edgeB.host.close();
    await restartedCenterA.close();
    restartedCenterA = null;
    await restartedHostA.close();
    restartedHostA = null;

    // Reserve a port for B's new center listener after B activates.
    // First execute Switchover A -> B (Phase 1 fence on A -> Phase 2 promote B preserving history -> Phase 3 demote A to remote-edge).
    let portB = 0;
    const switchAB = await relocateFleetCenter([...commonSwitchFlags, "--switchover-id", "sw_ab_1"], nodeA.userRoot, {
      switchover: {
        probeTls: async () => ({ ok: true }),
        probeAuth: async () => ({ ok: true }),
        freezeAndDrain: async () => undefined,
        afterTargetActivated: async () => {
          // Start B as the new active center sharing hostBAsCenter's writer epoch lease!
          nodeA.owners.bind(edgeB.edgeUser);
          hostBAsCenter = await openDaemonHost({
            daemonId: "node-b-center",
            userRoot: edgeB.edgeUser,
            oidc: createIdentitySession(edgeB.edgeUser, { fetch: nodeA.owners.keycloak.fetch }),
          });
          await hostBAsCenter.attachmentsSettled();
          centerB = await listenFleetTls({
            host: hostBAsCenter,
            stateRoot: path.join(edgeB.edgeUser, "fleet"),
            ...fleetHostWriterOptions(edgeB.edgeUser, [repoId]),
            key: tlsKeyPem,
            cert: tlsCertPem,
            hostname: "127.0.0.1",
            port: 0,
            replicaDiskQuotaBytes: 64 * 1024 * 1024,
            authenticate: (nodeId, credential) => credential === `secret-${nodeId}`,
            nodeOwner: nodeA.owners.nodeOwner,
            verifyHuman: nodeA.owners.verifyHuman,
            authenticateExecutionPrincipal: nodeA.owners.authenticateExecutionPrincipal,
            verifyReplica: (authCtx) =>
              createIdentitySession(edgeB.edgeUser, { fetch: nodeA.owners.keycloak.fetch }).bindReplica!(authCtx),
            loginAuthority: () => ({ url: nodeA.owners.url, realm: "harness", clientId: "harness-cli" }),
          });
          portB = centerB.port;
        },
      },
    });
    assert.equal(switchAB.exitCode, 0, JSON.stringify(switchAB.receipt));
    assert.equal(switchAB.receipt.phase, "demoted_edge");
    const activationAB = switchAB.receipt.activation as {
      readonly oldEpoch: number;
      readonly newEpoch: number;
      readonly replicationHistory: string;
      readonly finalRevision: number;
    };
    assert.equal(activationAB.oldEpoch, epochBeforeAB);
    assert.equal(activationAB.newEpoch, epochBeforeAB + 1);
    assert.equal(activationAB.replicationHistory, initialHistory, "Planned switchover MUST preserve history!");
    assert.equal(activationAB.finalRevision, revAfter5);
    assert.ok(portB > 0);

    // Verify Evidence 3: Lagging edge from revAfter2 (laggingEdgePos) can resume incrementally on B via readFleetRepointLineage!
    const lineageOnB = await readFleetRepointLineage({
      rootDir: edgeB.edgeRoot,
      repoId,
      position: laggingEdgePos,
      retentionWindowCommits: 1024,
    });
    assert.equal(lineageOnB.witness.resumeAvailable, true, JSON.stringify(lineageOnB));
    assert.equal(lineageOnB.witness.revision, revAfter2);
    assert.ok(lineageOnB.witness.tipHash !== null);

    // Verify A is now demoted to mode="remote-edge" with fleet-edge.json pointing at B (update port to actual ephemeral portB).
    assert.equal(
      readDaemonRegistry({ userRoot: nodeA.userRoot }).repos.find((r) => r.repoId === repoId)?.mode,
      "remote-edge",
    );
    const edgeConfigA = readFleetEdgeConfig(nodeA.userRoot, repoId);
    assert.ok(edgeConfigA);
    assert.equal(edgeConfigA.nodeId, nodeAId);
    assert.equal(edgeConfigA.writerEpoch, epochBeforeAB + 1);
    // Update port to B's actual bound ephemeral port and seed node A's OIDC session so A's live host replicates from B.
    const { writeFleetEdgeConfig } = await import("../src/daemon-host/client/fleet-edge-config.ts");
    writeFleetEdgeConfig(nodeA.userRoot, repoId, { ...edgeConfigA, host: "127.0.0.1", port: portB });
    const issuer = String(
      (
        await (
          await nodeA.owners.keycloak.fetch(`${nodeA.owners.url}/realms/harness/.well-known/openid-configuration`)
        ).json()
      ).issuer,
    );
    const nodeAAuthority = {
      url: nodeA.owners.url,
      realm: "harness",
      clientId: `harness-node-${nodeAId}`,
      clientSecret: `secret-${nodeAId}`,
    };
    managedRbacSessionStore(nodeA.userRoot, issuer, "harness").write(
      JSON.stringify({
        schema: "harness-oidc-session/v3",
        issuer,
        accessToken: `device-token-${nodeAId}`,
        refreshToken: "refresh-person-one",
        subject: "person-one",
        personId: "person-one",
        expiresAt: Date.now() + 3_600_000,
        sessionExpiresAt: Date.now() + 21_600_000,
        roles: [],
        loginTarget: nodeA.repo,
        authority: nodeAAuthority,
      }),
    );

    // Start A's daemon host as remote-edge (verifying demoted_edge fence + remote-edge works smoothly!).
    hostAAsEdge = await openDaemonHost({
      daemonId: "node-a-edge",
      userRoot: nodeA.userRoot,
      oidc: createIdentitySession(nodeA.userRoot, {
        fetch: nodeA.owners.keycloak.fetch,
        loginAuthority: () => Promise.resolve(nodeAAuthority),
      }),
    });
    await hostAAsEdge.attachmentsSettled();

    // Write revisions +6 & +7 on new center B!
    const writeOnB6 = await hostBAsCenter!.run(
      repoId,
      { kind: "task-create", taskId: "sw-task-6-on-b", title: "Task 6 on center B" },
      auth,
    );
    assert.equal(writeOnB6.outcome, "applied", JSON.stringify(writeOnB6));
    const writeOnB7 = await hostBAsCenter!.run(
      repoId,
      { kind: "task-create", taskId: "sw-task-7-on-b", title: "Task 7 on center B" },
      auth,
    );
    assert.equal(writeOnB7.outcome, "applied", JSON.stringify(writeOnB7));
    const revAfter7 = readRev(edgeB.edgeRoot);
    assert.ok(revAfter7 > revAfter5);

    // Wait for demoted edge A to replicate B's writes up to revAfter7!
    assert.equal(
      await waitForFleetReplicaReady({ viewRoot: nodeAViewRoot, repoId, nodeId: nodeAId }, AbortSignal.timeout(30_000)),
      true,
    );
    await waitForFleetReplicaRevision(
      { viewRoot: nodeAViewRoot, repoId, nodeId: nodeAId },
      revAfter7,
      AbortSignal.timeout(30_000),
    );

    // Verify A's replica has revAfter7 and the EXACT SAME history!
    const aGenBeforeBA = readReplicaGeneration(path.join(nodeAViewRoot, "repos", repoId, "views", nodeAId));
    assert.ok(aGenBeforeBA);
    assert.equal(aGenBeforeBA.metadata.position.history, initialHistory);
    assert.equal(aGenBeforeBA.metadata.position.revision, revAfter7);

    // ---------------------------------------------------------------------
    // Evidence 4 (second leg): Reverse Switchover B -> A!
    // ---------------------------------------------------------------------
    const ledgerB = openSqliteEventStore({ rootInput: edgeB.edgeRoot, repoId, readOnly: true });
    const epochBeforeBA = ledgerB.writerFence()?.epoch ?? 0;
    ledgerB.close();
    assert.ok(epochBeforeBA >= epochBeforeAB + 1);

    await hostAAsEdge.close();
    hostAAsEdge = null;
    await centerB!.close();
    centerB = null;
    await hostBAsCenter!.close();
    hostBAsCenter = null;

    let portA2 = 0;
    const switchBA = await relocateFleetCenter(
      [
        "fleet",
        "center",
        "switch",
        "--root",
        edgeB.edgeRoot,
        "--repo",
        repoId,
        "--to",
        nodeAId,
        "--switchover-id",
        "sw_ba_2",
        "--user-root",
        edgeB.edgeUser,
        "--state-root",
        path.join(edgeB.edgeUser, "fleet"),
        "--target-root",
        nodeA.repo,
        "--target-user-root",
        nodeA.userRoot,
        "--target-state-root",
        nodeA.writerEpochStateRoot,
        "--target-external-url",
        "https://127.0.0.1:9444",
        "--target-login-url",
        nodeA.owners.url,
        "--target-spki-sha256",
        spkiSha256,
        "--target-ca",
        tlsCertPath,
        "--target-servername",
        "localhost",
      ],
      edgeB.edgeUser,
      {
        switchover: {
          probeTls: async () => ({ ok: true }),
          probeAuth: async () => ({ ok: true }),
          freezeAndDrain: async () => undefined,
          afterTargetActivated: async () => {
            hostAAsCenterAgain = await nodeA.openHost();
            centerAAgain = await nodeA.openCenter(hostAAsCenterAgain);
            portA2 = centerAAgain.port;
          },
        },
      },
    );
    assert.equal(switchBA.exitCode, 0, JSON.stringify(switchBA.receipt));
    assert.equal(switchBA.receipt.phase, "demoted_edge");
    const activationBA = switchBA.receipt.activation as {
      readonly oldEpoch: number;
      readonly newEpoch: number;
      readonly replicationHistory: string;
      readonly finalRevision: number;
    };
    assert.equal(activationBA.oldEpoch, epochBeforeBA);
    assert.equal(activationBA.newEpoch, epochBeforeBA + 1);
    assert.equal(activationBA.replicationHistory, initialHistory, "Reverse switchover B -> A MUST preserve history!");
    assert.equal(activationBA.finalRevision, revAfter7);
    assert.equal(readCenterSwitchoverFence(nodeA.userRoot, repoId), null);
    assert.equal(
      readDaemonRegistry({ userRoot: nodeA.userRoot }).repos.find((r) => r.repoId === repoId)?.mode,
      "local",
    );
    assert.equal(
      readDaemonRegistry({ userRoot: edgeB.edgeUser }).repos.find((r) => r.repoId === repoId)?.mode,
      "remote-edge",
    );
    assert.ok(portA2 > 0);

    // Update B's demoted edge config to A's actual bound port and restart B as remote-edge.
    const edgeConfigB = readFleetEdgeConfig(edgeB.edgeUser, repoId);
    assert.ok(edgeConfigB);
    writeFleetEdgeConfig(edgeB.edgeUser, repoId, { ...edgeConfigB, host: "127.0.0.1", port: portA2 });
    const nodeBAuthority = {
      url: nodeA.owners.url,
      realm: "harness",
      clientId: `harness-node-${nodeBId}`,
      clientSecret: `secret-${nodeBId}`,
    };
    hostBAsEdgeAgain = await openDaemonHost({
      daemonId: "node-b-edge-again",
      userRoot: edgeB.edgeUser,
      oidc: createIdentitySession(edgeB.edgeUser, {
        fetch: nodeA.owners.keycloak.fetch,
        loginAuthority: () => Promise.resolve(nodeBAuthority),
      }),
    });
    await hostBAsEdgeAgain.attachmentsSettled();

    // Write revision +8 on restored center A and verify B replicates it with 0 data loss and contiguous revisions!
    const writeOnA8 = await hostAAsCenterAgain!.run(
      repoId,
      { kind: "task-create", taskId: "sw-task-8-back-on-a", title: "Task 8 back on A" },
      auth,
    );
    assert.equal(writeOnA8.outcome, "applied", JSON.stringify(writeOnA8));
    const revAfter8 = readRev(nodeA.repo);
    assert.ok(revAfter8 > revAfter7);
    await waitForFleetReplicaRevision(
      { viewRoot: edgeB.viewRoot, repoId, nodeId: nodeBId },
      revAfter8,
      AbortSignal.timeout(30_000),
    );

    const finalLedgerA = openSqliteEventStore({ rootInput: nodeA.repo, repoId, readOnly: true });
    try {
      assert.equal(finalLedgerA.replicationPosition().history, initialHistory);
      const events = finalLedgerA.events();
      assert.equal(events.length, revAfter8);
      assert.deepEqual(
        events.map((e) => e.workspaceRevision),
        Array.from({ length: revAfter8 }, (_, idx) => idx + 1),
      );
    } finally {
      finalLedgerA.close();
    }
    // Verify git repo on A is clean/valid and not corrupted.
    assert.equal(typeof execFileSync("git", ["status", "--short"], { cwd: nodeA.repo, encoding: "utf8" }), "string");
  } finally {
    if (hostBAsEdgeAgain) await hostBAsEdgeAgain.close();
    if (centerAAgain) await centerAAgain.close();
    if (hostAAsCenterAgain) await hostAAsCenterAgain.close();
    if (hostAAsEdge) await hostAAsEdge.close();
    if (centerB) await centerB.close();
    if (hostBAsCenter) await hostBAsCenter.close();
    if (restartedCenterA) await restartedCenterA.close();
    if (restartedHostA) await restartedHostA.close();
    closeSqliteEventStoresUnder(root);
    removeTempRepository(root);
  }
}
