// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createLedgerBackup, drillLedgerBackup, readOfflineLedgerEvents } from "../../src/store/ledger-backup.ts";
import { openSqliteEventStore, sqliteLedgerPath } from "../../src/store/sqlite-event-store.ts";
import { sha256Bytes, sha256Text } from "../../src/integrity/stable-hash.ts";
import { event, flatLedgerFixture } from "./task-event-store.fixtures.ts";

test("generation-aware backup preserves legacy sources and does not create an absent generation", () => {
  const root = fixture("legacy"),
    backupDir = path.join(os.tmpdir(), `ha-backup-${process.pid}-${Date.now()}`),
    interruptedDir = `${backupDir}-interrupted`;
  try {
    writeFileSync(interruptedDir, "partial backup");
    assert.throws(() => createLedgerBackup({ rootInput: root, backupDir: interruptedDir }), /must not already exist/u);
    const manifest = createLedgerBackup({ rootInput: root, backupDir, now: new Date("2026-09-06T00:00:00Z") });
    assert.deepEqual(manifest.accepted, { revision: 1, opIds: 1 });
    assert.equal(manifest.sqlite.present, false);
    const eventFile = manifest.files.find(
      ({ path: file }) => file.startsWith("harness/events/") && file.endsWith(".json") && !file.endsWith("head.json"),
    )!;
    assert.ok(eventFile);
    assert.equal(
      manifest.files.some(({ path: file }) => file.endsWith("ledger.sqlite")),
      false,
    );
    assert.equal(readOfflineLedgerEvents({ rootInput: root }).length, 1);
    const drilled = drillLedgerBackup({ backupDir, shadowParent: path.join(root, "shadow") });
    assert.equal(readFileSync(path.join(drilled.shadowRoot, eventFile.path), "utf8").length > 0, true);
    writeFileSync(path.join(backupDir, "payload", eventFile.path), "corrupt");
    assert.throws(() => drillLedgerBackup({ backupDir, shadowParent: path.join(root, "shadow") }), /digest differs/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
    rmSync(interruptedDir, { recursive: true, force: true });
  }
});

test("VACUUM backup survives source deletion and rejects wrong generation metadata", () => {
  const root = fixture("sqlite"),
    databasePath = sqliteLedgerPath(root),
    backupDir = path.join(os.tmpdir(), `ha-backup-sqlite-${process.pid}-${Date.now()}`),
    store = openSqliteEventStore({ repoId: "backup-test", rootInput: root });
  try {
    store.appendCommand({
      fence: { repoId: "backup-test", holder: "test", epoch: 1 },
      intent: { opId: event.opId, intentDigest: `sha256:${sha256Text(JSON.stringify(event))}`, summary: event.type },
      events: [event],
    });
    store.close();
    const before = openSqliteEventStore({ databasePath, readOnly: true }).readCommandOutcome(event.opId);
    createLedgerBackup({ rootInput: root, backupDir });
    rmSync(databasePath, { force: true });
    const drilled = drillLedgerBackup({ backupDir, shadowParent: path.join(root, "shadow") }),
      restoredPath = path.join(drilled.shadowRoot, path.relative(root, databasePath)),
      restored = openSqliteEventStore({ databasePath: restoredPath, readOnly: true });
    assert.deepEqual(restored.readCommandOutcome(event.opId), before);
    restored.close();
    const backupDatabasePath = path.join(backupDir, "payload", path.relative(root, databasePath)),
      db = new DatabaseSync(backupDatabasePath);
    db.prepare("UPDATE ledger_meta SET generation=2 WHERE singleton=1").run();
    db.close();
    const manifestPath = path.join(backupDir, "manifest.json"),
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        files: { path: string; size: number; backupSha256: string }[];
      },
      entry = manifest.files.find(({ path: file }) => file.endsWith("ledger.sqlite"))!;
    entry.size = statSync(backupDatabasePath).size;
    entry.backupSha256 = `sha256:${sha256Bytes(readFileSync(backupDatabasePath))}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(
      () => drillLedgerBackup({ backupDir, shadowParent: path.join(root, "wrong") }),
      /generation metadata differs/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  }
});

function fixture(name: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), `ha-ledger-backup-${name}-`)),
    { parent } = flatLedgerFixture(root, 1);
  execFileSync("git", ["update-ref", "refs/ha/canonical", parent], { cwd: root });
  return root;
}
