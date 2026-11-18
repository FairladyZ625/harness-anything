// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { threadId, Worker } from "node:worker_threads";
import * as tar from "tar";
import {
  activateEmptyCanonicalGeneration,
  BASE_BACKUP_ARCHIVE_ROOT,
  makeTaskProjection,
  openSqliteEventStore,
  startBaseBackup,
} from "@harness-anything/storage";
import { initRepo } from "../../storage/test/store/task-event-store.fixtures.ts";
import {
  installReplicaGeneration,
  readReplicaGeneration,
  replicaGenerationReaders,
  type ReplicaStagingCheckpoint,
} from "../src/fleet-sync/fleet/replica-generation.ts";

async function buildSampleBackup(root: string) {
  initRepo(root);
  activateEmptyCanonicalGeneration({ repoId: "worker-install-repo", rootInput: root });
  const ledger = openSqliteEventStore({ repoId: "worker-install-repo", rootInput: root });
  const projection = makeTaskProjection({
    rootDir: root,
    eventStore: {
      readHead: () => null,
      readBatch: () => ({ sourceRevision: 0, events: [], cursor: null, done: true, accessedItems: 0 }),
      readContentBlob: () => null,
    },
  });
  try {
    projection.catchUp();
    ledger.claimWriter({ repoId: "worker-install-repo", holder: "primary", epoch: 1 });
    const transfer = await startBaseBackup({
      ledgerPath: ledger.databasePath,
      projectionPath: projection.path,
      directory: path.join(root, "transfer"),
    });
    return await transfer.complete;
  } finally {
    projection.close();
    ledger.close();
  }
}

test("installReplicaGeneration executes off the main thread without stalling the event loop", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-worker-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const archive = await buildSampleBackup(root);
  const replicaRoot = path.join(root, "replica");

  // Observe each progress callback while Node delivers its real Worker message.
  const phases: string[] = [];
  const progressThreads: Array<number | undefined> = [];
  const emit = Worker.prototype.emit;
  let deliveringThread: number | undefined;
  t.mock.method(Worker.prototype, "emit", function (this: Worker, event: string | symbol, ...args: unknown[]) {
    if (event !== "message" || (args[0] as { kind?: string } | undefined)?.kind !== "progress")
      return emit.call(this, event, ...args);
    deliveringThread = this.threadId;
    try {
      return emit.call(this, event, ...args);
    } finally {
      deliveringThread = undefined;
    }
  });

  const installed = await installReplicaGeneration({
    root: replicaRoot,
    archive: archive.file,
    metadata: archive.metadata,
    sha256: archive.sha256,
    size: archive.size,
    quotaBytes: 32 * 1024 * 1024,
    onProgress: ({ phase }) => {
      phases.push(phase);
      progressThreads.push(deliveringThread);
    },
  });
  assert.deepEqual(phases, ["unpacking", "hydrating", "flushing", "ready"]);
  for (const [index, installThread] of progressThreads.entries()) {
    assert.ok(
      installThread !== undefined && installThread > 0 && installThread !== threadId,
      `expected ${phases[index]} progress from a worker thread, got ${installThread}`,
    );
  }
  assert.deepEqual(readReplicaGeneration(replicaRoot), installed);
  assert.equal(existsSync(path.join(installed.rootDir, "extract.checkpoint.json")), false);
});

test("resumable staging preserves valid <sha256>.staging across discardStaging and skips existing immutable objects", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-resume-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const baseArchive = await buildSampleBackup(root);

  // Unpack the base archive into a payload directory and add an immutable object under objects/sha256/
  // so we can deterministically verify that resume skips rewriting matching-size immutable objects.
  const payloadDir = path.join(root, "payload-with-obj");
  mkdirSync(payloadDir, { recursive: true });
  await tar.extract({ file: baseArchive.file, cwd: payloadDir });

  const objRelPath = path.join(
    BASE_BACKUP_ARCHIVE_ROOT,
    "store",
    "generations",
    String(baseArchive.metadata.ledgerGeneration),
    "objects",
    "sha256",
    "aa",
    "b".repeat(62),
  );
  const objPayload = Buffer.from("immutable-cas-object-content-for-resume-check\n", "utf8");
  mkdirSync(path.dirname(path.join(payloadDir, objRelPath)), { recursive: true });
  writeFileSync(path.join(payloadDir, objRelPath), objPayload);

  const archiveWithObj = path.join(root, "archive-with-obj.tar.gz");
  await tar.create({ file: archiveWithObj, cwd: payloadDir, gzip: true, portable: true, strict: true }, [
    "backup.json",
    BASE_BACKUP_ARCHIVE_ROOT,
  ]);
  const archiveBytes = readFileSync(archiveWithObj);
  const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  const archiveSize = archiveBytes.length;

  const replicaRoot = path.join(root, "replica");
  const generationsDir = path.join(replicaRoot, "generations");
  const stagingDir = path.join(generationsDir, `${archiveSha256}.staging`);

  // Prepare resumable staging directory with a valid checkpoint and the pre-existing immutable object.
  mkdirSync(stagingDir, { recursive: true });
  const checkpoint: ReplicaStagingCheckpoint = {
    schema: "fleet-replica-staging/v1",
    sha256: archiveSha256,
    size: archiveSize,
    repoId: baseArchive.metadata.repoId,
    ledgerGeneration: baseArchive.metadata.ledgerGeneration,
    phase: "unpacking",
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(stagingDir, "extract.checkpoint.json"), JSON.stringify(checkpoint));

  const preExistingObjectDest = path.join(stagingDir, objRelPath);
  mkdirSync(path.dirname(preExistingObjectDest), { recursive: true });
  copyFileSync(path.join(payloadDir, objRelPath), preExistingObjectDest);
  const sentinelMtimeSec = 1_500_000_000;
  utimesSync(preExistingObjectDest, sentinelMtimeSec, sentinelMtimeSec);

  // Also create an unrecognized legacy staging dir and a corrupt sha256 staging dir.
  const legacyStaging = path.join(generationsDir, "legacy-uuid.staging");
  const corruptStaging = path.join(generationsDir, `${"b".repeat(64)}.staging`);
  mkdirSync(legacyStaging, { recursive: true });
  mkdirSync(corruptStaging, { recursive: true });
  writeFileSync(path.join(corruptStaging, "extract.checkpoint.json"), "{not-json");

  const readers = replicaGenerationReaders(replicaRoot);
  await readers.discardStaging();

  // Valid <sha256>.staging must survive discardStaging(), while legacy and corrupt ones are removed.
  assert.equal(existsSync(stagingDir), true);
  assert.equal(existsSync(legacyStaging), false);
  assert.equal(existsSync(corruptStaging), false);

  let maxSkipped = 0;
  const installed = await installReplicaGeneration({
    root: replicaRoot,
    archive: archiveWithObj,
    metadata: baseArchive.metadata,
    sha256: archiveSha256,
    size: archiveSize,
    quotaBytes: 32 * 1024 * 1024,
    onProgress: (progress) => {
      if (progress.skippedObjects > maxSkipped) maxSkipped = progress.skippedObjects;
    },
  });

  assert.deepEqual(readReplicaGeneration(replicaRoot), installed);
  assert.equal(existsSync(stagingDir), false);
  assert.ok(maxSkipped >= 1, `expected at least 1 skipped immutable object, got ${maxSkipped}`);

  const finalObjStat = statSync(path.join(installed.rootDir, objRelPath));
  assert.equal(
    Math.floor(finalObjStat.mtimeMs / 1000),
    sentinelMtimeSec,
    "pre-existing immutable object should not have been rewritten",
  );

  // Explicit preserveResumable: false (e.g. replica.resync) must clean up even a valid staging dir.
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(path.join(stagingDir, "extract.checkpoint.json"), JSON.stringify(checkpoint));
  await readers.discardStaging({ preserveResumable: false });
  assert.equal(existsSync(stagingDir), false);
});
