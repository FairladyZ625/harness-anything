// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLedgerBackup } from "../../src/store/ledger-backup.ts";
import { runGenerationTwoConversion } from "../../src/store/generation-two-conversion.ts";
import { openSqliteEventStore, sqliteLedgerPath } from "../../src/store/sqlite-event-store.ts";
import { readCertifiedGitFollower } from "../../src/store/task-event-store-factory.ts";
import { makeSqliteTaskEventStore } from "../../src/store/sqlite-task-event-store.ts";
import { event, initRepo } from "./task-event-store.fixtures.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { canonicalLedgerCut } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";

test("generation 1 Git follower converts and certifies generation 2 from a backup", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gen1-to-gen2-source-")),
    backupDir = path.join(tmpdir(), `ha-gen1-to-gen2-backup-${process.pid}-${Date.now()}`),
    destinationRoot = path.join(tmpdir(), `ha-gen1-to-gen2-destination-${process.pid}-${Date.now()}`),
    destination = destinationRoot,
    repoId = "generation-one-conversion",
    fence = { repoId, holder: "generation-one-fixture", epoch: 1 } as const;
  t.after(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
    rmSync(destinationRoot, { recursive: true, force: true });
  });
  initRepo(rootDir);
  const source = openSqliteEventStore({ repoId, rootInput: rootDir, generation: 1 });
  source.claimWriter(fence);
  source.appendCommand({
    fence,
    intent: { opId: event.opId, intentDigest: `sha256:${sha256Text(JSON.stringify(event))}`, summary: event.type },
    events: [event],
  });
  source.close();

  const follower = makeSqliteTaskEventStore({ repoId, rootDir, generation: 1 });
  try {
    await follower.settlePendingMaterialization?.("publish generation 1 before backup");
    assert.equal(follower.followerStatus().git.status, "verified");
  } finally {
    await follower.drain();
  }
  createLedgerBackup({ rootInput: rootDir, generation: 1, backupDir });

  const conversion = runGenerationTwoConversion({ backupDir, mode: "convert", destinationRoot });
  assert.equal(conversion.plan.ready, true);
  const converted = openSqliteEventStore({
    repoId,
    rootInput: destination,
    generation: 2,
    readOnly: true,
  });
  try {
    const certified = readCertifiedGitFollower({ rootInput: destination, repoId, store: converted });
    assert.equal(certified.cut.revision, 1);
    assert.deepEqual(certified.cut, canonicalLedgerCut(repoId, converted.eventIdentityAtRevision(1)));
    assert.equal(converted.metadata().revision, 1);
    assert.equal(existsSync(sqliteLedgerPath(destination, 2)), true);
  } finally {
    converted.close();
  }
});
