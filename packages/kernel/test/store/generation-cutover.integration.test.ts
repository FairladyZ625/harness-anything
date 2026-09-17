// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { runGenerationConversion } from "../../src/store/generation-two-conversion.ts";
import { createLedgerBackup } from "../../src/store/ledger-backup.ts";
import {
  generationActivationPath,
  openSqliteEventStore,
  resolveActiveGeneration,
  sqliteLedgerPath,
} from "../../src/store/sqlite-event-store.ts";
import { makeSqliteTaskEventStore } from "../../src/store/sqlite-task-event-store.ts";
import { readCertifiedGitFollower } from "../../src/store/sqlite-task-event-publication.ts";
import { stableStringify } from "../../src/integrity/stable-hash.ts";
import { eventAt, git, initRepo } from "./task-event-store.fixtures.ts";

const repoId = "offline-cutover";
const fence = { repoId, holder: "drained-writer", epoch: 7 };

function fixture() {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-generation-cutover-")),
    root = path.join(parent, "source"),
    backupDir = path.join(parent, "backup");
  mkdirSync(root);
  initRepo(root);
  const source = openSqliteEventStore({ repoId, rootInput: root, generation: 2 });
  source.claimWriter(fence);
  source.appendCommand({
    fence,
    intent: { opId: "op-1", intentDigest: "source-intent", summary: "source task" },
    events: [eventAt(1)],
  });
  const originalDigest =
    "sha256:" +
    createHash("sha256")
      .update(
        stableStringify({
          metadata: source.metadata(),
          rows: source.eventRows(),
          outcomes: source.outcomes(),
          objects: source.contentObjectDigests(),
        }),
      )
      .digest("hex");
  source.close();
  writeFileSync(
    generationActivationPath(root, 2),
    JSON.stringify({
      schema: "generation-activation/v2",
      repoId,
      sourceDigest: "sha256:source",
      importedPrefixRevision: 1,
      generation: 2,
    }),
  );
  createLedgerBackup({ rootInput: root, backupDir, generation: 2 });
  return { parent, root, backupDir, originalDigest };
}

test("in-place conversion leaves followers unchanged until activation and ordinary publication", async () => {
  const { parent, root, backupDir, originalDigest } = fixture();
  try {
    const before = git(root, "rev-parse", "HEAD"),
      result = runGenerationConversion({ backupDir, destinationRoot: root, mode: "convert" });
    assert.equal(result.plan.ready, true);
    assert.equal(result.plan.sourceDigest, originalDigest, "incremental hashing preserves the original JSON identity");
    assert.equal(result.verification?.matches, true);
    assert.equal(result.verification?.projection.watermark, 1);
    assert.equal(git(root, "rev-parse", "HEAD"), before);
    assert.equal(existsSync(generationActivationPath(root, 3)), false);
    assert.throws(() => resolveActiveGeneration({ rootInput: root, repoId }), /requires migration/u);
    assert.throws(
      () => runGenerationConversion({ backupDir, destinationRoot: root, mode: "convert" }),
      /candidate already exists/u,
    );
    const cache = path.join(root, ".harness/cache/task.sqlite"),
      replica = path.join(root, ".harness/replica/repos", repoId);
    mkdirSync(path.dirname(cache), { recursive: true });
    mkdirSync(replica, { recursive: true });
    writeFileSync(cache, "old cache");
    writeFileSync(path.join(replica, "cuts.sqlite"), "old replica");
    assert.equal(runGenerationConversion({ backupDir, destinationRoot: root, mode: "activate" }).active, true);
    assert.equal(existsSync(sqliteLedgerPath(root, 2)), false);
    assert.equal(existsSync(generationActivationPath(root, 2)), true);
    assert.equal(existsSync(cache), false);
    assert.equal(existsSync(replica), false);
    assert.equal(resolveActiveGeneration({ rootInput: root, repoId }), 3);
    assert.equal(git(root, "rev-parse", "HEAD"), before, "activation only commits the canonical generation");
    assert.equal(runGenerationConversion({ backupDir, destinationRoot: root, mode: "activate" }).active, true);
    const store = makeSqliteTaskEventStore({ rootDir: root, repoId });
    await store.drain();
    assert.equal(store.followerStatus().git.status, "verified");
    const target = openSqliteEventStore({ rootInput: root, generation: 3, readOnly: true });
    try {
      assert.equal(readCertifiedGitFollower({ rootInput: root, repoId, store: target }).cut.revision, 1);
    } finally {
      target.close();
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

for (const changed of ["head", "writer"] as const) {
  test("source " + changed + " drift refuses retirement and leaves the source selectable", () => {
    const { parent, root, backupDir } = fixture();
    try {
      const plan = runGenerationConversion({ backupDir, mode: "dry-run" }).plan,
        source = openSqliteEventStore({ repoId, rootInput: root, generation: 2 });
      if (changed === "writer") source.claimWriter({ ...fence, epoch: 8 });
      else
        source.appendCommand({
          fence,
          intent: { opId: "op-2", intentDigest: "second-intent", summary: "source changed" },
          events: [eventAt(2)],
        });
      const currentHead = source.eventIdentityAtRevision(source.revision()),
        currentWriter = source.writerFence(),
        retired = sqliteLedgerPath(root, 2) + ".retired-test";
      try {
        assert.throws(
          () =>
            source.retireForConversion({
              head: plan.sourceHead,
              writer: plan.sourceWriter,
              destinationPath: retired,
            }),
          /source head or writer fence changed/u,
        );
        assert.deepEqual(source.eventIdentityAtRevision(source.revision()), currentHead);
        assert.deepEqual(source.writerFence(), currentWriter);
      } finally {
        source.close();
      }
      assert.throws(
        () => runGenerationConversion({ backupDir, destinationRoot: root, mode: "convert" }),
        /source head or writer fence changed/u,
      );
      assert.equal(existsSync(retired), false);
      assert.equal(existsSync(sqliteLedgerPath(root, 3)), false);
      assert.throws(() => resolveActiveGeneration({ rootInput: root, repoId }), /requires migration/u);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
}

test("activation resumes after source retirement but before certificate publication", () => {
  const { parent, root, backupDir } = fixture();
  try {
    const { plan } = runGenerationConversion({ backupDir, destinationRoot: root, mode: "convert" }),
      source = openSqliteEventStore({ repoId, rootInput: root, generation: 2 });
    source.retireForConversion({
      head: plan.sourceHead,
      writer: plan.sourceWriter,
      destinationPath: sqliteLedgerPath(root, 2) + ".retired-generation-3",
    });
    source.close();
    assert.throws(() => resolveActiveGeneration({ rootInput: root, repoId }), /missing ledger/u);
    assert.equal(existsSync(generationActivationPath(root, 3)), false);
    assert.equal(runGenerationConversion({ backupDir, destinationRoot: root, mode: "activate" }).active, true);
    assert.equal(resolveActiveGeneration({ rootInput: root, repoId }), 3);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an undrained source connection prevents exclusive retirement", () => {
  const { parent, root, backupDir } = fixture();
  try {
    const { plan } = runGenerationConversion({ backupDir, mode: "dry-run" }),
      source = openSqliteEventStore({ repoId, rootInput: root, generation: 2 }),
      reader = new DatabaseSync(sqliteLedgerPath(root, 2), { readOnly: true }),
      retired = sqliteLedgerPath(root, 2) + ".retired-generation-3";
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT revision FROM ledger_meta").get();
      assert.throws(
        () =>
          source.retireForConversion({
            head: plan.sourceHead,
            writer: plan.sourceWriter,
            destinationPath: retired,
          }),
        /locked|busy/u,
      );
      assert.equal(existsSync(retired), false);
      assert.equal(existsSync(sqliteLedgerPath(root, 2)), true);
    } finally {
      reader.close();
      source.close();
    }
    assert.throws(() => resolveActiveGeneration({ rootInput: root, repoId }), /requires migration/u);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
