// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpsServer } from "node:https";
import path from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import {
  readManagedRbacRelocationBundle,
  writeManagedRbacRelocationBundle,
} from "@harness-anything/authorization/keycloak";
import { IDENTITY_RELOCATION_ACCESS_ADMIN_JOURNAL_SCHEMA } from "@harness-anything/kernel/internal/ports/identity-management-port.ts";
import {
  activateEmptyCanonicalGeneration,
  closeSqliteEventStoresUnder,
  fleetBaseBackupTrace,
  makeTaskEventStore,
  openPersistentWriterEpoch,
  openSqliteEventStore,
  promoteFromEdgeAuditPath,
  readCenterMigrating,
  registerDaemonRepo,
} from "@harness-anything/storage";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";
import { fleetHostWriterOptions } from "./fleet-store.fixture.ts";
import { createIdentitySession } from "../src/daemon-host/authorization-provider.ts";
import { localUserDaemonEndpoint, mkdirSecurely } from "../src/daemon-host/client/local-daemon-target.ts";
import { readFleetEdgeConfig, writeFleetEdgeConfig } from "../src/daemon-host/client/fleet-edge-config.ts";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { listenFleetTls } from "../src/daemon-host/fleet/center.ts";
import { relocateFleetCenter } from "../src/daemon-host/fleet/center-relocation-command.ts";
import { waitForFleetReplicaReady, waitForFleetReplicaSequence } from "../src/daemon-host/fleet/replica-sync.ts";
import { readReplicaGeneration } from "../src/fleet-sync/fleet/replica-generation.ts";

test(
  "M1-M4 relocation exports, activates, repoints, and manually promotes a complete edge replica",
  { timeout: 360_000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-center-relocation-e2e-")),
      repoId = "lease-repo",
      bundleDir = path.join(root, "relocation-bundle"),
      newCenterRoot = path.join(root, "new-center"),
      newUserRoot = path.join(root, "new-center-user"),
      newStateRoot = path.join(newUserRoot, "fleet"),
      targetTls = createTestCertificate(path.join(root, "new-center-tls")),
      newExternalUrl = "https://center2.example.test:9443",
      newSpkiSha256 = `sha256:${targetTls.spkiSha256}`;
    let newHost: Awaited<ReturnType<typeof openDaemonHost>> | null = null,
      newCenter: Awaited<ReturnType<typeof listenFleetTls>> | null = null,
      restartedOldHost: Awaited<ReturnType<typeof openDaemonHost>> | null = null,
      restartedOldCenter: Awaited<ReturnType<typeof listenFleetTls>> | null = null,
      promotedHost: Awaited<ReturnType<typeof openDaemonHost>> | null = null;

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
      const oldLoginProxy = await listenFleetLoginProxy(t, {
          key: readFileSync(path.join(oldCenter.root, "tls.key")),
          cert: readFileSync(path.join(oldCenter.root, "tls.crt")),
          keycloak: oldCenter.owners.keycloak,
        }),
        newLoginProxy = await listenFleetLoginProxy(t, {
          key: targetTls.key,
          cert: targetTls.cert,
          keycloak: oldCenter.owners.keycloak,
        }),
        oldAuthority = {
          url: oldLoginProxy.url,
          realm: "harness",
          clientId: "harness-node-node-one",
          servername: "localhost",
          certificate: oldLoginProxy.certificate,
        },
        newLoginUrl = newLoginProxy.url;
      assert.equal(
        (
          await oldCenter.command("center-node", {
            kind: "task-create",
            taskId: "relocation-before-move",
            title: "Before relocation",
          })
        ).outcome,
        "applied",
      );
      const oldLedger = openSqliteEventStore({ rootInput: oldCenter.repo, repoId, readOnly: true });
      let oldEpoch: number;
      try {
        oldEpoch = oldLedger.writerFence()?.epoch ?? 0;
      } finally {
        oldLedger.close();
      }
      assert.ok(oldEpoch > 0);

      const edge = await fleetEdgeHostFixture(t, oldCenter, {
          oidcPorts: { loginAuthority: () => Promise.resolve(oldAuthority) },
        }),
        {
          schema: _schema,
          loginUrl: _loginUrl,
          loginRealm: _loginRealm,
          loginServername: _loginServername,
          loginBrowserUrl: _loginBrowserUrl,
          loginCertificate: _loginCertificate,
          waitTimeoutMs: _waitTimeoutMs,
          ...initialConnection
        } = edge.config,
        initialSync = await edge.rpc.handle({
          jsonrpc: "2.0",
          id: 920,
          method: "daemon.fleet.edge.sync",
          params: { payload: { ...initialConnection, workspaceRoot: edge.edgeRoot, timeoutMs: 30_000 } },
        });
      assert.ok(initialSync && !Array.isArray(initialSync) && "result" in initialSync, JSON.stringify(initialSync));
      assert.equal((initialSync.result as Record<string, unknown>).ok, true, JSON.stringify(initialSync.result));
      assert.equal(await waitForFleetReplicaReady({ viewRoot: edge.viewRoot, repoId, nodeId: "node-one" }), true);
      const edgeConnection = readFleetEdgeConfig(edge.edgeUser, repoId);
      assert.ok(edgeConnection);
      writeFleetEdgeConfig(edge.edgeUser, repoId, {
        ...edgeConnection,
        loginUrl: oldAuthority.url,
        loginRealm: oldAuthority.realm,
        loginServername: oldAuthority.servername,
        loginCertificate: oldAuthority.certificate,
      });

      let freezeObserved = false,
        importedRbacBundle = false;
      const exported = await relocateFleetCenter(
        [
          "fleet",
          "center",
          "export",
          "--root",
          oldCenter.repo,
          "--bundle",
          bundleDir,
          "--repo",
          repoId,
          "--writer-epoch",
          String(oldEpoch),
          "--user-root",
          oldCenter.userRoot,
          "--state-root",
          oldCenter.writerEpochStateRoot,
        ],
        oldCenter.userRoot,
        {
          freezeAndDrain: async () => {
            assert.equal(readCenterMigrating(oldCenter.userRoot, repoId)?.writerEpoch, oldEpoch);
            const frozenWrite = await oldCenter.host.run(
              repoId,
              { kind: "task-create", taskId: "frozen-relocation-write", title: "Must be frozen" },
              auth,
            );
            assert.equal(frozenWrite.code, "CENTER_MIGRATING", JSON.stringify(frozenWrite));
            freezeObserved = true;
          },
          exportRbacBundle: async ({ payloadRbacDir }) => {
            writeManagedRbacRelocationBundle(payloadRbacDir, {
              realm: "harness",
              realmJson: JSON.stringify({ realm: "harness", clients: [{ clientId: "harness-center" }] }),
              centerClientSecret: "fixture-center-client-secret",
              edgeJoinJournal: {
                schema: IDENTITY_RELOCATION_ACCESS_ADMIN_JOURNAL_SCHEMA,
                entries: [JSON.stringify({ personId: "fixture-admin", action: "member-admitted" })],
              },
            });
          },
        },
      );
      assert.equal(exported.exitCode, 0, JSON.stringify(exported.receipt));
      assert.equal(freezeObserved, true);
      assert.equal(readCenterMigrating(oldCenter.userRoot, repoId), null);
      const exportManifest = exported.receipt.manifest as {
        readonly finalRevision: number;
        readonly tipHash: string;
        readonly files: readonly { readonly path: string }[];
      };
      assert.ok(exportManifest.files.some(({ path: file }) => file === "rbac/manifest.json"));
      assert.ok(exportManifest.files.some(({ path: file }) => file === "rbac/edge-join-journal.json"));

      const retired = await relocateFleetCenter(
        [
          "fleet",
          "center",
          "retire",
          "--user-root",
          oldCenter.userRoot,
          "--repo",
          repoId,
          "--old-epoch",
          String(oldEpoch),
          "--final-revision",
          String(exportManifest.finalRevision),
          "--tip-hash",
          exportManifest.tipHash,
          "--new-external-url",
          newExternalUrl,
          "--new-login-url",
          newLoginUrl,
          "--spki-sha256",
          newSpkiSha256,
        ],
        oldCenter.userRoot,
      );
      assert.equal(retired.exitCode, 0, JSON.stringify(retired.receipt));
      await oldCenter.center.close();
      await oldCenter.closeHost(oldCenter.host);
      restartedOldHost = await oldCenter.openHost();
      restartedOldCenter = await oldCenter.openCenter(restartedOldHost);

      const localMoved = await restartedOldHost.run(
        repoId,
        { kind: "task-create", taskId: "old-center-after-restart", title: "Must be fenced" },
        auth,
      );
      assert.equal(localMoved.outcome, "op_rejected", JSON.stringify(localMoved));
      assert.equal(localMoved.code, "CENTER_MOVED", JSON.stringify(localMoved));
      const imported = await relocateFleetCenter(
        [
          "fleet",
          "center",
          "import",
          "--bundle",
          bundleDir,
          "--destination",
          newCenterRoot,
          "--user-root",
          newUserRoot,
          "--state-root",
          newStateRoot,
          "--repo",
          repoId,
          "--expected-final-revision",
          String(exportManifest.finalRevision),
          "--expected-tip-hash",
          exportManifest.tipHash,
          "--external-url",
          newExternalUrl,
          "--login-url",
          newLoginUrl,
        ],
        newUserRoot,
        {
          importRbacBundle: async ({ payloadRbacDir }) => {
            const bundle = readManagedRbacRelocationBundle(payloadRbacDir);
            assert.equal(bundle.realm, "harness");
            assert.equal(bundle.centerClientSecret, "fixture-center-client-secret");
            assert.deepEqual(bundle.edgeJoinJournal, {
              schema: IDENTITY_RELOCATION_ACCESS_ADMIN_JOURNAL_SCHEMA,
              entries: [JSON.stringify({ personId: "fixture-admin", action: "member-admitted" })],
            });
            importedRbacBundle = true;
          },
        },
      );
      assert.equal(imported.exitCode, 0, JSON.stringify(imported.receipt));
      assert.equal(importedRbacBundle, true);
      oldCenter.owners.bind(newUserRoot);
      const newEpoch = Number(imported.receipt.newEpoch);
      assert.equal(newEpoch, oldEpoch + 1);
      registerDaemonRepo({
        canonicalRoot: newCenterRoot,
        repoId,
        userRoot: newUserRoot,
        mode: "local",
        createConvenienceLinks: false,
      });

      const newTlsServerName = "localhost",
        newAuthority = {
          url: newLoginUrl,
          realm: "harness",
          clientId: "harness-node-node-one",
          browserUrl: newLoginUrl,
          servername: newTlsServerName,
          certificate: newLoginProxy.certificate,
        };
      newHost = await openDaemonHost({
        daemonId: "relocated-center",
        userRoot: newUserRoot,
        oidc: createIdentitySession(newUserRoot, { fetch: oldCenter.owners.keycloak.fetch }),
      });
      await newHost.attachmentsSettled();
      newCenter = await listenFleetTls({
        host: newHost,
        stateRoot: newStateRoot,
        ...fleetHostWriterOptions(newUserRoot, [repoId]),
        key: targetTls.key,
        cert: targetTls.cert,
        port: 0,
        bind: "127.0.0.1",
        replicaDiskQuotaBytes: 64 * 1024 * 1024,
        authenticate: (nodeId, credential) => credential === `secret-${nodeId}`,
        nodeOwner: oldCenter.owners.nodeOwner,
        verifyHuman: oldCenter.owners.verifyHuman,
        authenticateExecutionPrincipal: oldCenter.owners.authenticateExecutionPrincipal,
        verifyReplica: (replicaAuth) =>
          createIdentitySession(newUserRoot, { fetch: oldCenter.owners.keycloak.fetch }).bindReplica!(replicaAuth),
        loginAuthority: () => newAuthority,
      });
      assert.notEqual(newCenter.port, oldCenter.center.port);
      assert.ok(existsSync(path.join(newCenterRoot, ".harness", "store", "generations", "3", "ledger.sqlite")));

      const importedWrite = await newHost.run(
        repoId,
        { kind: "task-create", taskId: "new-center-suffix", title: "New center suffix" },
        oldCenter.owners.auth({ nodeId: "center-node" }),
      );
      assert.equal(importedWrite.outcome, "applied", JSON.stringify(importedWrite));
      const importedCenterLedger = openSqliteEventStore({ rootInput: newCenterRoot, repoId, readOnly: true });
      let activatedEpoch: number, importedSequence: number;
      try {
        activatedEpoch = importedCenterLedger.writerFence()?.epoch ?? 0;
        importedSequence = importedCenterLedger.replicationPosition().sequence;
      } finally {
        importedCenterLedger.close();
      }
      assert.ok(activatedEpoch >= newEpoch);
      const edgeViewDir = path.join(edge.viewRoot, "repos", repoId, "views", "node-one"),
        beforeRepoint = readReplicaGeneration(edgeViewDir);
      assert.ok(beforeRepoint);
      const priorRevision = beforeRepoint.metadata.position.revision,
        priorGenerationId = beforeRepoint.id,
        originalEdgeConfig = readFleetEdgeConfig(edge.edgeUser, repoId)!,
        localMarker = path.join(edge.edgeRoot, "harness", "operator-local.txt");
      writeFileSync(localMarker, "operator-owned state\n");
      const newSpki = targetTls.spkiSha256,
        repointPayload = {
          host: "127.0.0.1",
          port: newCenter.port,
          caPath: targetTls.certPath,
          spkiSha256: newSpki,
          nodeId: "node-one",
          credential: "secret-node-one",
          repoId,
          viewRoot: originalEdgeConfig.viewRoot,
          quotaBytes: originalEdgeConfig.quotaBytes,
          workspaceRoot: edge.edgeRoot,
          servername: newTlsServerName,
          timeoutMs: 30_000,
          repoint: true,
        };
      const basebackupRepos: string[] = [],
        onBasebackup = (span: { readonly repoId: string | null }) => {
          if (span.repoId) basebackupRepos.push(span.repoId);
        };
      fleetBaseBackupTrace.start.subscribe(onBasebackup);
      t.after(() => fleetBaseBackupTrace.start.unsubscribe(onBasebackup));
      const repoint = async (payload: typeof repointPayload) => {
        const response = await edge.rpc.handle({
          jsonrpc: "2.0",
          id: 771,
          method: "daemon.fleet.edge.sync",
          params: { payload },
        });
        assert.ok(response && !Array.isArray(response) && "result" in response, JSON.stringify(response));
        return response.result as Record<string, unknown>;
      };

      let forkAuthority = oldAuthority;
      const fork = await fleetNodeClaimFixture(
        t,
        undefined,
        undefined,
        undefined,
        () => forkAuthority,
        false,
        undefined,
        undefined,
        undefined,
        { replicaAdmission: true },
      );
      const forkLoginProxy = await listenFleetLoginProxy(t, {
        key: readFileSync(path.join(fork.root, "tls.key")),
        cert: readFileSync(path.join(fork.root, "tls.crt")),
        keycloak: fork.owners.keycloak,
      });
      forkAuthority = {
        url: forkLoginProxy.url,
        realm: "harness",
        clientId: "harness-node-node-one",
        servername: "localhost",
        certificate: forkLoginProxy.certificate,
      };
      assert.equal(
        (
          await fork.command("center-node", {
            kind: "task-create",
            taskId: "divergent-center-history",
            title: "Different history",
          })
        ).outcome,
        "applied",
      );
      await fork.center.close();
      await fork.closeHost(fork.host);
      const forkEpochAuthority = openPersistentWriterEpoch({
        stateRoot: fork.writerEpochStateRoot,
        holderId: "fork-center",
        initialEpochFloor: activatedEpoch,
      });
      try {
        forkEpochAuthority.acquire(repoId, activatedEpoch);
      } finally {
        forkEpochAuthority.close();
      }
      const forkHost = await fork.openHost(),
        forkCenter = await fork.openCenter(forkHost);
      const forkSpkiSha256 = createSpkiSha256(readFileSync(path.join(fork.root, "tls.crt"))),
        forked = await repoint({
          ...repointPayload,
          port: forkCenter.port,
          caPath: path.join(fork.root, "tls.crt"),
          spkiSha256: forkSpkiSha256,
        });
      assert.equal(forked.code, "lineage_tip_mismatch", JSON.stringify(forked));
      assert.deepEqual(readFleetEdgeConfig(edge.edgeUser, repoId), originalEdgeConfig);
      assert.equal(readReplicaGeneration(edgeViewDir)?.id, priorGenerationId);

      const repointed = await repoint(repointPayload);
      assert.equal(repointed.ok, true, JSON.stringify(repointed));
      assert.equal(repointed.basebackup, false);
      assert.equal(repointed.lastAppliedRevision, priorRevision);
      assert.equal(Number(repointed.writerEpoch), activatedEpoch);
      assert.ok(Number(repointed.writerEpoch) > oldEpoch);
      assert.equal(readFleetEdgeConfig(edge.edgeUser, repoId)?.port, newCenter.port);
      assert.equal(readFleetEdgeConfig(edge.edgeUser, repoId)?.writerEpoch, repointed.writerEpoch);
      assert.equal(readFileSync(localMarker, "utf8"), "operator-owned state\n");
      assert.equal(await waitForFleetReplicaReady({ viewRoot: edge.viewRoot, repoId, nodeId: "node-one" }), true);
      const edgeWrite = await edge.command({
        kind: "task-create",
        taskId: "edge-write-after-repoint",
        title: "Authenticated write after repoint",
      });
      assert.equal(edgeWrite.outcome, "applied", JSON.stringify(edgeWrite));
      const writtenHead = openSqliteEventStore({ rootInput: newCenterRoot, repoId, readOnly: true });
      let writtenSequence: number, writtenRevision: number;
      try {
        writtenSequence = writtenHead.replicationPosition().sequence;
        writtenRevision = writtenHead.revision();
      } finally {
        writtenHead.close();
      }
      assert.ok(writtenSequence > importedSequence);
      await waitForFleetReplicaSequence(
        { viewRoot: edge.viewRoot, repoId, nodeId: "node-one" },
        writtenSequence,
        AbortSignal.timeout(30_000),
      );
      assert.equal(readReplicaGeneration(edgeViewDir)?.metadata.position.revision, writtenRevision);
      assert.deepEqual(basebackupRepos, []);

      await edge.host.close();
      await newCenter.close();
      newCenter = null;
      await newHost.close();
      newHost = null;
      await restartedOldCenter.close();
      restartedOldCenter = null;
      await oldCenter.closeHost(restartedOldHost);
      restartedOldHost = null;
      await forkCenter.close();
      await fork.closeHost(forkHost);

      const edgeStateRoot = path.join(edge.edgeUser, "fleet"),
        replica = readReplicaGeneration(edgeViewDir);
      assert.ok(replica);
      const replicaLedger = openSqliteEventStore({
        repoId,
        databasePath: replica.ledgerPath,
        generation: replica.metadata.ledgerGeneration,
        readOnly: true,
      });
      let replicaHistory: string, replicaEpoch: number;
      try {
        replicaHistory = replicaLedger.replicationPosition().history;
        replicaEpoch = replicaLedger.writerFence()?.epoch ?? 0;
      } finally {
        replicaLedger.close();
      }
      assert.ok(replicaEpoch > 0);
      const runningDaemon = createServer(),
        daemonEndpoint = localUserDaemonEndpoint(edge.edgeUser, "edge-daemon"),
        listening = once(runningDaemon, "listening");
      if (process.platform !== "win32") mkdirSecurely(path.dirname(daemonEndpoint));
      runningDaemon.listen(daemonEndpoint);
      await listening;
      const promotionAuditPath = promoteFromEdgeAuditPath(edgeStateRoot, repoId),
        writerEpochPath = path.join(edgeStateRoot, "writer-epochs", `${repoId}.sqlite`),
        writerEpochBefore = readWriterEpochState(edgeStateRoot, repoId);
      const missingConfirmation = await promote(edge.edgeRoot, edge.edgeUser, edgeStateRoot, ["--force-new-epoch"]);
      assert.equal(missingConfirmation.exitCode, 2);
      assert.equal(missingConfirmation.receipt.code, "missing_confirmation");
      assert.deepEqual(readWriterEpochState(edgeStateRoot, repoId), writerEpochBefore);
      assert.equal(existsSync(promotionAuditPath), false);
      const missingEpochConfirmation = await promote(edge.edgeRoot, edge.edgeUser, edgeStateRoot, [
        "--confirm-possible-tail-loss",
      ]);
      assert.equal(missingEpochConfirmation.exitCode, 2);
      assert.equal(missingEpochConfirmation.receipt.code, "missing_confirmation");
      assert.deepEqual(readWriterEpochState(edgeStateRoot, repoId), writerEpochBefore);
      assert.equal(existsSync(promotionAuditPath), false);
      const running = await promote(edge.edgeRoot, edge.edgeUser, edgeStateRoot, [
        "--force-new-epoch",
        "--confirm-possible-tail-loss",
      ]);
      assert.equal(running.exitCode, 2);
      assert.equal(running.receipt.code, "edge_daemon_running");
      await new Promise<void>((resolve) => runningDaemon.close(() => resolve()));
      assert.deepEqual(readWriterEpochState(edgeStateRoot, repoId), writerEpochBefore);
      assert.equal(existsSync(promotionAuditPath), false);

      const staleLocalStore = makeTaskEventStore({
        repoId,
        rootDir: edge.edgeRoot,
        activationPreflight: activateEmptyCanonicalGeneration,
        writerFence: () => ({ repoId, holderId: "stale-edge-local", epoch: 2 }),
      });
      await staleLocalStore.drain();
      const staleLedger = openSqliteEventStore({ rootInput: edge.edgeRoot, repoId, readOnly: true });
      let staleHistory: string;
      try {
        staleHistory = staleLedger.replicationPosition().history;
      } finally {
        staleLedger.close();
      }
      closeSqliteEventStoresUnder(edge.edgeRoot);

      const unchangedWorkspace = openSqliteEventStore({ rootInput: edge.edgeRoot, repoId, readOnly: true });
      try {
        const epochBeforeMissingConfirmation = readWriterEpochState(edgeStateRoot, repoId);
        const rejected = await promote(edge.edgeRoot, edge.edgeUser, edgeStateRoot, ["--force-new-epoch"]);
        assert.equal(rejected.exitCode, 2);
        assert.equal(rejected.receipt.code, "missing_confirmation");
        assert.deepEqual(readWriterEpochState(edgeStateRoot, repoId), epochBeforeMissingConfirmation);
        assert.equal(unchangedWorkspace.replicationPosition().history, staleHistory);
      } finally {
        unchangedWorkspace.close();
      }
      assert.equal(existsSync(promoteFromEdgeAuditPath(edgeStateRoot, repoId)), false);

      const pointerPath = path.join(edgeViewDir, "current.json"),
        originalPointer = readFileSync(pointerPath, "utf8"),
        writerEpochBeforeMismatch = readWriterEpochState(edgeStateRoot, repoId),
        pointer = JSON.parse(originalPointer) as {
          readonly metadata: { readonly position: { readonly revision: number } };
        };
      writeFileSync(
        pointerPath,
        JSON.stringify({
          ...pointer,
          metadata: {
            ...pointer.metadata,
            position: { ...pointer.metadata.position, revision: pointer.metadata.position.revision + 1 },
          },
        }),
      );
      const mismatchedPointer = await promote(edge.edgeRoot, edge.edgeUser, edgeStateRoot, [
        "--force-new-epoch",
        "--confirm-possible-tail-loss",
      ]);
      assert.equal(mismatchedPointer.exitCode, 2);
      assert.equal(mismatchedPointer.receipt.code, "edge_replica_integrity_failed");
      assert.equal(existsSync(promoteFromEdgeAuditPath(edgeStateRoot, repoId)), false);
      const unchangedAfterMismatch = openSqliteEventStore({ rootInput: edge.edgeRoot, repoId, readOnly: true });
      try {
        assert.equal(unchangedAfterMismatch.replicationPosition().history, staleHistory);
      } finally {
        unchangedAfterMismatch.close();
      }
      assert.deepEqual(readWriterEpochState(edgeStateRoot, repoId), writerEpochBeforeMismatch);
      writeFileSync(pointerPath, originalPointer);

      const promoted = await promote(edge.edgeRoot, edge.edgeUser, edgeStateRoot, [
        "--force-new-epoch",
        "--confirm-possible-tail-loss",
        "--holder-id",
        "promoted-edge-center",
        "--rbac-backup-status",
        "unknown",
      ]);
      assert.equal(promoted.exitCode, 0, JSON.stringify(promoted.receipt));
      assert.equal(promoted.receipt.event, "center_emergency_promoted");
      assert.equal(promoted.receipt.oldEpoch, replicaEpoch);
      assert.equal(promoted.receipt.newEpoch, replicaEpoch + 1);
      assert.notEqual(promoted.receipt.replicationHistory, replicaHistory);
      assert.equal(promoted.receipt.replicationSequence, 0);
      assert.equal(promoted.receipt.rbacBackupStatus, "unknown");
      assert.match(String(promoted.receipt.nextAction), /RBAC backup/iu);
      assert.equal(existsSync(promoteFromEdgeAuditPath(edgeStateRoot, repoId)), true);
      assert.equal(typeof promoted.receipt.displacedGenerationPath, "string");

      const retained = openSqliteEventStore({
        repoId,
        databasePath: path.join(String(promoted.receipt.displacedGenerationPath), "ledger.sqlite"),
        generation: 3,
        readOnly: true,
      });
      try {
        assert.equal(retained.replicationPosition().history, staleHistory);
      } finally {
        retained.close();
      }
      const promotedLedger = openSqliteEventStore({ rootInput: edge.edgeRoot, repoId, readOnly: true });
      try {
        assert.equal(promotedLedger.replicationPosition().history, promoted.receipt.replicationHistory);
        assert.equal(promotedLedger.writerFence()?.epoch, promoted.receipt.newEpoch);
        assert.equal(promotedLedger.revision(), replica.metadata.position.revision);
      } finally {
        promotedLedger.close();
      }
      const audit = JSON.parse(readFileSync(promoteFromEdgeAuditPath(edgeStateRoot, repoId), "utf8")) as Record<
        string,
        unknown
      >;
      assert.equal(audit.event, "center_emergency_promoted");
      assert.equal(audit.forceNewEpoch, true);
      assert.equal(audit.possibleTailLossConfirmed, true);

      mkdirSync(path.join(edge.edgeUser, "rbac"), { recursive: true });
      writeFileSync(
        path.join(edge.edgeUser, "rbac", "config.json"),
        readFileSync(path.join(newUserRoot, "rbac", "config.json")),
      );
      writeFileSync(
        path.join(edge.edgeUser, "rbac", "center-client-secret"),
        readFileSync(path.join(newUserRoot, "rbac", "center-client-secret")),
      );
      registerDaemonRepo({
        canonicalRoot: edge.edgeRoot,
        repoId,
        userRoot: edge.edgeUser,
        mode: "local",
        createConvenienceLinks: false,
      });
      promotedHost = await openDaemonHost({
        daemonId: "edge-daemon",
        userRoot: edge.edgeUser,
        oidc: createIdentitySession(edge.edgeUser, { fetch: oldCenter.owners.keycloak.fetch }),
      });
      await promotedHost.attachmentsSettled();
      const promotedCenter = await promotedHost.fleet.startCenter(
        {
          port: 0,
          bind: "127.0.0.1",
          keyPath: targetTls.keyPath,
          certPath: targetTls.certPath,
          repoId,
          quotaBytes: 64 * 1024 * 1024,
        },
        auth,
      );
      assert.equal(
        (promotedCenter as { readonly outcome?: string }).outcome,
        "applied",
        JSON.stringify(promotedCenter),
      );
      const promotedWrite = await promotedHost.run(
        repoId,
        { kind: "task-create", taskId: "promoted-center-write", title: "Write on promoted center" },
        auth,
      );
      assert.equal(promotedWrite.outcome, "applied", JSON.stringify(promotedWrite));
    } finally {
      if (newCenter) await newCenter.close();
      if (newHost) await newHost.close();
      if (restartedOldCenter) await restartedOldCenter.close();
      if (restartedOldHost) await restartedOldHost.close();
      if (promotedHost) await promotedHost.close();
      closeSqliteEventStoresUnder(root);
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

async function promote(
  root: string,
  userRoot: string,
  stateRoot: string,
  confirmations: readonly string[],
): Promise<Awaited<ReturnType<typeof relocateFleetCenter>>> {
  return await relocateFleetCenter(
    [
      "daemon",
      "fleet",
      "center",
      "promote-from-edge",
      "--root",
      root,
      "--repo",
      "lease-repo",
      "--state-root",
      stateRoot,
      "--user-root",
      userRoot,
      "--daemon-id",
      "edge-daemon",
      ...confirmations,
    ],
    userRoot,
  );
}

function readWriterEpochState(stateRoot: string, repoId: string) {
  const databasePath = path.join(stateRoot, "writer-epochs", `${repoId}.sqlite`);
  if (!existsSync(databasePath)) return null;
  const authority = openPersistentWriterEpoch({ stateRoot, holderId: "promotion-test-reader" });
  try {
    return {
      current: authority.current(repoId),
      highWatermark: authority.highWatermark(repoId),
    };
  } finally {
    authority.close();
  }
}

async function listenFleetLoginProxy(
  t: TestContext,
  input: {
    readonly key: Buffer;
    readonly cert: Buffer;
    readonly keycloak: { readonly fetch: typeof fetch };
  },
): Promise<{
  readonly url: string;
  readonly certificate: string;
}> {
  const certificate = input.cert.toString("utf8");
  const loginServer = createHttpsServer({ key: input.key, cert: input.cert }, (request, response) => {
    void (async () => {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      const url = new URL(request.url ?? "/", "https://localhost"),
        answer = await input.keycloak.fetch(`https://fixture-keycloak.invalid${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers as Record<string, string>,
          ...(raw === "" ? {} : { body: new URLSearchParams(raw) }),
        });
      response.statusCode = answer.status;
      response.setHeader("content-type", "application/json");
      response.end(Buffer.from(await answer.arrayBuffer()));
    })().catch(() => {
      response.statusCode = 500;
      response.end("{}");
    });
  });
  loginServer.listen(0, "127.0.0.1");
  await once(loginServer, "listening");
  const address = loginServer.address();
  assert.ok(address && typeof address !== "string");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        loginServer.closeAllConnections();
        loginServer.close(() => resolve());
      }),
  );
  return { url: `https://localhost:${address.port}`, certificate };
}

function createTestCertificate(directory: string): {
  readonly key: Buffer;
  readonly cert: Buffer;
  readonly keyPath: string;
  readonly certPath: string;
  readonly spkiSha256: string;
} {
  mkdirSync(directory, { recursive: true });
  const keyPath = path.join(directory, "tls.key"),
    certPath = path.join(directory, "tls.crt");
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
  const cert = readFileSync(certPath),
    key = readFileSync(keyPath),
    spkiSha256 = createSpkiSha256(cert);
  return { key, cert, keyPath, certPath, spkiSha256 };
}

function createSpkiSha256(certificate: Buffer): string {
  return createHash("sha256")
    .update(new X509Certificate(certificate).publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
}
