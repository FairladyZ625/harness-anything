// harness-test-tier: contract
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as cryptoSign, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearCenterMigrating,
  closeSqliteEventStoresUnder,
  enterCenterMigrating,
  retireCenter,
} from "@harness-anything/storage";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { openDaemonWriterEpochs } from "../src/daemon-host/daemon-host-writer-epoch.ts";
import {
  fleetEdgeConfigDir,
  fleetEdgeConfigPath,
  readFleetEdgeConfig,
  writeFleetEdgeConfig,
} from "../src/daemon-host/client/fleet-edge-config.ts";
import { syncFleetEdgeMirror, type FleetEdgeSyncConfigFence } from "../src/daemon-host/fleet-center-admission.ts";
import { autoRepointFleetEdgeOnCenterMovedInsideFence } from "../src/daemon-host/fleet-edge-auto-repoint.ts";
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
import { runFleetReplicaSync, waitForFleetReplicaReady } from "../src/daemon-host/fleet/replica-sync.ts";
import {
  CENTER_MOVED_DETAILS_CAPABILITY,
  ReplicationDecoder,
  serializeReplicationFrame,
  SNAPSHOT_RESUME_CAPABILITY,
} from "../src/fleet-sync/fleet/protocol.ts";
import { auth, rosterRepo } from "./daemon-host-recovery.fixture.ts";
import { fleetHostWriterOptions, fleetNodeOwners } from "./fleet-store.fixture.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

function derNode(tag: number, content: Buffer): Buffer {
  const len = content.length,
    header =
      len < 0x80
        ? Buffer.from([tag, len])
        : len < 0x100
          ? Buffer.from([tag, 0x81, len])
          : Buffer.from([tag, 0x82, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([header, content]);
}

function utcTime(date: Date): Buffer {
  const iso = date
    .toISOString()
    .slice(2)
    .replace(/[-:T]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
  return derNode(0x17, Buffer.from(iso, "ascii"));
}

function writeSelfSignedLocalhostCertificate(keyPath: string, certPath: string): void {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
    spki = publicKey.export({ type: "spki", format: "der" }),
    ecdsaWithSha256 = derNode(0x30, Buffer.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])),
    cnAttr = derNode(
      0x30,
      Buffer.concat([Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]), derNode(0x0c, Buffer.from("localhost", "utf8"))]),
    ),
    name = derNode(0x30, derNode(0x31, cnAttr)),
    now = Date.now(),
    validity = derNode(0x30, Buffer.concat([utcTime(new Date(now - 60_000)), utcTime(new Date(now + 86_400_000))])),
    sanValue = derNode(
      0x30,
      Buffer.concat([derNode(0x82, Buffer.from("localhost", "ascii")), derNode(0x87, Buffer.from([127, 0, 0, 1]))]),
    ),
    sanExt = derNode(0x30, Buffer.concat([Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x11]), derNode(0x04, sanValue)])),
    extensions = derNode(0xa3, derNode(0x30, sanExt)),
    tbs = derNode(
      0x30,
      Buffer.concat([
        derNode(0xa0, Buffer.from([0x02, 0x01, 0x02])),
        Buffer.from([0x02, 0x01, 0x01]),
        ecdsaWithSha256,
        name,
        validity,
        name,
        spki,
        extensions,
      ]),
    ),
    signature = cryptoSign("sha256", tbs, privateKey),
    certDer = derNode(
      0x30,
      Buffer.concat([tbs, ecdsaWithSha256, derNode(0x03, Buffer.concat([Buffer.from([0x00]), signature]))]),
    ),
    lines = certDer.toString("base64").match(/.{1,64}/gu) ?? [];
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(certPath, `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`);
}

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
