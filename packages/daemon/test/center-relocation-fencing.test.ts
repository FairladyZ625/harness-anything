// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  clearCenterMigrating,
  closeSqliteEventStoresUnder,
  enterCenterMigrating,
  openSqliteEventStore,
  retireCenter,
} from "@harness-anything/storage";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { openDaemonWriterEpochs } from "../src/daemon-host/daemon-host-writer-epoch.ts";
import {
  fleetEdgeConfigDir,
  fleetEdgeConfigPath,
  readFleetEdgeConfig,
  readFleetEdgePendingRepoint,
  writeFleetEdgeConfig,
} from "../src/daemon-host/client/fleet-edge-config.ts";
import {
  repointFleetEdgeMirrorFenced,
  syncFleetEdgeMirror,
  type FleetEdgeSyncConfigFence,
} from "../src/daemon-host/fleet-center-admission.ts";
import { autoRepointFleetEdgeOnCenterMovedInsideFence } from "../src/daemon-host/fleet-edge-auto-repoint.ts";
import { locateFleetMirrorView } from "../src/daemon-host/fleet-edge-mirror.ts";
import {
  centerMovedFleetFault,
  readListenerCenterRelocated,
} from "../src/daemon-host/fleet/center-listener-relocation.ts";
import { listenFleetTls } from "../src/daemon-host/fleet/center.ts";
import { serializeFleetFrame } from "../src/daemon-host/fleet/command-protocol.ts";
import {
  FleetRemoteError,
  readFleetRepositoryMetadataClient,
  runFleetReplicaStream,
  runFleetTaskCommandClient,
} from "../src/daemon-host/fleet/peer.ts";
import { currentFleetProtocolVersion } from "../src/daemon-host/fleet/command-protocol.ts";
import {
  runFleetReplicaSync,
  waitForFleetReplicaReady,
  waitForFleetReplicaRevision,
} from "../src/daemon-host/fleet/replica-sync.ts";
import { readReplicaGeneration } from "../src/fleet-sync/fleet/replica-generation.ts";
import { readReplicaHealth } from "../src/fleet-sync/fleet/replica-health.ts";
import {
  CENTER_MOVED_DETAILS_CAPABILITY,
  ReplicationDecoder,
  serializeReplicationFrame,
  SNAPSHOT_RESUME_CAPABILITY,
} from "../src/fleet-sync/fleet/protocol.ts";
import {
  createFencingStreamHooks,
  setupThreeCenterFencingFixture,
  startFencingCenter,
  writeSelfSignedLocalhostCertificate,
} from "./center-relocation-fencing.fixture.ts";
import { auth, rosterRepo } from "./daemon-host-recovery.fixture.ts";
import { fleetHostWriterOptions, fleetNodeOwners } from "./fleet-store.fixture.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

test("retired center fences daemon writer epochs and serializes clean CENTER_MOVED fleet error frames", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-daemon-center-moved-"));
  try {
    const tombstone = retireCenter({
      userRoot,
      repoId: "center-test",
      oldEpoch: 5,
      finalRevision: 42,
      tipHash: `sha256:${"a".repeat(64)}`,
      newExternalUrl: "https://new-center.example.invalid:9443",
      newLoginUrl: "https://new-login.example.invalid",
      spkiSha256: `sha256:${"b".repeat(64)}`,
    });
    const epochs = openDaemonWriterEpochs({
      userRoot,
      daemonId: "test",
      now: () => "2026-11-20T00:00:00.000Z",
    });
    try {
      assert.throws(
        () => epochs.writerEpochLease("center-test"),
        (error: unknown) => {
          const candidate = error as {
            readonly code?: unknown;
            readonly centerMoved?: Record<string, unknown>;
          };
          assert.equal(candidate.code, "CENTER_MOVED");
          assert.deepEqual(candidate.centerMoved, {
            newExternalUrl: tombstone.newExternalUrl,
            newLoginUrl: tombstone.newLoginUrl,
            newEpoch: 6,
            spkiSha256: tombstone.spkiSha256,
          });
          return true;
        },
      );
    } finally {
      epochs.closeDaemonWriterEpoch();
    }

    const observed = readListenerCenterRelocated({
      stateRoot: path.join(userRoot, "fleet"),
      relocationRoot: userRoot,
    } as Parameters<typeof readListenerCenterRelocated>[0]);
    assert.ok(observed !== null);
    const fault = centerMovedFleetFault(observed);
    const serialized = serializeFleetFrame({
      schema: "fleet.error/v1",
      messageId: "msg_error_1",
      inReplyTo: "msg_req_1",
      code: fault.code,
      message: fault.message,
      retryable: fault.retryable,
      resumeOffset: fault.resumeOffset,
      centerMoved: fault.centerMoved,
    });
    const parsed = JSON.parse(serialized.trim()) as {
      readonly code: string;
      readonly centerMoved: Record<string, unknown>;
    };
    assert.equal(parsed.code, "CENTER_MOVED");
    assert.deepEqual(parsed.centerMoved, {
      newExternalUrl: tombstone.newExternalUrl,
      newLoginUrl: tombstone.newLoginUrl,
      newEpoch: 6,
      spkiSha256: tombstone.spkiSha256,
    });
  } finally {
    removeTempRepository(userRoot);
  }
});

test(
  "real openDaemonHost and TLS center listener enforce CENTER_MIGRATING freeze, survive retire + restart with structured CENTER_MOVED, and keep sibling repos working",
  { timeout: 60_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-center-restart-fencing-")),
      userRoot = path.join(root, "user"),
      movedRepoDir = path.join(root, "moved-repo"),
      activeRepoDir = path.join(root, "active-repo"),
      keyPath = path.join(root, "center.key"),
      certPath = path.join(root, "center.crt"),
      daemonId = "reloc-fencing-host";

    rosterRepo(movedRepoDir, "moved-repo");
    rosterRepo(activeRepoDir, "active-repo");
    registerDaemonRepo({ canonicalRoot: movedRepoDir, repoId: "moved-repo", userRoot, createConvenienceLinks: false });
    registerDaemonRepo({
      canonicalRoot: activeRepoDir,
      repoId: "active-repo",
      userRoot,
      createConvenienceLinks: false,
    });

    writeSelfSignedLocalhostCertificate(keyPath, certPath);
    const caCert = readFileSync(certPath),
      owners = await fleetNodeOwners({
        userRoot,
        owners: { "node-one": "person-owner" },
        repoIds: ["moved-repo", "active-repo"],
        localPersonId: "person-owner",
      });
    owners.keycloak.accessAdmin("person-owner");

    let host1: Awaited<ReturnType<typeof openDaemonHost>> | null = null,
      host2: Awaited<ReturnType<typeof openDaemonHost>> | null = null;
    try {
      host1 = await openDaemonHost({ daemonId, userRoot });
      await host1.attachmentsSettled();

      const startedCenter = (await host1.fleet.startCenter(
        {
          port: 0,
          bind: "127.0.0.1",
          keyPath,
          certPath,
          repoId: "moved-repo",
          quotaBytes: 64 * 1024 * 1024,
        },
        auth,
      )) as { readonly outcome?: string; readonly port?: number };
      assert.equal(startedCenter.outcome, "applied", JSON.stringify(startedCenter));
      const port1 = Number(startedCenter.port);
      assert.ok(port1 > 0);

      const baselineWrite = await host1.run(
        "moved-repo",
        { kind: "task-create", taskId: "task_before_reloc", title: "Before relocation" },
        auth,
      );
      assert.equal(baselineWrite.outcome, "applied", JSON.stringify(baselineWrite));

      const peerBase = {
        hostname: "127.0.0.1",
        ca: caCert,
        servername: "localhost",
        nodeId: "node-one",
        credential: "secret-node-one",
        readAccessToken: owners.readAccessToken("node-one"),
        accessToken: "device-token-node-one",
      };
      const baselineMeta = await readFleetRepositoryMetadataClient({
        ...peerBase,
        port: port1,
        repoId: "moved-repo",
      });
      assert.equal(baselineMeta.repoId, "moved-repo");
      const oldEpoch = baselineMeta.writerEpoch;
      assert.ok(oldEpoch >= 1);

      // F1: active CENTER_MIGRATING freeze rejects both local and remote Fleet writes while sibling repos proceed.
      enterCenterMigrating(userRoot, "moved-repo", oldEpoch);
      try {
        const localFrozen = await host1.run(
          "moved-repo",
          { kind: "task-create", taskId: "task_local_frozen", title: "Frozen local write" },
          auth,
        );
        assert.equal(localFrozen.outcome, "op_rejected");
        assert.equal(localFrozen.code, "CENTER_MIGRATING");

        await assert.rejects(
          runFleetTaskCommandClient({
            ...peerBase,
            port: port1,
            writerEpoch: oldEpoch,
            repoId: "moved-repo",
            taskId: "task_fleet_frozen",
            opId: "op_fleet_frozen",
            waitMs: 5_000,
            action: { kind: "task-create", taskId: "task_fleet_frozen", title: "Frozen fleet write" },
          }),
          (error: unknown) => {
            assert.ok(error instanceof FleetRemoteError);
            assert.equal(error.code, "CENTER_MIGRATING");
            assert.equal(error.retryable, true);
            return true;
          },
        );

        const siblingDuringFreeze = await host1.run(
          "active-repo",
          { kind: "task-create", taskId: "task_sibling_during_freeze", title: "Sibling unfrozen" },
          auth,
        );
        assert.equal(siblingDuringFreeze.outcome, "applied", JSON.stringify(siblingDuringFreeze));
      } finally {
        clearCenterMigrating(userRoot, "moved-repo");
      }

      // Retire moved-repo, shut down host1 + TLS center completely, and open a fresh DaemonHost on the same userRoot.
      const tombstone = retireCenter({
        userRoot,
        repoId: "moved-repo",
        oldEpoch,
        finalRevision: 1,
        tipHash: `sha256:${"c".repeat(64)}`,
        newExternalUrl: "https://center2.example.invalid:9443",
        newLoginUrl: "https://login2.example.invalid:8443",
        spkiSha256: `sha256:${"d".repeat(64)}`,
      });
      const expectedCenterMoved = {
        newExternalUrl: tombstone.newExternalUrl,
        newLoginUrl: tombstone.newLoginUrl,
        newEpoch: oldEpoch + 1,
        spkiSha256: tombstone.spkiSha256,
      };

      await host1.close();
      host1 = null;

      host2 = await openDaemonHost({ daemonId, userRoot });
      await host2.attachmentsSettled();

      // Ensure TLS center listener is active on the restarted host (and verify startCenter succeeds on a retired authority repo).
      const restartedCenter = (await host2.fleet.startCenter(
        {
          port: 0,
          bind: "127.0.0.1",
          keyPath,
          certPath,
          repoId: "moved-repo",
          quotaBytes: 64 * 1024 * 1024,
        },
        auth,
      )) as { readonly outcome?: string; readonly port?: number };
      assert.equal(restartedCenter.outcome, "applied", JSON.stringify(restartedCenter));
      const port2 = Number(restartedCenter.port);
      assert.ok(port2 > 0);

      // F3.1 + Evidence (c): local write on restarted retired center returns structured CENTER_MOVED (never repo_unavailable).
      const localMoved = (await host2.run(
        "moved-repo",
        { kind: "task-create", taskId: "task_after_restart", title: "Blocked after restart" },
        auth,
      )) as {
        readonly outcome?: string;
        readonly code?: string;
        readonly centerMoved?: Record<string, unknown>;
      };
      assert.equal(localMoved.outcome, "op_rejected", JSON.stringify(localMoved));
      assert.equal(localMoved.code, "CENTER_MOVED", JSON.stringify(localMoved));
      assert.deepEqual(localMoved.centerMoved, expectedCenterMoved);

      // F3.1 + Evidence (c): remote Fleet metadata read and task command on restarted center return structured CENTER_MOVED.
      await assert.rejects(
        readFleetRepositoryMetadataClient({
          ...peerBase,
          port: port2,
          repoId: "moved-repo",
        }),
        (error: unknown) => {
          assert.ok(error instanceof FleetRemoteError);
          assert.equal(error.code, "CENTER_MOVED");
          assert.deepEqual(error.centerMoved, expectedCenterMoved);
          return true;
        },
      );

      await assert.rejects(
        runFleetTaskCommandClient({
          ...peerBase,
          port: port2,
          writerEpoch: oldEpoch,
          repoId: "moved-repo",
          taskId: "task_remote_after_restart",
          opId: "op_remote_after_restart",
          waitMs: 5_000,
          action: { kind: "task-create", taskId: "task_remote_after_restart", title: "Remote after restart" },
        }),
        (error: unknown) => {
          assert.ok(error instanceof FleetRemoteError);
          assert.equal(error.code, "CENTER_MOVED");
          assert.deepEqual(error.centerMoved, expectedCenterMoved);
          return true;
        },
      );

      await assert.rejects(
        runFleetReplicaStream({
          hostname: "localhost",
          port: port2,
          ca: caCert,
          servername: "localhost",
          nodeId: "node-one",
          credential: "secret-node-one",
          repoId: "moved-repo",
          readAccessToken: owners.readAccessToken("node-one"),
          viewRoot: path.join(root, "edge-view"),
          diskQuotaBytes: 64 * 1024 * 1024,
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal("code" in error ? error.code : undefined, "CENTER_MOVED", error.message);
          return true;
        },
      );

      // F3.2 + Evidence (c): unmoved sibling repo on the same restarted userRoot attaches and serves both local and Fleet requests.
      assert.equal(
        host2.status().repos.find((repo) => repo.repoId === "active-repo")?.state,
        "attached",
        JSON.stringify(host2.status().repos),
      );
      const siblingAfterRestart = await host2.run(
        "active-repo",
        { kind: "task-create", taskId: "task_sibling_after_restart", title: "Sibling works after restart" },
        auth,
      );
      assert.equal(siblingAfterRestart.outcome, "applied", JSON.stringify(siblingAfterRestart));

      const siblingMeta = await readFleetRepositoryMetadataClient({
        ...peerBase,
        port: port2,
        repoId: "active-repo",
      });
      assert.equal(siblingMeta.repoId, "active-repo");
      assert.ok(siblingMeta.writerEpoch >= oldEpoch + 1);

      // F-26862504 mixed-version regression against real retired TLS center listener:
      // 1) N-1 legacy edge (omitting center-moved-details/v1) gets exact 5-key replica.reject with code=CENTER_MOVED and NO centerMoved key.
      // 2) Capable edge (declaring center-moved-details/v1) gets replica.reject WITH structured centerMoved details.
      const readRawRejectFromListener = async (capabilities: readonly string[]) => {
        const accessToken = await owners.readAccessToken("node-one")();
        const socket = await new Promise<import("node:tls").TLSSocket>((resolve, reject) => {
          const candidate = tlsConnect(
            {
              host: "127.0.0.1",
              port: port2,
              ca: caCert,
              servername: "localhost",
              rejectUnauthorized: true,
            },
            () => resolve(candidate),
          );
          candidate.once("error", reject);
        });
        try {
          let buffered = "";
          const nextLine = (): Promise<string> =>
            new Promise<string>((resolve, reject) => {
              const nl = buffered.indexOf("\n");
              if (nl >= 0) {
                const line = buffered.slice(0, nl);
                buffered = buffered.slice(nl + 1);
                resolve(line);
                return;
              }
              const onData = (chunk: Buffer) => {
                buffered += chunk.toString("utf8");
                const idx = buffered.indexOf("\n");
                if (idx >= 0) {
                  socket.off("data", onData);
                  socket.off("error", onErr);
                  const line = buffered.slice(0, idx);
                  buffered = buffered.slice(idx + 1);
                  resolve(line);
                }
              };
              const onErr = (err: Error) => {
                socket.off("data", onData);
                reject(err);
              };
              socket.on("data", onData);
              socket.once("error", onErr);
            });
          socket.write(
            serializeFleetFrame({
              schema: "fleet.session.hello/v1",
              messageId: "n1_hello",
              protocolVersion: currentFleetProtocolVersion,
              nodeId: "node-one",
              credential: "secret-node-one",
              ...(accessToken ? { accessToken } : {}),
            }),
          );
          const ready = JSON.parse(await nextLine()) as { readonly schema?: string };
          assert.equal(ready.schema, "fleet.session.ready/v1");
          socket.write(
            serializeReplicationFrame({
              type: "replica.start",
              repoId: "moved-repo",
              position: null,
              edgeBuildCommit: "legacy01",
              taskEventShapeVersion: 1,
              capabilities,
            }),
          );
          const rawLine = await nextLine();
          const decoded = new ReplicationDecoder().push(Buffer.from(`${rawLine}\n`));
          assert.equal(decoded.length, 1);
          return JSON.parse(rawLine) as Record<string, unknown>;
        } finally {
          socket.destroy();
        }
      };

      const legacyFrame = await readRawRejectFromListener([SNAPSHOT_RESUME_CAPABILITY]);
      assert.equal(legacyFrame.type, "replica.reject");
      assert.equal(legacyFrame.code, "CENTER_MOVED");
      assert.equal(Object.hasOwn(legacyFrame, "centerMoved"), false, JSON.stringify(legacyFrame));
      assert.deepEqual(Object.keys(legacyFrame).sort(), [
        "centerBuildCommit",
        "code",
        "message",
        "taskEventShapeVersion",
        "type",
      ]);

      const modernFrame = await readRawRejectFromListener([
        SNAPSHOT_RESUME_CAPABILITY,
        CENTER_MOVED_DETAILS_CAPABILITY,
      ]);
      assert.equal(modernFrame.type, "replica.reject");
      assert.equal(modernFrame.code, "CENTER_MOVED");
      assert.deepEqual(modernFrame.centerMoved, expectedCenterMoved);
    } finally {
      if (host1) await host1.close();
      if (host2) await host2.close();
      await owners.close();
      closeSqliteEventStoresUnder(root);
      removeTempRepository(root);
    }
  },
);

test(
  "F-26862501 & F-26862502: auto-repoint keeps fleet-edge.json & PEM intact when stream confirmation fails and shares config-write fence with manual sync",
  { timeout: 90_000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-repoint-atomicity-fence-")),
      repoId = "atomic-repo",
      centerUserA = path.join(root, "center-a-user"),
      centerUserB = path.join(root, "center-b-user"),
      edgeUser = path.join(root, "edge-user"),
      repoA = path.join(root, "repo-a"),
      edgeWorkspace = path.join(root, "edge-workspace"),
      viewRoot = path.join(root, "edge-view"),
      keyPathA = path.join(root, "center-a.key"),
      certPathA = path.join(root, "center-a.crt"),
      keyPathB = path.join(root, "center-b.key"),
      certPathB = path.join(root, "center-b.crt");
    rosterRepo(repoA, repoId);
    rosterRepo(edgeWorkspace, repoId);
    writeSelfSignedLocalhostCertificate(keyPathA, certPathA);
    writeSelfSignedLocalhostCertificate(keyPathB, certPathB);
    const certA = readFileSync(certPathA),
      keyA = readFileSync(keyPathA),
      certB = readFileSync(certPathB),
      keyB = readFileSync(keyPathB),
      spkiB = createHash("sha256")
        .update(new X509Certificate(certB).publicKey.export({ type: "spki", format: "der" }))
        .digest("hex");

    registerDaemonRepo({ canonicalRoot: repoA, repoId, userRoot: centerUserA, createConvenienceLinks: false });
    registerDaemonRepo({
      canonicalRoot: edgeWorkspace,
      repoId,
      userRoot: edgeUser,
      mode: "remote-edge",
      createConvenienceLinks: false,
    });
    const owners = await fleetNodeOwners({
      userRoot: centerUserA,
      owners: { "edge-atomic": "person-one" },
      repoIds: [repoId],
      localPersonId: "owner-one",
    });
    owners.bind(centerUserB);
    owners.bind(edgeUser);

    const loginServer = createHttpsServer({ key: keyB, cert: certB }, (req, res) => {
      void (async () => {
        let raw = "";
        for await (const chunk of req) raw += String(chunk);
        const url = new URL(req.url ?? "/", "https://localhost"),
          answer = await owners.keycloak.fetch(`https://fixture-keycloak.invalid${url.pathname}${url.search}`, {
            method: req.method,
            headers: req.headers as Record<string, string>,
            ...(raw === "" ? {} : { body: new URLSearchParams(raw) }),
          });
        res.statusCode = answer.status;
        res.setHeader("content-type", "application/json");
        res.end(Buffer.from(await answer.arrayBuffer()));
      })().catch(() => {
        res.statusCode = 500;
        res.end("{}");
      });
    });
    loginServer.listen(0, "127.0.0.1");
    await once(loginServer, "listening");
    const loginAddr = loginServer.address();
    assert.ok(loginAddr && typeof loginAddr !== "string");
    const loginUrl = `https://localhost:${String(loginAddr.port)}`;
    t.after(
      () =>
        new Promise<void>((resolve) => {
          loginServer.closeAllConnections();
          loginServer.close(() => resolve());
        }),
    );

    const hostA = await openDaemonHost({ daemonId: "center-a-atomic", userRoot: centerUserA });
    let centerA: Awaited<ReturnType<typeof listenFleetTls>> | null = null,
      centerB: Awaited<ReturnType<typeof listenFleetTls>> | null = null,
      activeSyncController: AbortController | null = null,
      activeSyncTask: Promise<void> | null = null;
    try {
      await hostA.attachmentsSettled();
      assert.equal(
        (await hostA.run(repoId, { kind: "task-create", taskId: "atomic-t1", title: "Atomic T1" }, auth)).outcome,
        "applied",
      );
      centerA = await listenFleetTls({
        host: hostA,
        stateRoot: path.join(centerUserA, "fleet"),
        ...fleetHostWriterOptions(centerUserA, [repoId]),
        key: keyA,
        cert: certA,
        hostname: "127.0.0.1",
        port: 0,
        replicaDiskQuotaBytes: 64 * 1024 * 1024,
        authenticate: (nodeId, credential) => credential === `secret-${nodeId}`,
        nodeOwner: owners.nodeOwner,
        verifyHuman: owners.verifyHuman,
        loginAuthority: (nodeId) => ({
          url: loginUrl,
          realm: "harness",
          clientId: `harness-node-${nodeId}`,
          servername: "localhost",
          certificate: certB.toString("utf8"),
        }),
      });
      const oldEpoch = fleetHostWriterOptions(centerUserA, [repoId]).writerEpochLease(repoId).epoch;

      // Seed initial edge config & durable replica cut from Center A with SPKI trustAnchor for B.
      const edgeCaA = path.join(fleetEdgeConfigDir(edgeUser, repoId), "old-center-a.pem");
      mkdirSync(path.dirname(edgeCaA), { recursive: true });
      writeFileSync(edgeCaA, certA, { mode: 0o600 });
      writeFleetEdgeConfig(edgeUser, repoId, {
        repoId,
        host: "127.0.0.1",
        port: centerA.port,
        caPath: edgeCaA,
        servername: "localhost",
        trustAnchors: { spkiSha256: [spkiB] },
        nodeId: "edge-atomic",
        credential: "secret-edge-atomic",
        writerEpoch: oldEpoch,
        viewRoot,
        quotaBytes: 64 * 1024 * 1024,
      });

      const initialStreamAbort = new AbortController(),
        initialStreamTask = runFleetReplicaSync({
          hostname: "127.0.0.1",
          port: centerA.port,
          ca: certA,
          servername: "localhost",
          nodeId: "edge-atomic",
          credential: "secret-edge-atomic",
          repoId,
          viewRoot,
          diskQuotaBytes: 64 * 1024 * 1024,
          readAccessToken: owners.readAccessToken("edge-atomic"),
          signal: initialStreamAbort.signal,
        });
      assert.equal(
        await waitForFleetReplicaReady({ viewRoot, repoId, nodeId: "edge-atomic" }, AbortSignal.timeout(15_000)),
        true,
      );
      initialStreamAbort.abort();
      await initialStreamTask;

      // Stand up Center B sharing the same canonical ledger with persisted writerEpoch = oldEpoch + 1 and window = 1.
      // Between preflight and stream start we advance 2 commits so preflight says resumeAvailable=true,
      // then the actual stream handshake rejects with replication_resume_unavailable!
      let writerEpochB = openDaemonWriterEpochs({ userRoot: centerUserB, daemonId: "center-b-atomic-0" }),
        advancedLeaseB = writerEpochB.writerEpochLease(repoId);
      while (advancedLeaseB.epoch <= oldEpoch) {
        writerEpochB.closeDaemonWriterEpoch();
        writerEpochB = openDaemonWriterEpochs({
          userRoot: centerUserB,
          daemonId: `center-b-atomic-${String(advancedLeaseB.epoch)}`,
        });
        advancedLeaseB = writerEpochB.writerEpochLease(repoId);
      }
      const newEpochB = advancedLeaseB.epoch;
      centerB = await listenFleetTls({
        host: hostA,
        stateRoot: path.join(centerUserB, "fleet"),
        writerEpochStateRoot: path.join(centerUserB, "fleet"),
        writerEpochLease: () => advancedLeaseB,
        replicationRetentionWindowCommits: 1,
        key: keyB,
        cert: certB,
        hostname: "127.0.0.1",
        port: 0,
        replicaDiskQuotaBytes: 64 * 1024 * 1024,
        authenticate: (nodeId, credential) => credential === `secret-${nodeId}`,
        nodeOwner: owners.nodeOwner,
        verifyHuman: owners.verifyHuman,
        loginAuthority: (nodeId) => ({
          url: loginUrl,
          realm: "harness",
          clientId: `harness-node-${nodeId}`,
          servername: "localhost",
          certificate: certB.toString("utf8"),
        }),
      });
      t.after(() => writerEpochB.closeDaemonWriterEpoch());

      const rawConfigBefore = readFileSync(fleetEdgeConfigPath(edgeUser, repoId), "utf8"),
        rawOldPemBefore = readFileSync(edgeCaA, "utf8"),
        expectedStagedPem = path.join(fleetEdgeConfigDir(edgeUser, repoId), `pinned-center-${spkiB.slice(0, 16)}.pem`);

      const makeStreamHooks = (beforeStart?: () => Promise<void> | void) => ({
        startStagedStream: async (stagedConfig: NonNullable<ReturnType<typeof readFleetEdgeConfig>>) => {
          await beforeStart?.();
          activeSyncController = new AbortController();
          activeSyncTask = runFleetReplicaSync({
            hostname: stagedConfig.host,
            port: stagedConfig.port,
            ca: readFileSync(stagedConfig.caPath),
            ...(stagedConfig.servername ? { servername: stagedConfig.servername } : {}),
            ...(stagedConfig.spkiSha256 ? { spkiSha256: stagedConfig.spkiSha256 } : {}),
            ...(stagedConfig.spkiPinOnly ? { spkiPinOnly: true } : {}),
            resumeOnly: stagedConfig.resumeOnly,
            stagedRepointProbe: true,
            nodeId: stagedConfig.nodeId,
            credential: stagedConfig.credential,
            repoId: stagedConfig.repoId,
            viewRoot: stagedConfig.viewRoot,
            diskQuotaBytes: stagedConfig.quotaBytes,
            readAccessToken: owners.readAccessToken("edge-atomic"),
            signal: activeSyncController.signal,
          });
        },
        abortStagedStream: async () => {
          activeSyncController?.abort();
          if (activeSyncTask) await activeSyncTask;
          activeSyncController = null;
          activeSyncTask = null;
        },
        commitStagedStream: () => undefined,
      });

      // F-26862501 Subcase 1: Preflight succeeds (resumeAvailable=true), then Center B advances 2 commits
      // before stream handshake so real walsender rejects with replication_resume_unavailable!
      // Config and old PEM MUST remain byte-for-byte intact and the staged PEM MUST be cleaned up!
      let injectedOverflow = false;
      const startHooksWithShrink = makeStreamHooks(async () => {
        if (injectedOverflow) return;
        injectedOverflow = true;
        assert.equal(
          (await hostA.run(repoId, { kind: "task-create", taskId: "atomic-t2", title: "Shrink window 1" }, auth))
            .outcome,
          "applied",
        );
        assert.equal(
          (await hostA.run(repoId, { kind: "task-create", taskId: "atomic-t3", title: "Shrink window 2" }, auth))
            .outcome,
          "applied",
        );
      });
      await assert.rejects(
        autoRepointFleetEdgeOnCenterMovedInsideFence({
          userRoot: edgeUser,
          workspaceRoot: edgeWorkspace,
          repoId,
          centerMoved: {
            newExternalUrl: `https://127.0.0.1:${String(centerB.port)}`,
            newLoginUrl: loginUrl,
            newEpoch: newEpochB,
            spkiSha256: `sha256:${spkiB}`,
          },
          repointStream: startHooksWithShrink,
          readAccessToken: owners.readAccessToken("edge-atomic"),
          timeoutMs: 15_000,
        }),
        { code: "replication_resume_unavailable" },
      );
      assert.equal(
        readFileSync(fleetEdgeConfigPath(edgeUser, repoId), "utf8"),
        rawConfigBefore,
        "F-26862501: fleet-edge.json MUST NOT be overwritten when new stream rejects resume",
      );
      assert.equal(
        readFileSync(edgeCaA, "utf8"),
        rawOldPemBefore,
        "F-26862501: old PEM referenced by fleet-edge.json MUST remain intact",
      );
      assert.equal(
        existsSync(expectedStagedPem),
        false,
        "F-26862501: uncommitted staged SPKI PEM MUST be removed on failure",
      );

      // F-26862501 Subcase 2: Preflight succeeds on a healthy window, then stream handshake is interrupted/aborted
      // before confirmation -> fleet-edge.json & old PEM remain intact, then recovery succeeds on retry!
      await centerB.close();
      centerB = await listenFleetTls({
        host: hostA,
        stateRoot: path.join(centerUserB, "fleet"),
        writerEpochStateRoot: path.join(centerUserB, "fleet"),
        writerEpochLease: () => advancedLeaseB,
        replicationRetentionWindowCommits: 1024,
        key: keyB,
        cert: certB,
        hostname: "127.0.0.1",
        port: 0,
        replicaDiskQuotaBytes: 64 * 1024 * 1024,
        authenticate: (nodeId, credential) => credential === `secret-${nodeId}`,
        nodeOwner: owners.nodeOwner,
        verifyHuman: owners.verifyHuman,
        loginAuthority: (nodeId) => ({
          url: loginUrl,
          realm: "harness",
          clientId: `harness-node-${nodeId}`,
          servername: "localhost",
          certificate: certB.toString("utf8"),
        }),
      });
      const interruptController = new AbortController();
      await assert.rejects(
        autoRepointFleetEdgeOnCenterMovedInsideFence({
          userRoot: edgeUser,
          workspaceRoot: edgeWorkspace,
          repoId,
          centerMoved: {
            newExternalUrl: `https://127.0.0.1:${String(centerB.port)}`,
            newLoginUrl: loginUrl,
            newEpoch: newEpochB,
            spkiSha256: `sha256:${spkiB}`,
          },
          repointStream: {
            startStagedStream: () => {
              // Simulate interruption right before stream confirms.
              interruptController.abort(new Error("simulated stream interruption during handshake"));
            },
            abortStagedStream: async () => undefined,
            commitStagedStream: () => undefined,
          },
          readAccessToken: owners.readAccessToken("edge-atomic"),
          signal: interruptController.signal,
          timeoutMs: 15_000,
        }),
        /simulated stream interruption/u,
      );
      assert.equal(readFileSync(fleetEdgeConfigPath(edgeUser, repoId), "utf8"), rawConfigBefore);
      assert.equal(readFileSync(edgeCaA, "utf8"), rawOldPemBefore);
      assert.equal(existsSync(expectedStagedPem), false);

      // F-26862502: Shared repo-level config-write fence between manual edge sync and auto-repoint.
      let fenceActive = false,
        transitionSeq = 0;
      const sharedFence: FleetEdgeSyncConfigFence = {
        begin: (id) => {
          if (fenceActive)
            throw Object.assign(new Error(`active transition for ${id}`), { code: "repoint_in_progress" });
          return transitionSeq;
        },
        commit: (id, token, writeAndAdmit) => {
          if (fenceActive)
            throw Object.assign(new Error(`active transition for ${id}`), { code: "repoint_in_progress" });
          if (transitionSeq !== token)
            throw Object.assign(new Error("config changed during sync"), { code: "replica_cut_changed" });
          writeAndAdmit();
        },
      };
      const oldSyncPayload = {
        host: "127.0.0.1",
        port: centerA.port,
        caPath: edgeCaA,
        servername: "localhost",
        trustAnchors: { caPaths: [edgeCaA] },
        nodeId: "edge-atomic",
        credential: "secret-edge-atomic",
        repoId,
        viewRoot,
        quotaBytes: 64 * 1024 * 1024,
        workspaceRoot: edgeWorkspace,
        timeoutMs: 10_000,
      };

      // Subcase 2a: Manual sync starting while auto-repoint holds the fence is rejected immediately.
      fenceActive = true;
      await assert.rejects(
        syncFleetEdgeMirror(
          { userRoot: edgeUser, payload: oldSyncPayload },
          owners.readAccessToken("edge-atomic"),
          undefined,
          sharedFence,
        ),
        { code: "repoint_in_progress" },
      );
      fenceActive = false;

      // Subcase 2b: Manual sync starts BEFORE auto-repoint, pauses in network preflight while auto-repoint
      // succeeds and advances fleet-edge.json to Center B (epoch oldEpoch+1, preserving spkiB trustAnchors).
      // When the late manual sync resumes with valid metadata from old Center A, commit MUST be rejected
      // and MUST NOT revert fleet-edge.json back to Center A or overwrite trustAnchors!
      let releaseLateSync!: () => void, signalSyncEntered!: () => void;
      const syncEntered = new Promise<void>((resolve) => {
        signalSyncEntered = resolve;
      });
      const releaseGate = new Promise<void>((resolve) => {
        releaseLateSync = resolve;
      });
      const lateManualSync = syncFleetEdgeMirror(
        { userRoot: edgeUser, payload: oldSyncPayload },
        async () => {
          signalSyncEntered();
          await releaseGate;
          return owners.readAccessToken("edge-atomic")();
        },
        undefined,
        sharedFence,
      );
      await syncEntered;

      // Now run auto-repoint cleanly to Center B (recovery after Subcase 2 interruption + advancing transitionSeq).
      fenceActive = true;
      transitionSeq += 1;
      try {
        const recovered = await autoRepointFleetEdgeOnCenterMovedInsideFence({
          userRoot: edgeUser,
          workspaceRoot: edgeWorkspace,
          repoId,
          centerMoved: {
            newExternalUrl: `https://127.0.0.1:${String(centerB.port)}`,
            newLoginUrl: loginUrl,
            newEpoch: newEpochB,
            spkiSha256: `sha256:${spkiB}`,
          },
          repointStream: makeStreamHooks(),
          readAccessToken: owners.readAccessToken("edge-atomic"),
          timeoutMs: 15_000,
        });
        assert.equal(recovered.matchedTrustAnchorKind, "spki_pin");
        assert.equal(recovered.receipt.ok, true);
      } finally {
        fenceActive = false;
      }
      const rawConfigAfterRepoint = readFileSync(fleetEdgeConfigPath(edgeUser, repoId), "utf8"),
        parsedAfterRepoint = readFleetEdgeConfig(edgeUser, repoId);
      assert.equal(parsedAfterRepoint?.port, centerB.port);
      assert.equal(parsedAfterRepoint?.writerEpoch, newEpochB);
      assert.equal(parsedAfterRepoint?.spkiPinOnly, true);
      assert.deepEqual(parsedAfterRepoint?.trustAnchors, { spkiSha256: [spkiB] });

      // Release the late manual sync: it MUST fail and leave fleet-edge.json untouched on Center B!
      releaseLateSync();
      await assert.rejects(lateManualSync, { code: "replica_cut_changed" });
      assert.equal(
        readFileSync(fleetEdgeConfigPath(edgeUser, repoId), "utf8"),
        rawConfigAfterRepoint,
        "F-26862502: late manual sync MUST NOT revert auto-repointed fleet-edge.json or overwrite trustAnchors",
      );

      // Subcase 2c: Even a fresh manual sync against old Center A (lower writerEpoch) is refused!
      await assert.rejects(
        syncFleetEdgeMirror(
          { userRoot: edgeUser, payload: oldSyncPayload },
          owners.readAccessToken("edge-atomic"),
          undefined,
          sharedFence,
        ),
        { code: "writer_epoch_not_advanced" },
      );
      assert.equal(readFileSync(fleetEdgeConfigPath(edgeUser, repoId), "utf8"), rawConfigAfterRepoint);
    } finally {
      activeSyncController?.abort();
      if (activeSyncTask) await activeSyncTask;
      if (centerB) await centerB.close();
      if (centerA) await centerA.close();
      await hostA.close();
      await owners.close();
      closeSqliteEventStoresUnder(root);
      removeTempRepository(root);
    }
  },
);

test(
  "F-B3467401 & F-B3467404: interrupted staged repoint after target epoch apply recovers cleanly and legacy resumeOnly resident stream still follows CENTER_MOVED",
  { timeout: 60_000 },
  async (t) => {
    const repoId = "b34674-repo",
      {
        root,
        repoDir,
        edgeWorkspace,
        centerUser,
        edgeUser,
        viewRoot,
        viewDir,
        owners,
        keyA,
        certA,
        keyB,
        certB,
        keyC,
        certC,
        spkiB,
        spkiC,
        loginUrl,
      } = await setupThreeCenterFencingFixture(t, "ha-fencing-b34674-", repoId, "edge-b34");
    const readEdgeLedgerEpoch = (): number => {
      const gen = readReplicaGeneration(viewDir);
      assert.ok(gen);
      const store = openSqliteEventStore({
        databasePath: gen.ledgerPath,
        repoId,
        generation: gen.metadata.ledgerGeneration,
        readOnly: true,
      });
      try {
        return store.writerFence()?.epoch ?? 0;
      } finally {
        store.close();
      }
    };

    const appendEpochBatch = (
      prefix: string,
      count: number,
    ): { readonly seqHead: number; readonly revHead: number } => {
      const store = openSqliteEventStore({ rootInput: repoDir, repoId });
      try {
        const fence = store.writerFence();
        assert.ok(fence);
        for (let i = 1; i <= count; i += 1) {
          const opId = `op_${prefix}_${String(i)}`,
            intentDigest = `sha256:${createHash("sha256").update(opId).digest("hex")}` as const;
          store.appendCommand({
            fence,
            intent: { opId, intentDigest, summary: `${prefix}-${String(i)}` },
            events: [],
            rejectionCode: "paged_interrupt_marker",
          });
        }
        return { seqHead: store.replicationPosition().sequence, revHead: store.revision() };
      } finally {
        store.close();
      }
    };

    const startCenter = (
      activeHost: Awaited<ReturnType<typeof openDaemonHost>>,
      key: Buffer,
      cert: Buffer,
      options: {
        readonly loginCert?: Buffer;
        readonly verifyReplica?: boolean;
        readonly relocationRoot?: string;
      } = {},
    ) => startFencingCenter({ host: activeHost, centerUser, repoId, owners, key, cert, loginUrl, ...options });

    let host: Awaited<ReturnType<typeof openDaemonHost>> | null = null,
      edgeHost: Awaited<ReturnType<typeof openDaemonHost>> | null = null,
      centerA: Awaited<ReturnType<typeof listenFleetTls>> | null = null,
      centerB: Awaited<ReturnType<typeof listenFleetTls>> | null = null,
      centerC: Awaited<ReturnType<typeof listenFleetTls>> | null = null,
      activeSyncController: AbortController | null = null,
      activeSyncTask: Promise<void> | null = null;
    try {
      // 1. Sync initial cut from Center A at oldEpoch.
      host = await openDaemonHost({ daemonId: "center-b34-e1", userRoot: centerUser });
      await host.attachmentsSettled();
      assert.equal(
        (await host.run(repoId, { kind: "task-create", taskId: "b34-t1", title: "Initial A commit" }, auth)).outcome,
        "applied",
      );
      const oldEpoch = fleetHostWriterOptions(centerUser, [repoId]).writerEpochLease(repoId).epoch;
      centerA = await startCenter(host, keyA, certA, { loginCert: certB });
      const edgeCaA = path.join(fleetEdgeConfigDir(edgeUser, repoId), "center-a.pem"),
        edgeCaB = path.join(fleetEdgeConfigDir(edgeUser, repoId), "center-b.pem"),
        edgeCaC = path.join(fleetEdgeConfigDir(edgeUser, repoId), "center-c.pem");
      mkdirSync(path.dirname(edgeCaA), { recursive: true });
      writeFileSync(edgeCaA, certA, { mode: 0o600 });
      writeFileSync(edgeCaB, certB, { mode: 0o600 });
      writeFileSync(edgeCaC, certC, { mode: 0o600 });
      writeFleetEdgeConfig(edgeUser, repoId, {
        repoId,
        host: "127.0.0.1",
        port: centerA.port,
        caPath: edgeCaA,
        servername: "localhost",
        trustAnchors: { spkiSha256: [spkiB, spkiC] },
        nodeId: "edge-b34",
        credential: "secret-edge-b34",
        writerEpoch: oldEpoch,
        viewRoot,
        quotaBytes: 64 * 1024 * 1024,
      });
      const initAbort = new AbortController(),
        initTask = runFleetReplicaSync({
          hostname: "127.0.0.1",
          port: centerA.port,
          ca: certA,
          servername: "localhost",
          nodeId: "edge-b34",
          credential: "secret-edge-b34",
          repoId,
          viewRoot,
          diskQuotaBytes: 64 * 1024 * 1024,
          readAccessToken: owners.readAccessToken("edge-b34"),
          signal: initAbort.signal,
        });
      assert.equal(
        await waitForFleetReplicaReady({ viewRoot, repoId, nodeId: "edge-b34" }, AbortSignal.timeout(15_000)),
        true,
      );
      initAbort.abort();
      await initTask;
      const seqAfterA = readReplicaGeneration(viewDir)!.metadata.position.sequence;
      assert.equal(readEdgeLedgerEpoch(), oldEpoch);

      // 2. Promote canonical ledger to newEpochB = oldEpoch + 1 and write >1 replication page of commits on Center B.
      await centerA.close();
      centerA = null;
      await host.close();
      host = await openDaemonHost({ daemonId: "center-b34-e2", userRoot: centerUser });
      await host.attachmentsSettled();
      const newEpochB = fleetHostWriterOptions(centerUser, [repoId]).writerEpochLease(repoId).epoch;
      assert.ok(newEpochB > oldEpoch);
      assert.equal(
        (await host.run(repoId, { kind: "task-create", taskId: "b34-b1", title: "Center B epoch commit 1" }, auth))
          .outcome,
        "applied",
      );
      const batchB = appendEpochBatch("b34-page-b", 300);
      assert.equal(
        (await host.run(repoId, { kind: "task-create", taskId: "b34-b2", title: "Center B final commit" }, auth))
          .outcome,
        "applied",
      );
      const seqHeadB = batchB.seqHead + 1;
      centerB = await startCenter(host, keyB, certB, { loginCert: certB });
      // Stand up a competing Center C at the SAME epoch newEpochB to prove non-target endpoints remain strictly rejected!
      centerC = await startCenter(host, keyC, certC, { loginCert: certB });

      const makeStreamHooks = (interruptAfterSeq?: {
        readonly minExclusive: number;
        readonly maxExclusive: number;
        readonly abort: AbortController;
      }) =>
        createFencingStreamHooks({
          readAccessToken: owners.readAccessToken("edge-b34"),
          getActive: () => ({ ctrl: activeSyncController, task: activeSyncTask }),
          setActive: (ctrl, task) => {
            activeSyncController = ctrl;
            activeSyncTask = task;
          },
          onReplicaHealthChange: () => {
            if (!interruptAfterSeq || interruptAfterSeq.abort.signal.aborted) return;
            const currentSeq = readReplicaGeneration(viewDir)?.metadata.position.sequence ?? 0;
            if (currentSeq > interruptAfterSeq.minExclusive && currentSeq < interruptAfterSeq.maxExclusive) {
              interruptAfterSeq.abort.abort(new Error("simulated mid-stream interruption after B commit apply"));
              activeSyncController?.abort();
            }
          },
        });

      // F-B3467401 Subcase 1: Interrupt staged auto-repoint AFTER B's first page (writerEpoch = newEpochB) is durably
      // applied to the active edge replica, BEFORE preflight watermark seqHeadB is confirmed!
      const rawConfigA = readFileSync(fleetEdgeConfigPath(edgeUser, repoId), "utf8"),
        genBefore = readReplicaGeneration(viewDir)!.id,
        interruptB = new AbortController();
      await assert.rejects(
        autoRepointFleetEdgeOnCenterMovedInsideFence({
          userRoot: edgeUser,
          workspaceRoot: edgeWorkspace,
          repoId,
          centerMoved: {
            newExternalUrl: `https://127.0.0.1:${String(centerB.port)}`,
            newLoginUrl: loginUrl,
            newEpoch: newEpochB,
            spkiSha256: `sha256:${spkiB}`,
          },
          repointStream: makeStreamHooks({ minExclusive: seqAfterA, maxExclusive: seqHeadB, abort: interruptB }),
          readAccessToken: owners.readAccessToken("edge-b34"),
          signal: interruptB.signal,
          timeoutMs: 15_000,
        }),
        /simulated mid-stream interruption/u,
      );
      const seqAfterInterruptB = readReplicaGeneration(viewDir)!.metadata.position.sequence;
      assert.ok(
        seqAfterInterruptB > seqAfterA && seqAfterInterruptB < seqHeadB,
        `Expected partial B apply (${String(seqAfterA)} < ${String(seqAfterInterruptB)} < ${String(seqHeadB)})`,
      );
      assert.equal(readEdgeLedgerEpoch(), newEpochB, "Active edge replica durably entered B's writer epoch");
      assert.equal(
        readFileSync(fleetEdgeConfigPath(edgeUser, repoId), "utf8"),
        rawConfigA,
        "fleet-edge.json still points to A",
      );
      const pendingB = readFleetEdgePendingRepoint(edgeUser, repoId);
      assert.ok(pendingB, "Durable pending repoint anchor MUST be retained after target epoch apply");
      assert.equal(pendingB.port, centerB.port);
      assert.equal(pendingB.spkiSha256, spkiB);
      assert.equal(pendingB.targetWriterEpoch, newEpochB);

      // Negative controls after interruption: competing Center C at same epoch newEpochB MUST STILL be rejected by BOTH auto & manual repoint!
      await assert.rejects(
        autoRepointFleetEdgeOnCenterMovedInsideFence({
          userRoot: edgeUser,
          workspaceRoot: edgeWorkspace,
          repoId,
          centerMoved: {
            newExternalUrl: `https://127.0.0.1:${String(centerC.port)}`,
            newLoginUrl: loginUrl,
            newEpoch: newEpochB,
            spkiSha256: `sha256:${spkiC}`,
          },
          repointStream: makeStreamHooks(),
          readAccessToken: owners.readAccessToken("edge-b34"),
          timeoutMs: 10_000,
        }),
        { code: "center_moved_epoch_not_advanced" },
      );
      await assert.rejects(
        repointFleetEdgeMirrorFenced(
          {
            userRoot: edgeUser,
            workspaceRoot: edgeWorkspace,
            payload: {
              host: "127.0.0.1",
              port: centerC.port,
              caPath: edgeCaC,
              servername: "localhost",
              spkiSha256: spkiC,
              nodeId: "edge-b34",
              credential: "secret-edge-b34",
              repoId,
              timeoutMs: 10_000,
            },
          },
          owners.readAccessToken("edge-b34"),
          makeStreamHooks(),
        ),
        { code: "writer_epoch_not_advanced" },
      );

      // Positive control 1: Auto-repoint retry after interruption to the exact same legitimate target B SUCCEEDS!
      const autoRecovered = await autoRepointFleetEdgeOnCenterMovedInsideFence({
        userRoot: edgeUser,
        workspaceRoot: edgeWorkspace,
        repoId,
        centerMoved: {
          newExternalUrl: `https://127.0.0.1:${String(centerB.port)}`,
          newLoginUrl: loginUrl,
          newEpoch: newEpochB,
          spkiSha256: `sha256:${spkiB}`,
        },
        repointStream: makeStreamHooks(),
        readAccessToken: owners.readAccessToken("edge-b34"),
        timeoutMs: 15_000,
      });
      assert.equal(autoRecovered.receipt.ok, true);
      assert.equal(autoRecovered.receipt.basebackup, false);
      assert.equal(readFleetEdgeConfig(edgeUser, repoId)?.port, centerB.port);
      assert.equal(readFleetEdgeConfig(edgeUser, repoId)?.writerEpoch, newEpochB);
      assert.equal(
        readFleetEdgePendingRepoint(edgeUser, repoId),
        null,
        "Pending repoint anchor MUST be cleared on commit",
      );
      assert.equal(readReplicaGeneration(viewDir)?.id, genBefore, "Zero basebackup during interrupted staged recovery");
      activeSyncController?.abort();
      if (activeSyncTask) await activeSyncTask;
      activeSyncController = null;
      activeSyncTask = null;

      // F-B3467401 Subcase 2: Advance to newEpochC = newEpochB + 1, interrupt mid-stream after C's first page applies,
      // and verify MANUAL repointFleetEdgeMirrorFenced retry to the exact same legitimate target C SUCCEEDS!
      await centerB.close();
      centerB = null;
      await centerC.close();
      centerC = null;
      await host.close();
      host = await openDaemonHost({ daemonId: "center-b34-e3", userRoot: centerUser });
      await host.attachmentsSettled();
      const newEpochC = fleetHostWriterOptions(centerUser, [repoId]).writerEpochLease(repoId).epoch;
      assert.ok(newEpochC > newEpochB);
      const seqBeforeC = readReplicaGeneration(viewDir)!.metadata.position.sequence;
      assert.equal(
        (await host.run(repoId, { kind: "task-create", taskId: "b34-c1", title: "Center C epoch commit 1" }, auth))
          .outcome,
        "applied",
      );
      const batchC = appendEpochBatch("b34-page-c", 300);
      assert.equal(
        (await host.run(repoId, { kind: "task-create", taskId: "b34-c2", title: "Center C final commit" }, auth))
          .outcome,
        "applied",
      );
      const seqHeadC = batchC.seqHead + 1;
      centerC = await startCenter(host, keyC, certC, { loginCert: certC });
      const interruptC = new AbortController();
      await assert.rejects(
        repointFleetEdgeMirrorFenced(
          {
            userRoot: edgeUser,
            workspaceRoot: edgeWorkspace,
            payload: {
              host: "127.0.0.1",
              port: centerC.port,
              caPath: edgeCaC,
              servername: "localhost",
              spkiSha256: spkiC,
              nodeId: "edge-b34",
              credential: "secret-edge-b34",
              repoId,
              timeoutMs: 15_000,
            },
          },
          owners.readAccessToken("edge-b34"),
          makeStreamHooks({ minExclusive: seqBeforeC, maxExclusive: seqHeadC, abort: interruptC }),
          interruptC.signal,
        ),
        /simulated mid-stream interruption/u,
      );
      assert.equal(readEdgeLedgerEpoch(), newEpochC, "Replica durably entered C's epoch before interruption");
      assert.equal(
        readFleetEdgeConfig(edgeUser, repoId)?.writerEpoch,
        newEpochB,
        "fleet-edge.json still has B's epoch",
      );
      assert.equal(readFleetEdgePendingRepoint(edgeUser, repoId)?.targetWriterEpoch, newEpochC);

      const manualRecovered = await repointFleetEdgeMirrorFenced(
        {
          userRoot: edgeUser,
          workspaceRoot: edgeWorkspace,
          payload: {
            host: "127.0.0.1",
            port: centerC.port,
            caPath: edgeCaC,
            servername: "localhost",
            spkiSha256: spkiC,
            nodeId: "edge-b34",
            credential: "secret-edge-b34",
            repoId,
            timeoutMs: 15_000,
          },
        },
        owners.readAccessToken("edge-b34"),
        makeStreamHooks(),
      );
      assert.equal(manualRecovered.ok, true);
      assert.equal(manualRecovered.basebackup, false);
      assert.equal(readFleetEdgeConfig(edgeUser, repoId)?.port, centerC.port);
      assert.equal(readFleetEdgeConfig(edgeUser, repoId)?.writerEpoch, newEpochC);
      assert.equal(readFleetEdgePendingRepoint(edgeUser, repoId), null);
      activeSyncController?.abort();
      if (activeSyncTask) await activeSyncTask;
      activeSyncController = null;
      activeSyncTask = null;

      // F-B3467404: Persist a legacy `resumeOnly: true` fleet-edge.json pointing at retiring Center A,
      // restart a real resident daemon host, and verify it does NOT early-return on CENTER_MOVED and
      // automatically repoints to Center C at newEpochD = newEpochC + 1!
      await centerC.close();
      centerC = null;
      await host.close();
      host = await openDaemonHost({ daemonId: "center-b34-e4", userRoot: centerUser });
      await host.attachmentsSettled();
      const newEpochD = fleetHostWriterOptions(centerUser, [repoId]).writerEpochLease(repoId).epoch;
      assert.ok(newEpochD > newEpochC);
      assert.equal(
        (
          await host.run(
            repoId,
            { kind: "task-create", taskId: "b34-d1", title: "Post-legacy-resumeOnly commit" },
            auth,
          )
        ).outcome,
        "applied",
      );
      const revD = openSqliteEventStore({ rootInput: repoDir, repoId, readOnly: true });
      const targetRevD = revD.revision();
      revD.close();
      centerC = await startCenter(host, keyC, certC, { loginCert: certB, verifyReplica: true });
      const retiredRoot = path.join(root, "retired-old-a");
      mkdirSync(retiredRoot, { recursive: true });
      retireCenter({
        userRoot: retiredRoot,
        repoId,
        oldEpoch: newEpochD - 1,
        finalRevision: targetRevD,
        tipHash: `sha256:${"c".repeat(64)}`,
        newExternalUrl: `https://127.0.0.1:${String(centerC.port)}`,
        newLoginUrl: loginUrl,
        spkiSha256: `sha256:${spkiC}`,
      });
      centerA = await startCenter(host, keyA, certA, { relocationRoot: retiredRoot });
      writeFleetEdgeConfig(edgeUser, repoId, {
        repoId,
        host: "127.0.0.1",
        port: centerA.port,
        caPath: edgeCaA,
        servername: "localhost",
        trustAnchors: { spkiSha256: [spkiC] },
        nodeId: "edge-b34",
        credential: "secret-edge-b34",
        writerEpoch: newEpochC,
        resumeOnly: true,
        viewRoot,
        quotaBytes: 64 * 1024 * 1024,
      });
      owners.signIn(edgeUser, "edge-b34");
      const lifecycleEvents: unknown[] = [];
      edgeHost = await openDaemonHost({
        daemonId: "edge-b34-legacy-resume",
        userRoot: edgeUser,
        recordLifecycle: (event) => lifecycleEvents.push(event),
      });
      await edgeHost.attachmentsSettled();
      await waitForFleetReplicaRevision(
        { viewRoot, repoId, nodeId: "edge-b34" },
        targetRevD,
        AbortSignal.timeout(20_000),
      ).catch((error) => {
        throw new Error(
          `Legacy resumeOnly auto-repoint did not reach rev ${String(targetRevD)}: ${error instanceof Error ? error.message : String(error)}; health=${JSON.stringify(readReplicaHealth(viewDir))}; config=${JSON.stringify(readFleetEdgeConfig(edgeUser, repoId))}; lifecycle=${JSON.stringify(lifecycleEvents)}`,
        );
      });
      const finalEdgeConfig = readFleetEdgeConfig(edgeUser, repoId);
      assert.equal(
        finalEdgeConfig?.port,
        centerC.port,
        "Legacy resumeOnly:true resident edge MUST follow CENTER_MOVED",
      );
      assert.equal(finalEdgeConfig?.writerEpoch, newEpochD);
      assert.equal(finalEdgeConfig?.resumeOnly, undefined, "Auto-repoint commit clears legacy resumeOnly flag");
      assert.equal(readReplicaGeneration(viewDir)?.id, genBefore, "Zero basebackup on legacy resumeOnly auto-repoint");
    } finally {
      activeSyncController?.abort();
      if (activeSyncTask) await activeSyncTask;
      if (edgeHost) await edgeHost.close();
      if (centerC) await centerC.close();
      if (centerB) await centerB.close();
      if (centerA) await centerA.close();
      if (host) await host.close();
      await owners.close();
      closeSqliteEventStoresUnder(root);
      removeTempRepository(root);
    }
  },
);

test(
  "F-B3467401: edge exiting after projection commit and before current.json publish recovers via auto and manual repoint without basebackup while rejecting wrong targets and corruption",
  { timeout: 90_000 },
  async (t) => {
    const repoId = "b34-crash-repo",
      nodeId = "edge-crash",
      {
        root,
        repoDir,
        edgeWorkspace,
        centerUser,
        edgeUser,
        viewRoot,
        viewDir,
        owners,
        keyA,
        certA,
        keyB,
        certB,
        keyC,
        certC,
        spkiB,
        spkiC,
        loginUrl,
      } = await setupThreeCenterFencingFixture(t, "ha-fencing-b34-crash-", repoId, nodeId),
      currentJsonPath = path.join(viewDir, "current.json");

    const crashHookPath = path.join(root, "crash-before-current-rename.mjs");
    writeFileSync(
      crashHookPath,
      [
        'import fs from "node:fs";',
        'import path from "node:path";',
        'import { syncBuiltinESMExports } from "node:module";',
        "const target = path.resolve(process.env.CRASH_BEFORE_RENAME_TARGET);",
        "const realRenameSync = fs.renameSync;",
        "fs.renameSync = function (oldPath, newPath) {",
        "  if (path.resolve(String(newPath)) === target) process.exit(42);",
        "  return realRenameSync.call(this, oldPath, newPath);",
        "};",
        "syncBuiltinESMExports();",
      ].join("\n"),
    );
    const runCrashChild = (scriptPath: string, extraEnv: Record<string, string>) =>
      new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", crashHookPath, scriptPath], {
          env: { ...process.env, ...extraEnv, CRASH_BEFORE_RENAME_TARGET: currentJsonPath },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("exit", (code) => resolve({ code, stderr }));
      });
    const readEdgeLedgerState = () => {
      const gen = readReplicaGeneration(viewDir)!,
        store = openSqliteEventStore({
          databasePath: gen.ledgerPath,
          repoId,
          generation: gen.metadata.ledgerGeneration,
          readOnly: true,
        });
      try {
        return { epoch: store.writerFence()?.epoch ?? 0, position: store.replicationPosition() };
      } finally {
        store.close();
      }
    };
    const readCenterRevision = () => {
      const store = openSqliteEventStore({ rootInput: repoDir, repoId, readOnly: true });
      try {
        return store.revision();
      } finally {
        store.close();
      }
    };
    const startCenter = (
      h: Awaited<ReturnType<typeof openDaemonHost>>,
      key: Buffer,
      cert: Buffer,
      relocationRoot?: string,
    ) =>
      startFencingCenter({
        host: h,
        centerUser,
        repoId,
        owners,
        key,
        cert,
        loginUrl,
        loginCert: certB,
        verifyReplica: true,
        ...(relocationRoot ? { relocationRoot } : {}),
      });
    const relUrl = (p: string) => pathToFileURL(path.resolve(import.meta.dirname, p)).href,
      daemonHostUrl = relUrl("../src/daemon-host/daemon-host.ts"),
      admissionUrl = relUrl("../src/daemon-host/fleet-center-admission.ts"),
      replicaSyncUrl = relUrl("../src/daemon-host/fleet/replica-sync.ts");

    let host: Awaited<ReturnType<typeof openDaemonHost>> | null = null,
      edgeHost: Awaited<ReturnType<typeof openDaemonHost>> | null = null,
      centerA: Awaited<ReturnType<typeof listenFleetTls>> | null = null,
      centerB: Awaited<ReturnType<typeof listenFleetTls>> | null = null,
      centerC: Awaited<ReturnType<typeof listenFleetTls>> | null = null,
      activeSyncController: AbortController | null = null,
      activeSyncTask: Promise<void> | null = null;
    const makeLocalStreamHooks = () =>
      createFencingStreamHooks({
        readAccessToken: owners.readAccessToken(nodeId),
        getActive: () => ({ ctrl: activeSyncController, task: activeSyncTask }),
        setActive: (ctrl, task) => {
          activeSyncController = ctrl;
          activeSyncTask = task;
        },
      });
    try {
      // 1. Sync initial durable edge cut from Center A at oldEpoch.
      host = await openDaemonHost({ daemonId: "center-crash-e1", userRoot: centerUser });
      await host.attachmentsSettled();
      assert.equal(
        (await host.run(repoId, { kind: "task-create", taskId: "b34-crash-a1", title: "Initial A commit" }, auth))
          .outcome,
        "applied",
      );
      const oldEpoch = fleetHostWriterOptions(centerUser, [repoId]).writerEpochLease(repoId).epoch;
      centerA = await startCenter(host, keyA, certA);
      const edgeCaA = path.join(fleetEdgeConfigDir(edgeUser, repoId), "center-a.pem"),
        edgeCaC = path.join(fleetEdgeConfigDir(edgeUser, repoId), "center-c.pem");
      mkdirSync(path.dirname(edgeCaA), { recursive: true });
      writeFileSync(edgeCaA, certA, { mode: 0o600 });
      writeFileSync(edgeCaC, certC, { mode: 0o600 });
      const initAbort = new AbortController(),
        initTask = runFleetReplicaSync({
          hostname: "127.0.0.1",
          port: centerA.port,
          ca: certA,
          servername: "localhost",
          nodeId,
          credential: `secret-${nodeId}`,
          repoId,
          viewRoot,
          diskQuotaBytes: 64 * 1024 * 1024,
          readAccessToken: owners.readAccessToken(nodeId),
          signal: initAbort.signal,
        });
      assert.equal(await waitForFleetReplicaReady({ viewRoot, repoId, nodeId }, AbortSignal.timeout(15_000)), true);
      initAbort.abort();
      await initTask;
      const genBefore = readReplicaGeneration(viewDir)!.id,
        revAfterA = readReplicaGeneration(viewDir)!.metadata.position.revision;
      assert.equal(readEdgeLedgerState().epoch, oldEpoch);

      // 2. Promote to newEpochB, commit new events on B, and retire A to return CENTER_MOVED -> B.
      await centerA.close();
      centerA = null;
      await host.close();
      host = await openDaemonHost({ daemonId: "center-crash-e2", userRoot: centerUser });
      await host.attachmentsSettled();
      const newEpochB = fleetHostWriterOptions(centerUser, [repoId]).writerEpochLease(repoId).epoch;
      assert.ok(newEpochB > oldEpoch);
      for (const taskId of ["b34-crash-b1", "b34-crash-b2"])
        assert.equal((await host.run(repoId, { kind: "task-create", taskId, title: taskId }, auth)).outcome, "applied");
      const targetRevB = readCenterRevision();
      assert.ok(targetRevB > revAfterA);
      centerB = await startCenter(host, keyB, certB);
      centerC = await startCenter(host, keyC, certC);
      const retiredRootA = path.join(root, "retired-a-crash");
      mkdirSync(retiredRootA, { recursive: true });
      retireCenter({
        userRoot: retiredRootA,
        repoId,
        oldEpoch,
        finalRevision: targetRevB,
        tipHash: `sha256:${"a".repeat(64)}`,
        newExternalUrl: `https://127.0.0.1:${String(centerB.port)}`,
        newLoginUrl: loginUrl,
        spkiSha256: `sha256:${spkiB}`,
      });
      centerA = await startCenter(host, keyA, certA, retiredRootA);
      writeFleetEdgeConfig(edgeUser, repoId, {
        repoId,
        host: "127.0.0.1",
        port: centerA.port,
        caPath: edgeCaA,
        servername: "localhost",
        trustAnchors: { spkiSha256: [spkiB, spkiC] },
        nodeId,
        credential: `secret-${nodeId}`,
        writerEpoch: oldEpoch,
        viewRoot,
        quotaBytes: 64 * 1024 * 1024,
      });
      owners.signIn(edgeUser, nodeId);
      const rawConfigA = readFileSync(fleetEdgeConfigPath(edgeUser, repoId), "utf8");

      // 3. Subcase A (AUTO-REPOINT CRASH BOUNDARY): Real edge daemon exits right before current.json renameSync
      // after B's commit and projection watermark have durably persisted.
      const autoCrashScript = path.join(root, "edge-auto-crash-child.mjs");
      writeFileSync(
        autoCrashScript,
        [
          `import { openDaemonHost } from ${JSON.stringify(daemonHostUrl)};`,
          'const edge = await openDaemonHost({ daemonId: "edge-crash-auto", userRoot: process.env.EDGE_USER_ROOT });',
          "await edge.attachmentsSettled();",
          "await new Promise((resolve) => setTimeout(resolve, 20_000));",
          "await edge.close();",
          "process.exit(1);",
        ].join("\n"),
      );
      const autoCrash = await runCrashChild(autoCrashScript, { EDGE_USER_ROOT: edgeUser });
      assert.equal(autoCrash.code, 42, `Expected exit 42 at current.json publish boundary: ${autoCrash.stderr}`);
      assert.equal(readReplicaGeneration(viewDir)!.metadata.position.revision, revAfterA);
      const viewAfterAutoCrash = locateFleetMirrorView(viewRoot, repoId, nodeId, { includeEntries: false })!,
        ledgerAfterAutoCrash = readEdgeLedgerState();
      assert.ok(viewAfterAutoCrash.revision > revAfterA);
      assert.equal(ledgerAfterAutoCrash.position.revision, viewAfterAutoCrash.revision);
      assert.equal(ledgerAfterAutoCrash.epoch, newEpochB);
      assert.equal(readFileSync(fleetEdgeConfigPath(edgeUser, repoId), "utf8"), rawConfigA);
      assert.equal(readFleetEdgePendingRepoint(edgeUser, repoId)?.port, centerB.port);

      // Negative controls on crashed state: competing Center C at same epoch MUST still be rejected with zero disk mutation.
      await assert.rejects(
        autoRepointFleetEdgeOnCenterMovedInsideFence({
          userRoot: edgeUser,
          workspaceRoot: edgeWorkspace,
          repoId,
          centerMoved: {
            newExternalUrl: `https://127.0.0.1:${String(centerC.port)}`,
            newLoginUrl: loginUrl,
            newEpoch: newEpochB,
            spkiSha256: `sha256:${spkiC}`,
          },
          repointStream: makeLocalStreamHooks(),
          readAccessToken: owners.readAccessToken(nodeId),
          timeoutMs: 10_000,
        }),
        { code: "center_moved_epoch_not_advanced" },
      );
      await assert.rejects(
        repointFleetEdgeMirrorFenced(
          {
            userRoot: edgeUser,
            workspaceRoot: edgeWorkspace,
            payload: {
              host: "127.0.0.1",
              port: centerC.port,
              caPath: edgeCaC,
              servername: "localhost",
              spkiSha256: spkiC,
              nodeId,
              credential: `secret-${nodeId}`,
              repoId,
              timeoutMs: 10_000,
            },
          },
          owners.readAccessToken(nodeId),
          makeLocalStreamHooks(),
        ),
        { code: "writer_epoch_not_advanced" },
      );
      assert.equal(readReplicaGeneration(viewDir)!.metadata.position.revision, revAfterA);
      assert.equal(readFileSync(fleetEdgeConfigPath(edgeUser, repoId), "utf8"), rawConfigA);

      // Restart real edge daemon host on crashed state: retired A returns CENTER_MOVED -> auto-repoint recovers with zero basebackup.
      edgeHost = await openDaemonHost({ daemonId: "edge-crash-auto-restart", userRoot: edgeUser });
      await edgeHost.attachmentsSettled();
      await waitForFleetReplicaRevision({ viewRoot, repoId, nodeId }, targetRevB, AbortSignal.timeout(20_000));
      assert.equal(readFleetEdgeConfig(edgeUser, repoId)?.port, centerB.port);
      assert.equal(readFleetEdgeConfig(edgeUser, repoId)?.writerEpoch, newEpochB);
      assert.equal(readFleetEdgePendingRepoint(edgeUser, repoId), null);
      assert.equal(readReplicaGeneration(viewDir)?.id, genBefore);
      assert.equal(readReplicaGeneration(viewDir)?.metadata.position.revision, targetRevB);
      await edgeHost.close();
      edgeHost = null;

      // 4. Subcase B (MANUAL REPOINT CRASH BOUNDARY): Advance to newEpochC, crash child running manual repoint
      // right before current.json renameSync, then recover via manual repoint to legitimate C with zero basebackup.
      await centerB.close();
      centerB = null;
      await centerC.close();
      centerC = null;
      await host.close();
      host = await openDaemonHost({ daemonId: "center-crash-e3", userRoot: centerUser });
      await host.attachmentsSettled();
      const newEpochC = fleetHostWriterOptions(centerUser, [repoId]).writerEpochLease(repoId).epoch;
      assert.ok(newEpochC > newEpochB);
      for (const taskId of ["b34-crash-c1", "b34-crash-c2"])
        assert.equal((await host.run(repoId, { kind: "task-create", taskId, title: taskId }, auth)).outcome, "applied");
      const targetRevC = readCenterRevision();
      centerC = await startCenter(host, keyC, certC);
      const manualCrashScript = path.join(root, "edge-manual-crash-child.mjs");
      writeFileSync(
        manualCrashScript,
        [
          'import { readFileSync } from "node:fs";',
          `import { repointFleetEdgeMirrorFenced } from ${JSON.stringify(admissionUrl)};`,
          `import { runFleetReplicaSync } from ${JSON.stringify(replicaSyncUrl)};`,
          "const input = JSON.parse(process.env.MANUAL_REPOINT_INPUT);",
          `const readToken = async () => ${JSON.stringify(`node-token-harness-node-${nodeId}`)};`,
          "let ctrl = null, task = null;",
          "await repointFleetEdgeMirrorFenced(input, readToken, {",
          "  startStagedStream: (cfg) => {",
          "    ctrl = new AbortController();",
          "    task = runFleetReplicaSync({ hostname: cfg.host, port: cfg.port, ca: readFileSync(cfg.caPath), ...(cfg.servername ? { servername: cfg.servername } : {}), ...(cfg.spkiSha256 ? { spkiSha256: cfg.spkiSha256 } : {}), resumeOnly: cfg.resumeOnly, stagedRepointProbe: true, nodeId: cfg.nodeId, credential: cfg.credential, repoId: cfg.repoId, viewRoot: cfg.viewRoot, diskQuotaBytes: cfg.quotaBytes, readAccessToken: readToken, signal: ctrl.signal });",
          "  },",
          "  abortStagedStream: async () => { ctrl?.abort(); if (task) await task; },",
          "  commitStagedStream: () => undefined,",
          "});",
          "process.exit(1);",
        ].join("\n"),
      );
      const manualInput = {
        userRoot: edgeUser,
        workspaceRoot: edgeWorkspace,
        payload: {
          host: "127.0.0.1",
          port: centerC.port,
          caPath: edgeCaC,
          servername: "localhost",
          spkiSha256: spkiC,
          nodeId,
          credential: `secret-${nodeId}`,
          repoId,
          timeoutMs: 15_000,
        },
      };
      const manualCrash = await runCrashChild(manualCrashScript, { MANUAL_REPOINT_INPUT: JSON.stringify(manualInput) });
      assert.equal(manualCrash.code, 42, `Expected exit 42 on manual repoint boundary: ${manualCrash.stderr}`);
      assert.equal(readReplicaGeneration(viewDir)!.metadata.position.revision, targetRevB);
      const viewAfterManualCrash = locateFleetMirrorView(viewRoot, repoId, nodeId, { includeEntries: false })!;
      assert.ok(viewAfterManualCrash.revision > targetRevB);
      assert.equal(readEdgeLedgerState().position.revision, viewAfterManualCrash.revision);
      assert.equal(readEdgeLedgerState().epoch, newEpochC);

      const manualRecovered = await repointFleetEdgeMirrorFenced(
        manualInput,
        owners.readAccessToken(nodeId),
        makeLocalStreamHooks(),
      );
      assert.equal(manualRecovered.ok, true);
      assert.equal(manualRecovered.basebackup, false);
      assert.equal(readFleetEdgeConfig(edgeUser, repoId)?.port, centerC.port);
      assert.equal(readFleetEdgeConfig(edgeUser, repoId)?.writerEpoch, newEpochC);
      assert.equal(readFleetEdgePendingRepoint(edgeUser, repoId), null);
      assert.equal(readReplicaGeneration(viewDir)?.id, genBefore);
      assert.equal(readReplicaGeneration(viewDir)?.metadata.position.revision, targetRevC);
      activeSyncController?.abort();
      if (activeSyncTask) await activeSyncTask;
      activeSyncController = null;
      activeSyncTask = null;

      // 5. Negative controls: genuine ledger/current.json corruption STILL hard-rejected with replica_cut_inconsistent.
      const rawCurrentHealthy = readFileSync(currentJsonPath, "utf8"),
        parsedCurrent = JSON.parse(rawCurrentHealthy) as {
          id: string;
          metadata: { position: { history: string; sequence: number; revision: number } };
        };
      for (const badPosition of [
        { ...parsedCurrent.metadata.position, history: "f".repeat(32) },
        { ...parsedCurrent.metadata.position, revision: targetRevC + 10 },
      ]) {
        writeFileSync(
          currentJsonPath,
          JSON.stringify({ ...parsedCurrent, metadata: { ...parsedCurrent.metadata, position: badPosition } }),
        );
        await assert.rejects(
          repointFleetEdgeMirrorFenced(manualInput, owners.readAccessToken(nodeId), makeLocalStreamHooks()),
          { code: "replica_cut_inconsistent" },
        );
      }
      writeFileSync(currentJsonPath, rawCurrentHealthy);
    } finally {
      activeSyncController?.abort();
      if (activeSyncTask) await activeSyncTask;
      if (edgeHost) await edgeHost.close();
      if (centerC) await centerC.close();
      if (centerB) await centerB.close();
      if (centerA) await centerA.close();
      if (host) await host.close();
      await owners.close();
      closeSqliteEventStoresUnder(root);
      removeTempRepository(root);
    }
  },
);
