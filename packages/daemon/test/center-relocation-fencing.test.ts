// harness-test-tier: contract
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  centerMovedFleetFault,
  readListenerCenterRelocated,
} from "../src/daemon-host/fleet/center-listener-relocation.ts";
import { serializeFleetFrame } from "../src/daemon-host/fleet/command-protocol.ts";
import {
  FleetRemoteError,
  readFleetRepositoryMetadataClient,
  runFleetTaskCommandClient,
} from "../src/daemon-host/fleet/peer.ts";
import { auth, rosterRepo } from "./daemon-host-recovery.fixture.ts";
import { fleetNodeOwners } from "./fleet-store.fixture.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";

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
    rmSync(userRoot, { recursive: true, force: true });
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
    } finally {
      if (host1) await host1.close();
      if (host2) await host2.close();
      await owners.close();
      closeSqliteEventStoresUnder(root);
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
