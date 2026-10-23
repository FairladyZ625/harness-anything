// harness-test-tier: integration
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { taskProjectionSchemaVersion } from "../../src/projection/projection-schema.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import {
  activateEmptyCanonicalGeneration,
  openSqliteEventStore,
  sqliteLedgerPath,
} from "../../src/store/sqlite-event-store.ts";
import { serializePersistedCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";
import { eventAt, initRepo } from "./task-event-store.fixtures.ts";

const repoId = "generation-three-open-guard",
  fence = { repoId, holder: "writer", epoch: 1 };

test("canonical attach rejects a zero-byte main file before SQLite discards its recoverable WAL", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-empty-canonical-ledger-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  initRepo(rootDir);
  activateEmptyCanonicalGeneration({ repoId, rootInput: rootDir });
  const databasePath = sqliteLedgerPath(rootDir, 3),
    walPath = `${databasePath}-wal`,
    store = openSqliteEventStore({ repoId, rootInput: rootDir, generation: 3 }),
    reader = new DatabaseSync(databasePath, { readOnly: true });
  let writerOpen = true,
    readerOpen = true;
  try {
    reader.exec("BEGIN");
    reader.prepare("SELECT revision FROM ledger_meta").get();
    const event = eventAt(1),
      eventJson = serializePersistedCanonicalEvent(event);
    store.appendCommand({
      fence,
      intent: {
        opId: event.opId,
        intentDigest: `sha256:${sha256Text(eventJson)}`,
        summary: event.type,
      },
      events: [event],
    });
    const walBytes = statSync(walPath).size;
    assert.ok(walBytes > 0, "the accepted write must still have WAL pages before the incident shape is applied");
    const savedDatabasePath = path.join(rootDir, "saved-ledger.sqlite"),
      savedWalPath = `${savedDatabasePath}-wal`;
    copyFileSync(databasePath, savedDatabasePath);
    copyFileSync(walPath, savedWalPath);
    reader.close();
    readerOpen = false;
    store.close();
    writerOpen = false;
    copyFileSync(savedDatabasePath, databasePath);
    copyFileSync(savedWalPath, walPath);
    if (existsSync(`${databasePath}-shm`)) unlinkSync(`${databasePath}-shm`);
    writeFileSync(databasePath, Buffer.alloc(0));

    assert.throws(
      () => openSqliteEventStore({ repoId, rootInput: rootDir, readOnly: true }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_store",
    );
    assert.equal(statSync(walPath).size, walBytes, "read-only startup probes must preserve the only recoverable WAL");
    assert.throws(
      () => openSqliteEventStore({ repoId, rootInput: rootDir }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_store",
    );
    assert.equal(statSync(databasePath).size, 0);
    assert.equal(statSync(walPath).size, walBytes, "refusing the attach must preserve the only recoverable WAL");
  } finally {
    if (writerOpen) store.close();
    if (readerOpen) reader.close();
  }
});

test("canonical attach rejects a 4096-byte database without ledger metadata", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-schema-less-canonical-ledger-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  initRepo(rootDir);
  activateEmptyCanonicalGeneration({ repoId, rootInput: rootDir });
  const databasePath = sqliteLedgerPath(rootDir, 3),
    emptyPath = path.join(rootDir, "schema-less.sqlite"),
    emptyDatabase = new DatabaseSync(emptyPath);
  emptyDatabase.exec("CREATE TABLE temporary_table(value TEXT); DROP TABLE temporary_table; VACUUM");
  emptyDatabase.close();
  assert.equal(statSync(emptyPath).size, 4096);
  copyFileSync(emptyPath, databasePath);

  assert.throws(
    () => openSqliteEventStore({ repoId, rootInput: rootDir }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_store",
  );
  assert.equal(statSync(databasePath).size, 4096);
});

test("canonical writable attach rejects revision zero when the persisted projection proves accepted history", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-stale-canonical-main-file-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  initRepo(rootDir);
  activateEmptyCanonicalGeneration({ repoId, rootInput: rootDir });
  const databasePath = sqliteLedgerPath(rootDir, 3),
    revisionZeroPath = path.join(rootDir, "revision-zero-ledger.sqlite");
  copyFileSync(databasePath, revisionZeroPath);

  const store = openSqliteEventStore({ repoId, rootInput: rootDir, generation: 3 });
  try {
    const event = eventAt(1),
      eventJson = serializePersistedCanonicalEvent(event);
    store.appendCommand({
      fence,
      intent: {
        opId: event.opId,
        intentDigest: `sha256:${sha256Text(eventJson)}`,
        summary: event.type,
      },
      events: [event],
    });
  } finally {
    store.close();
  }

  const projectionStore = makeTaskEventStore({ repoId, rootDir, mutable: false }),
    projection = makeTaskProjection({ rootDir, eventStore: projectionStore });
  try {
    projection.catchUp?.();
  } finally {
    projection.close();
    await projectionStore.drain();
  }
  const projectionMeta = new DatabaseSync(path.join(rootDir, ".harness", "cache", "task.sqlite"), {
    readOnly: true,
  });
  assert.equal(
    Number(
      projectionMeta.prepare("SELECT scanned_revision FROM projection_meta WHERE singleton=1").get()!.scanned_revision,
    ),
    1,
  );
  projectionMeta.close();

  for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) if (existsSync(sidecar)) unlinkSync(sidecar);
  copyFileSync(revisionZeroPath, databasePath);
  assert.throws(
    () => openSqliteEventStore({ repoId, rootInput: rootDir, generation: 3 }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "invalid_store" &&
      /projection cache through revision 1 cannot be discarded/u.test(error.message) &&
      /revisions 1-1 are not continuously readable/u.test(error.message),
    "the refusal must name the missing revision range so the operator knows what to restore",
  );
  assert.equal(statSync(databasePath).size, statSync(revisionZeroPath).size);
});

async function scannedProjectionAtHead(rootDir: string): Promise<string> {
  const databasePath = sqliteLedgerPath(rootDir, 3),
    revisionZeroPath = path.join(rootDir, "revision-zero-ledger.sqlite");
  copyFileSync(databasePath, revisionZeroPath);
  const store = openSqliteEventStore({ repoId, rootInput: rootDir, generation: 3 });
  try {
    const event = eventAt(1),
      eventJson = serializePersistedCanonicalEvent(event);
    store.appendCommand({
      fence,
      intent: {
        opId: event.opId,
        intentDigest: `sha256:${sha256Text(eventJson)}`,
        summary: event.type,
      },
      events: [event],
    });
  } finally {
    store.close();
  }
  const projectionStore = makeTaskEventStore({ repoId, rootDir, mutable: false }),
    projection = makeTaskProjection({ rootDir, eventStore: projectionStore });
  try {
    projection.catchUp?.();
  } finally {
    projection.close();
    await projectionStore.drain();
  }
  return revisionZeroPath;
}

function rewriteProjectionSchemaVersion(rootDir: string, schemaVersion: number): void {
  const projectionPath = path.join(rootDir, ".harness", "cache", "task.sqlite"),
    projectionMeta = new DatabaseSync(projectionPath);
  projectionMeta.prepare("UPDATE projection_meta SET schema_version=? WHERE singleton=1").run(schemaVersion);
  projectionMeta.close();
}

function restoreLedger(rootDir: string, savedLedgerPath: string): void {
  const databasePath = sqliteLedgerPath(rootDir, 3);
  for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) if (existsSync(sidecar)) unlinkSync(sidecar);
  copyFileSync(savedLedgerPath, databasePath);
}

test("a projection cache from a future daemon build is refused as a schema mismatch, not a lagging ledger", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-future-projection-canonical-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  initRepo(rootDir);
  activateEmptyCanonicalGeneration({ repoId, rootInput: rootDir });
  const revisionZeroPath = await scannedProjectionAtHead(rootDir);
  rewriteProjectionSchemaVersion(rootDir, taskProjectionSchemaVersion + 1);
  restoreLedger(rootDir, revisionZeroPath);

  assert.throws(
    () => openSqliteEventStore({ repoId, rootInput: rootDir, generation: 3 }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "kernel_schema_mismatch" &&
      /run a daemon build that understands/u.test(error.message),
    "a future-version cache names the daemon build instead of claiming the ledger lost history",
  );
});

test("a projection cache from an older daemon build that proves lost history still blocks the attach", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-past-projection-canonical-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  initRepo(rootDir);
  activateEmptyCanonicalGeneration({ repoId, rootInput: rootDir });
  const revisionZeroPath = await scannedProjectionAtHead(rootDir);
  rewriteProjectionSchemaVersion(rootDir, taskProjectionSchemaVersion - 1);
  restoreLedger(rootDir, revisionZeroPath);

  assert.throws(
    () => openSqliteEventStore({ repoId, rootInput: rootDir, generation: 3 }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "invalid_store" &&
      /revisions 1-1 are not continuously readable/u.test(error.message),
    "a rebuildable older cache must still be refused when the ledger cannot prove its history",
  );
});

test("a projection cache from an older daemon build at the ledger head does not block the attach", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-past-projection-caughtup-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  initRepo(rootDir);
  activateEmptyCanonicalGeneration({ repoId, rootInput: rootDir });
  await scannedProjectionAtHead(rootDir);
  rewriteProjectionSchemaVersion(rootDir, taskProjectionSchemaVersion - 1);

  const store = openSqliteEventStore({ repoId, rootInput: rootDir, generation: 3 });
  try {
    assert.equal(store.revision(), 1);
  } finally {
    store.close();
  }
});

test("a same-revision cache scanned from another history does not block the attach or its rebuild", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-foreign-history-cache-")),
    altDir = mkdtempSync(path.join(tmpdir(), "ha-foreign-history-alt-"));
  t.after(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(altDir, { recursive: true, force: true });
  });
  initRepo(rootDir);
  activateEmptyCanonicalGeneration({ repoId, rootInput: rootDir });
  await scannedProjectionAtHead(rootDir);
  // A restored snapshot can replace the ledger with another history that reached the same
  // revision; the cache keeps pinning the head digest it actually scanned.
  initRepo(altDir);
  activateEmptyCanonicalGeneration({ repoId, rootInput: altDir });
  const altStore = openSqliteEventStore({ repoId, rootInput: altDir, generation: 3 }),
    restored = eventAt(1);
  try {
    const rewritten = {
        ...restored,
        payload: {
          ...restored.payload,
          task: { ...restored.payload.task, title: "Task 00001 restored from a backup" },
        },
      },
      eventJson = serializePersistedCanonicalEvent(rewritten);
    altStore.appendCommand({
      fence,
      intent: { opId: rewritten.opId, intentDigest: `sha256:${sha256Text(eventJson)}`, summary: rewritten.type },
      events: [rewritten],
    });
  } finally {
    altStore.close();
  }
  restoreLedger(rootDir, sqliteLedgerPath(altDir, 3));

  const projectionPath = path.join(rootDir, ".harness", "cache", "task.sqlite"),
    ledger = new DatabaseSync(sqliteLedgerPath(rootDir, 3), { readOnly: true }),
    ledgerDigest = String(ledger.prepare("SELECT digest FROM event WHERE revision=1").get()!.digest);
  ledger.close();
  const pinned = new DatabaseSync(projectionPath, { readOnly: true }),
    scanned = pinned.prepare("SELECT scanned_revision, head_digest FROM projection_meta WHERE singleton=1").get() as {
      readonly scanned_revision: number;
      readonly head_digest: string;
    };
  pinned.close();
  assert.equal(scanned.scanned_revision, 1);
  assert.notEqual(scanned.head_digest, ledgerDigest, "the shape must be same revision with a different head digest");

  const store = openSqliteEventStore({ repoId, rootInput: rootDir, generation: 3 });
  try {
    assert.equal(store.revision(), 1);
  } finally {
    store.close();
  }

  // The repair named by the mismatch error stays reachable: the projection module consumes the
  // mismatch and a rebuild re-pins the cache to the ledger that is actually in place.
  const projectionStore = makeTaskEventStore({ repoId, rootDir, mutable: false }),
    projection = makeTaskProjection({ rootDir, eventStore: projectionStore });
  try {
    assert.equal(projection.rebuild().watermark, 1);
  } finally {
    projection.close();
    await projectionStore.drain();
  }
  const realigned = new DatabaseSync(projectionPath, { readOnly: true }),
    rePinned = realigned.prepare("SELECT head_digest FROM projection_meta WHERE singleton=1").get() as {
      readonly head_digest: string;
    };
  realigned.close();
  assert.equal(rePinned.head_digest, ledgerDigest);
});

test("canonical attach surfaces unreadable projection metadata instead of accepting an unproven head", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-unreadable-canonical-projection-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  initRepo(rootDir);
  activateEmptyCanonicalGeneration({ repoId, rootInput: rootDir });
  const databasePath = sqliteLedgerPath(rootDir, 3),
    projectionPath = path.join(rootDir, ".harness", "cache", "task.sqlite"),
    ledgerSize = statSync(databasePath).size;
  mkdirSync(path.dirname(projectionPath), { recursive: true });
  writeFileSync(projectionPath, "unreadable projection database\n");

  assert.throws(() => openSqliteEventStore({ repoId, rootInput: rootDir, generation: 3 }), Error);
  assert.equal(statSync(databasePath).size, ledgerSize, "the failed preflight must not mutate the canonical ledger");
});

test("canonical read-only ledger probes do not depend on projection readability", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-readonly-canonical-projection-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  initRepo(rootDir);
  activateEmptyCanonicalGeneration({ repoId, rootInput: rootDir });
  const projectionPath = path.join(rootDir, ".harness", "cache", "task.sqlite");
  mkdirSync(path.dirname(projectionPath), { recursive: true });
  writeFileSync(projectionPath, "unreadable projection database\n");

  const store = openSqliteEventStore({ repoId, rootInput: rootDir, generation: 3, readOnly: true });
  try {
    assert.equal(store.revision(), 0);
  } finally {
    store.close();
  }
});

test("canonical attach does not recreate a missing ledger covered by its activation certificate", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-missing-canonical-ledger-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  initRepo(rootDir);
  activateEmptyCanonicalGeneration({ repoId, rootInput: rootDir });
  const databasePath = sqliteLedgerPath(rootDir, 3);
  unlinkSync(databasePath);

  assert.throws(
    () => openSqliteEventStore({ repoId, rootInput: rootDir, generation: 3 }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_store",
  );
  assert.equal(existsSync(databasePath), false);
});

test("empty activation refuses to recreate a missing ledger while its projection remains", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lost-canonical-ledger-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  initRepo(rootDir);
  activateEmptyCanonicalGeneration({ repoId, rootInput: rootDir });
  const databasePath = sqliteLedgerPath(rootDir, 3),
    activationPath = `${databasePath}.activation.json`,
    projectionPath = path.join(rootDir, ".harness", "cache", "task.sqlite");
  unlinkSync(databasePath);
  unlinkSync(activationPath);
  mkdirSync(path.dirname(projectionPath), { recursive: true });
  writeFileSync(projectionPath, "prior canonical projection\n");

  assert.throws(
    () => activateEmptyCanonicalGeneration({ repoId, rootInput: rootDir }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_store",
  );
  assert.equal(existsSync(databasePath), false);
});

for (const [shape, contents] of [
  ["zero-byte", null],
  ["schema-less 4096-byte", "CREATE TABLE temporary_table(value TEXT); DROP TABLE temporary_table; VACUUM"],
] as const) {
  test(`a brand-new repository initialises through a leftover ${shape} projection cache`, (t) => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-empty-cache-bootstrap-"));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    initRepo(rootDir);
    const projectionPath = path.join(rootDir, ".harness", "cache", "task.sqlite");
    mkdirSync(path.dirname(projectionPath), { recursive: true });
    if (contents === null) {
      writeFileSync(projectionPath, Buffer.alloc(0));
    } else {
      const cache = new DatabaseSync(projectionPath);
      cache.exec(contents);
      cache.close();
    }

    activateEmptyCanonicalGeneration({ repoId, rootInput: rootDir });

    assert.equal(existsSync(`${sqliteLedgerPath(rootDir, 3)}.activation.json`), true);
    const store = openSqliteEventStore({ repoId, rootInput: rootDir, generation: 3 });
    try {
      assert.equal(store.revision(), 0);
    } finally {
      store.close();
    }
  });
}

test("a projection cache that already scanned accepted history still blocks empty initialisation", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-scanned-cache-bootstrap-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  initRepo(rootDir);
  const projectionPath = path.join(rootDir, ".harness", "cache", "task.sqlite");
  mkdirSync(path.dirname(projectionPath), { recursive: true });
  const cache = new DatabaseSync(projectionPath);
  cache.exec(
    "CREATE TABLE projection_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), " +
      "watermark INTEGER NOT NULL); INSERT INTO projection_meta VALUES (1, 7)",
  );
  cache.close();

  assert.throws(
    () => activateEmptyCanonicalGeneration({ repoId, rootInput: rootDir }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "invalid_store" &&
      /upgrade is incomplete/u.test(error.message),
  );
  assert.equal(existsSync(sqliteLedgerPath(rootDir, 3)), false);
});
