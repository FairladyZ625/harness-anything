// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyLedgerBackupRetention,
  ledgerBackupDirPattern,
  planLedgerBackupRetention,
  type LedgerBackupRetentionEntryV1,
} from "../src/store/ledger-backup-retention.ts";

const policy = { keepDays: 3, keepMonthly: true };

function entry(name: string, createdAt: string): LedgerBackupRetentionEntryV1 {
  return { dir: path.join("/backup-root", name), createdAt };
}

function occurrenceDir(suffix: string): string {
  return `ledger-backup-occurrence_${suffix.padStart(24, "0")}`;
}

test("the executor naming pattern accepts occurrence and manual ids only", () => {
  assert.equal(ledgerBackupDirPattern.test(occurrenceDir("a")), true);
  assert.equal(ledgerBackupDirPattern.test(`ledger-backup-manual_${"b".padStart(24, "0")}`), true);
  assert.equal(ledgerBackupDirPattern.test("ledger-backup-2026-09-15T03-17-00-000Z"), false);
  assert.equal(ledgerBackupDirPattern.test("2026-09-15T03-17-00-000Z"), false);
  assert.equal(ledgerBackupDirPattern.test("ledger-backup-occurrence_short"), false);
});

test("backups inside the most recent keepDays natural days are all retained", () => {
  // now is late on Sep 19; keepDays=3 retains Sep 17, 18, 19 (UTC natural days).
  const deletions = planLedgerBackupRetention({
    entries: [
      entry("a", "2026-09-19T22:00:00.000Z"),
      entry("b", "2026-09-18T01:00:00.000Z"),
      entry("c", "2026-09-17T00:00:00.000Z"),
      entry("d", "2026-09-16T23:59:59.000Z"),
    ],
    now: "2026-09-19T23:30:00.000Z",
    policy,
    protectedDirs: [],
  });
  assert.deepEqual(deletions, [entry("d", "").dir]);
});

test("older backups keep the newest per calendar month and delete the rest", () => {
  const deletions = planLedgerBackupRetention({
    entries: [
      entry("aug-old", "2026-08-02T00:00:00.000Z"),
      entry("aug-new", "2026-08-30T00:00:00.000Z"),
      entry("jul-a", "2026-07-02T00:00:00.000Z"),
      entry("jul-b", "2026-07-03T00:00:00.000Z"),
      entry("sep-recent", "2026-09-18T00:00:00.000Z"),
    ],
    now: "2026-09-19T12:00:00.000Z",
    policy,
    protectedDirs: [],
  });
  assert.deepEqual(deletions, [entry("aug-old", "").dir, entry("jul-a", "").dir]);
});

test("keepMonthly=false deletes every backup older than the day window", () => {
  const deletions = planLedgerBackupRetention({
    entries: [entry("aug-new", "2026-08-30T00:00:00.000Z"), entry("sep-recent", "2026-09-18T00:00:00.000Z")],
    now: "2026-09-19T12:00:00.000Z",
    policy: { keepDays: 3, keepMonthly: false },
    protectedDirs: [],
  });
  assert.deepEqual(deletions, [entry("aug-new", "").dir]);
});

test("protected directories are never planned for deletion, even when old", () => {
  const fresh = occurrenceDir("f");
  const deletions = planLedgerBackupRetention({
    entries: [entry(fresh, "2026-06-02T00:00:00.000Z"), entry("old", "2026-06-01T00:00:00.000Z")],
    now: "2026-09-19T12:00:00.000Z",
    policy,
    protectedDirs: [path.join("/backup-root", fresh)],
  });
  assert.deepEqual(deletions, [entry("old", "").dir]);
});

test("apply removes only identified executor-named backups and skips everything else", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-backup-retention-"));
  try {
    const manifest = (createdAt: string) =>
      `${JSON.stringify({ schema: "ledger-backup/v1", createdAt, registration: null, files: [] })}\n`;
    const namedOld = occurrenceDir("1"),
      namedMonthly = occurrenceDir("2"),
      namedFresh = occurrenceDir("3"),
      agentMade = "2026-09-01T03-00-00-000Z",
      unidentified = occurrenceDir("4");
    for (const [name, createdAt] of [
      [namedOld, "2026-08-01T00:00:00.000Z"],
      [namedMonthly, "2026-08-31T00:00:00.000Z"],
      [namedFresh, "2026-09-19T01:00:00.000Z"],
    ] as const) {
      mkdirSync(path.join(root, name));
      writeFileSync(path.join(root, name, "manifest.json"), manifest(createdAt));
    }
    mkdirSync(path.join(root, agentMade));
    writeFileSync(path.join(root, agentMade, "manifest.json"), manifest("2026-08-01T00:00:00.000Z"));
    mkdirSync(path.join(root, unidentified));
    writeFileSync(path.join(root, unidentified, "manifest.json"), "not json");
    const result = applyLedgerBackupRetention({
      backupRoot: root,
      now: "2026-09-19T12:00:00.000Z",
      policy,
      protectedDirs: [path.join(root, namedFresh)],
    });
    assert.deepEqual(result.removed, [path.join(root, namedOld)]);
    assert.deepEqual([...result.retained].sort(), [path.join(root, namedFresh), path.join(root, namedMonthly)].sort());
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0] ?? "", /could not identify/u);
    assert.equal(existsSync(path.join(root, namedOld)), false);
    assert.equal(existsSync(path.join(root, agentMade)), true);
    assert.equal(existsSync(path.join(root, unidentified)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply on a missing backup root is a no-op", () => {
  assert.deepEqual(
    applyLedgerBackupRetention({
      backupRoot: "/nonexistent-backup-root",
      now: "2026-09-19T00:00:00.000Z",
      policy,
      protectedDirs: [],
    }),
    {
      removed: [],
      retained: [],
      skipped: [],
      warnings: [],
    },
  );
});
