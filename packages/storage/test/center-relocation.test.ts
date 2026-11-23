// harness-test-tier: contract
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { canonicalLedgerCut } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import {
  exportCenterRelocation,
  importCenterRelocation,
  readCenterMigrating,
  readCenterRelocated,
  retireCenter,
  stageCenterRelocation,
  throwIfCenterMigrating,
  verifyRelocationBundle,
  writeWriterEpochRetirementSeal,
} from "../src/center-relocation.ts";
import { openReplicationSlots } from "../src/fleet-replication-slot.ts";
import { registerSqlBackendAdapters } from "../src/sql-backend-adapters.ts";
import { openSqliteEventStore, sqliteLedgerPath } from "../src/store/sqlite-event-store.ts";
import { closeSqliteEventStoresUnder } from "../src/store/sqlite-ledger-connections.ts";
import { makeTaskEventStore } from "../src/store/task-event-store.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import { configureWriterEpochStorage } from "../src/writer-epoch-storage.ts";
import { bundle, docBundle, eventAt, initRepo } from "./store/task-event-store.fixtures.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

test("relocation import verifies every digest, advances oldEpoch by one, and removes a tampered destination", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-center-relocation-")),
    bundleDir = path.join(root, "bundle"),
    payload = path.join(bundleDir, "payload"),
    destination = path.join(root, "restored"),
    stateRoot = path.join(root, "fleet"),
    body = Buffer.from("portable relocation payload\n"),
    digest = `sha256:${createHash("sha256").update(body).digest("hex")}`,
    tipHash = canonicalLedgerCut("center-test", null).headDigest,
    ledgerPath = path.join(payload, "ledger.sqlite");
  try {
    mkdirSync(payload, { recursive: true });
    writeFileSync(path.join(payload, "ledger.sqlite-placeholder"), body);
    const database = new DatabaseSync(ledgerPath);
    try {
      database.exec(
        "CREATE TABLE ledger_meta (singleton INTEGER PRIMARY KEY, repo_id TEXT NOT NULL, revision INTEGER NOT NULL); " +
          "CREATE TABLE event (revision INTEGER NOT NULL, op_id TEXT NOT NULL, digest TEXT NOT NULL); " +
          "INSERT INTO ledger_meta VALUES (1, 'center-test', 0);",
      );
    } finally {
      database.close();
    }
    const ledgerDigest = `sha256:${createHash("sha256").update(readFileSync(ledgerPath)).digest("hex")}`;
    writeFileSync(
      path.join(bundleDir, "manifest.json"),
      `${JSON.stringify({
        schema: "relocation-bundle/v1",
        repoId: "center-test",
        finalRevision: 0,
        tipHash,
        writerEpoch: 7,
        createdAt: "2026-11-19T00:00:00.000Z",
        files: [
          { path: "ledger.sqlite", size: readFileSync(ledgerPath).byteLength, sha256: ledgerDigest },
          { path: "ledger.sqlite-placeholder", size: body.byteLength, sha256: digest },
        ],
      })}\n`,
    );
    const imported = await importCenterRelocation({
      bundleDir,
      destinationRoot: destination,
      stateRoot,
      expectedRepoId: "center-test",
      expectedFinalRevision: 0,
      expectedTipHash: tipHash,
      writerHolderId: "new-center",
    });
    assert.equal(imported.newEpoch, 8);
    assert.deepEqual(readFileSync(path.join(destination, "ledger.sqlite-placeholder")), body);
    const next = openPersistentWriterEpoch({ stateRoot, holderId: "next-center" });
    try {
      assert.equal(next.acquire("center-test").epoch, 9);
    } finally {
      next.close();
    }
    removeTempRepository(destination);
    writeFileSync(path.join(payload, "ledger.sqlite-placeholder"), "tampered\n");
    await assert.rejects(
      importCenterRelocation({ bundleDir, destinationRoot: destination, stateRoot }),
      /digest differs/u,
    );
    assert.equal(existsSync(destination), false);
    assert.equal(readCenterRelocated(root), null);
  } finally {
    removeTempRepository(root);
  }
});

test("end-to-end export and import preserve real events, SHA-256 object blobs, replication_state, replication-slots.sqlite, RBAC bundle, and roll back cleanly on failure", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-center-reloc-e2e-")),
    repoId = "reloc-e2e",
    sourceRoot = path.join(root, "source"),
    bundleDir = path.join(root, "bundle"),
    oldUserRoot = path.join(root, "old-user"),
    oldStateRoot = path.join(oldUserRoot, "fleet"),
    failedRoot = path.join(root, "failed-restored"),
    failedStateRoot = path.join(root, "failed-fleet"),
    restoredRoot = path.join(root, "restored"),
    newStateRoot = path.join(root, "new-fleet");
  try {
    mkdirSync(sourceRoot, { recursive: true });
    initRepo(sourceRoot);
    const writer = makeTaskEventStore({
      repoId,
      rootDir: sourceRoot,
      writerFence: () => ({ repoId, holderId: "old-center", epoch: 4 }),
    });
    writer.append(bundle(eventAt(1)));
    const blobContent = "relocation content-addressed blob\0✓\n",
      secondAppend = writer.append(docBundle(writer, blobContent, 2, "OP-RELOC-DOC", "docs/reloc.md")),
      expectedHeadCut = secondAppend.cut.headDigest;
    await writer.drain();

    const sourceReader = openSqliteEventStore({ rootInput: sourceRoot, repoId, readOnly: true });
    let replicationPosition: ReturnType<typeof sourceReader.replicationPosition>;
    try {
      assert.equal(sourceReader.revision(), 2);
      replicationPosition = sourceReader.replicationPosition();
    } finally {
      sourceReader.close();
    }
    assert.ok(replicationPosition.sequence > 0);

    const sourceSlotsPath = path.join(oldStateRoot, "replication-slots.sqlite"),
      slots = openReplicationSlots(sourceSlotsPath);
    try {
      const lease = slots.claim({ repoId, nodeId: "edge-one" }, replicationPosition.history);
      slots.acknowledge(lease, { durable: replicationPosition, applied: replicationPosition }, replicationPosition);
    } finally {
      slots.close();
    }

    const stage = stageCenterRelocation({ rootInput: sourceRoot, bundleDir });
    assert.equal(readCenterMigrating(oldUserRoot, repoId), null);

    let observedMigratingInFreeze = false;
    const exported = await exportCenterRelocation({
      rootInput: sourceRoot,
      bundleDir,
      repoId,
      writerEpoch: 4,
      userRoot: oldUserRoot,
      stateRoot: oldStateRoot,
      stage,
      freezeAndDrain: async () => {
        const migrating = readCenterMigrating(oldUserRoot, repoId);
        assert.notEqual(migrating, null);
        assert.equal(migrating?.writerEpoch, 4);
        assert.throws(() => throwIfCenterMigrating(oldUserRoot, repoId), { code: "CENTER_MIGRATING" });
        observedMigratingInFreeze = true;
      },
      exportRbacBundle: async ({ payloadRbacDir }) => {
        mkdirSync(payloadRbacDir, { recursive: true });
        writeFileSync(
          path.join(payloadRbacDir, "realm-export.json"),
          `${JSON.stringify({ schema: "realm-relocation-test/v1", repoId, groups: ["admin", "developer"] })}\n`,
        );
      },
    });
    assert.equal(observedMigratingInFreeze, true);
    assert.equal(readCenterMigrating(oldUserRoot, repoId), null);
    assert.equal(exported.manifest.finalRevision, 2);
    assert.equal(exported.manifest.tipHash, expectedHeadCut);
    assert.equal(exported.manifest.writerEpoch, 4);
    assert.equal(
      exported.manifest.files.some((entry) => entry.path === "replication-slots.sqlite"),
      true,
    );
    assert.equal(
      exported.manifest.files.some((entry) => entry.path === "rbac/realm-export.json"),
      true,
    );
    assert.equal(
      exported.manifest.files.some((entry) => entry.path.includes("/objects/sha256/")),
      true,
    );

    // N1 + Evidence (b): a failure after copying replication-slots.sqlite removes both restoredRoot and copied slots.
    await assert.rejects(
      importCenterRelocation({
        bundleDir,
        destinationRoot: failedRoot,
        stateRoot: failedStateRoot,
        expectedRepoId: repoId,
        expectedFinalRevision: 2,
        expectedTipHash: expectedHeadCut,
        importRbacBundle: async () => {
          assert.equal(existsSync(path.join(failedStateRoot, "replication-slots.sqlite")), true);
          throw new Error("simulated rbac import failure");
        },
      }),
      /simulated rbac import failure/u,
    );
    assert.equal(existsSync(failedRoot), false);
    assert.equal(existsSync(path.join(failedStateRoot, "replication-slots.sqlite")), false);

    // Lineage mismatch checks reject before mutating destination.
    await assert.rejects(
      importCenterRelocation({
        bundleDir,
        destinationRoot: failedRoot,
        stateRoot: failedStateRoot,
        expectedRepoId: repoId,
        expectedFinalRevision: 99,
      }),
      /finalRevision differs/u,
    );
    await assert.rejects(
      importCenterRelocation({
        bundleDir,
        destinationRoot: failedRoot,
        stateRoot: failedStateRoot,
        expectedRepoId: repoId,
        expectedTipHash: `sha256:${"f".repeat(64)}`,
      }),
      /tipHash differs/u,
    );

    let importedRbac: Record<string, unknown> | null = null;
    const imported = await importCenterRelocation({
      bundleDir,
      destinationRoot: restoredRoot,
      stateRoot: newStateRoot,
      expectedRepoId: repoId,
      expectedFinalRevision: 2,
      expectedTipHash: expectedHeadCut,
      writerHolderId: "new-center",
      importRbacBundle: async ({ payloadRbacDir }) => {
        importedRbac = JSON.parse(readFileSync(path.join(payloadRbacDir, "realm-export.json"), "utf8")) as Record<
          string,
          unknown
        >;
      },
    });
    assert.equal(imported.newEpoch, 5);
    assert.deepEqual(importedRbac, { schema: "realm-relocation-test/v1", repoId, groups: ["admin", "developer"] });

    // N1: sidecar files belong in stateRoot / RBAC importer, never inside restored workspace root.
    assert.equal(existsSync(path.join(restoredRoot, "replication-slots.sqlite")), false);
    assert.equal(existsSync(path.join(restoredRoot, "rbac")), false);
    assert.equal(existsSync(path.join(newStateRoot, "replication-slots.sqlite")), true);

    const restoredSlots = openReplicationSlots(path.join(newStateRoot, "replication-slots.sqlite"));
    try {
      const cursor = restoredSlots.cursor({ repoId, nodeId: "edge-one" });
      assert.deepEqual(cursor, { durable: replicationPosition, applied: replicationPosition });
    } finally {
      restoredSlots.close();
    }

    const restoredReader = openSqliteEventStore({ rootInput: restoredRoot, repoId, readOnly: true });
    try {
      assert.equal(restoredReader.revision(), 2);
      assert.equal(restoredReader.events().length, 2);
      assert.deepEqual(restoredReader.replicationPosition(), replicationPosition);
    } finally {
      restoredReader.close();
    }
    assert.equal(imported.manifest.tipHash, expectedHeadCut);

    for (const objectEntry of exported.manifest.files.filter((entry) => entry.path.includes("/objects/sha256/"))) {
      assert.deepEqual(
        readFileSync(path.join(restoredRoot, objectEntry.path)),
        readFileSync(path.join(sourceRoot, objectEntry.path)),
      );
    }
  } finally {
    closeSqliteEventStoresUnder(root);
    removeTempRepository(root);
  }
});

test("exportCenterRelocation selects active generation 3 over retained historical generation 2", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-center-reloc-multigen-")),
    repoId = "reloc-multigen",
    sourceRoot = path.join(root, "source"),
    bundleDir = path.join(root, "bundle");
  try {
    mkdirSync(sourceRoot, { recursive: true });
    initRepo(sourceRoot);
    const writer = makeTaskEventStore({
      repoId,
      rootDir: sourceRoot,
      writerFence: () => ({ repoId, holderId: "multigen-center", epoch: 6 }),
    });
    writer.append(bundle(eventAt(1)));
    const gen3TipHash = writer.append(docBundle(writer, "active generation 3 payload\n", 2, "OP-GEN3", "docs/gen3.md"))
      .cut.headDigest;
    await writer.drain();

    // Place a retained historical generation 2 SQLite ledger at revision 0 alongside active generation 3.
    const gen2 = openSqliteEventStore({
      repoId,
      databasePath: sqliteLedgerPath(sourceRoot, 2),
      generation: 2,
      create: true,
    });
    gen2.close();

    const gen3Reader = openSqliteEventStore({ rootInput: sourceRoot, repoId, readOnly: true });
    try {
      assert.equal(gen3Reader.revision(), 2);
    } finally {
      gen3Reader.close();
    }
    const gen2EmptyTipHash = canonicalLedgerCut(repoId, null).headDigest;
    assert.notEqual(gen3TipHash, gen2EmptyTipHash);

    const exported = await exportCenterRelocation({
      rootInput: sourceRoot,
      bundleDir,
      repoId,
      writerEpoch: 6,
    });
    assert.equal(exported.manifest.finalRevision, 2);
    assert.equal(exported.manifest.tipHash, gen3TipHash);
  } finally {
    closeSqliteEventStoresUnder(root);
    removeTempRepository(root);
  }
});

test("retire fences per-repo tombstones without breaking sibling repos, enforces retired.json seals, and guards pglite/postgres writer epochs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-center-retire-")),
    stateRoot = path.join(root, "fleet");
  try {
    const tombstone = retireCenter({
      userRoot: root,
      repoId: "center-test",
      oldEpoch: 4,
      finalRevision: 20,
      tipHash: "sha256:tip",
      newExternalUrl: "https://new.example.invalid",
      newLoginUrl: "https://login.example.invalid",
      spkiSha256: "sha256:spki",
    });
    assert.equal(readCenterRelocated(root)?.newEpoch, 5);
    assert.equal(readCenterRelocated(root, "center-test")?.newEpoch, 5);
    assert.equal(readCenterRelocated(root, "sibling-repo"), null);
    assert.equal(tombstone.newEpoch, 5);
    assert.equal(
      JSON.parse(readFileSync(path.join(stateRoot, "writer-epochs", "center-test.retired.json"), "utf8")).retiredEpoch,
      4,
    );

    const authority = openPersistentWriterEpoch({ stateRoot, holderId: "old-center" });
    try {
      assert.throws(() => authority.acquire("center-test"), { code: "CENTER_MOVED" });
      assert.equal(authority.acquire("sibling-repo").epoch, 1);
    } finally {
      authority.close();
    }

    // Standalone writer-epoch retirement seal enforces CENTER_MOVED even without center-relocated JSON.
    writeWriterEpochRetirementSeal(root, {
      schema: "writer-epoch-retirement-seal/v1",
      repoId: "sealed-only",
      retiredEpoch: 9,
      newEpoch: 10,
      retiredAt: "2026-11-20T00:00:00.000Z",
    });
    const sealAuthority = openPersistentWriterEpoch({ stateRoot, holderId: "old-center" });
    try {
      assert.throws(() => sealAuthority.acquire("sealed-only"), { code: "CENTER_MOVED" });
    } finally {
      sealAuthority.close();
    }

    // External SQL backends (pglite/postgres) are guarded before delegating acquire/withAppendFence.
    let externalAcquireCalls = 0;
    const pgliteStorage = { backend: "pglite" as const, dataDir: path.join(root, "pglite-data") };
    configureWriterEpochStorage({ stateRoot, repoId: "center-test" }, pgliteStorage);
    configureWriterEpochStorage({ stateRoot, repoId: "pglite-live" }, pgliteStorage);
    registerSqlBackendAdapters(
      {
        openPgWriterEpoch: () => ({
          acquire: (targetRepoId) => {
            externalAcquireCalls += 1;
            return { repoId: targetRepoId, holderId: "pg-holder", epoch: 11 };
          },
          current: () => undefined,
          assertCurrent: () => undefined,
          withAppendFence: (_repoId, _epoch, _holderId, operation) => operation(),
          verifyFollowerFence: () => undefined,
          close: () => undefined,
        }),
      },
      "pglite",
    );
    const externalAuthority = openPersistentWriterEpoch({
      stateRoot,
      holderId: "pg-holder",
      storage: pgliteStorage,
    });
    try {
      assert.throws(() => externalAuthority.acquire("center-test"), { code: "CENTER_MOVED" });
      assert.equal(externalAcquireCalls, 0);
      assert.throws(() => externalAuthority.withAppendFence("center-test", 4, "pg-holder", () => "unreachable"), {
        code: "CENTER_MOVED",
      });
      assert.equal(externalAuthority.acquire("pglite-live").epoch, 11);
      assert.equal(externalAcquireCalls, 1);
    } finally {
      externalAuthority.close();
    }
  } finally {
    removeTempRepository(root);
  }
});

test("relocation manifest rejects absolute paths before touching a destination", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-center-manifest-"));
  try {
    mkdirSync(path.join(root, "payload"), { recursive: true });
    writeFileSync(
      path.join(root, "manifest.json"),
      JSON.stringify({
        schema: "relocation-bundle/v1",
        repoId: "center-test",
        finalRevision: 0,
        tipHash: "sha256:tip",
        writerEpoch: 1,
        createdAt: "2026-11-19T00:00:00.000Z",
        files: [{ path: path.resolve("escape"), size: 0, sha256: "sha256:" + "0".repeat(64) }],
      }),
    );
    assert.throws(() => verifyRelocationBundle(root), /invalid file entry/u);
  } finally {
    removeTempRepository(root);
  }
});
