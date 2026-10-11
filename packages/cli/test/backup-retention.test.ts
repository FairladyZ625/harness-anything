// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultBackupRetentionDays,
  listBackupRetention,
  parseBackupRetentionInvocation,
  renderBackupRetention,
  runBackupRetention,
} from "../src/cli/thin-command-backup-retention.ts";

const now = "2026-10-11T00:00:00.000Z";

function ageRoot(daysAgo: (name: string) => number): string {
  const root = mkdtempSync(path.join(tmpdir(), "ha-backup-retention-"));
  for (const name of ["gen3-migration-20261010", "pre-work-migration-20260928", "CURRENT_RUN"]) {
    const target = path.join(root, name);
    if (name === "CURRENT_RUN") writeFileSync(target, "run-final-20261011T0222\n");
    else mkdirSync(target);
    const at = new Date(Date.parse(now) - daysAgo(name) * 86_400_000);
    utimesSync(target, at, at);
  }
  return root;
}

test("the listing marks entries past the retention window and keeps fresh ones retained", () => {
  const root = ageRoot((name) => (name === "pre-work-migration-20260928" ? 40 : 2));
  try {
    const entries = listBackupRetention({ backupRoot: root, now, keepDays: defaultBackupRetentionDays });
    assert.deepEqual(
      entries.map((entry) => [entry.name, entry.kind, entry.expired]),
      [
        ["pre-work-migration-20260928", "directory", true],
        ["CURRENT_RUN", "file", false],
        ["gen3-migration-20261010", "directory", false],
      ],
    );
    const expired = entries.find((entry) => entry.name === "pre-work-migration-20260928")!;
    assert.equal(expired.ageDays > 30, true);
    const rendered = renderBackupRetention(entries, defaultBackupRetentionDays, root);
    assert.match(rendered, /pre-work-migration-20260928\tdirectory\t[^\t]+\t40\.0\texpired \(past 30d\)/u);
    assert.match(rendered, /3 entries, 1 past the 30-day retention window\./u);
    assert.match(rendered, /never deleted/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing backup root lists empty instead of failing", () => {
  const root = path.join(tmpdir(), "ha-backup-retention-absent");
  rmSync(root, { recursive: true, force: true });
  assert.deepEqual(listBackupRetention({ backupRoot: root, now, keepDays: 30 }), []);
  assert.equal(renderBackupRetention([], 30, root), `No backup entries under ${root}.`);
});

test("an unreadable backup root fails with its own error code instead of listing empty", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-backup-retention-file-root-"));
  try {
    const backupRoot = path.join(userRoot, "backups");
    writeFileSync(backupRoot, "a regular file where the backup root should be\n");
    assert.throws(
      () => listBackupRetention({ backupRoot, now, keepDays: 30 }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOTDIR",
    );
    await assert.rejects(
      runBackupRetention({ days: 30, userRoot, json: false }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOTDIR",
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("the boundary day is retained and the day after expires", () => {
  // Half-day offsets keep the comparison robust against filesystem timestamp rounding.
  const fresh = ageRoot(() => 29.5),
    stale = ageRoot(() => 30.5);
  try {
    const boundary = listBackupRetention({ backupRoot: fresh, now, keepDays: 30 });
    assert.equal(
      boundary.every((entry) => entry.expired === false),
      true,
    );
    const past = listBackupRetention({ backupRoot: stale, now, keepDays: 30 });
    assert.equal(
      past.every((entry) => entry.expired === true),
      true,
    );
  } finally {
    rmSync(fresh, { recursive: true, force: true });
    rmSync(stale, { recursive: true, force: true });
  }
});

test("invocation parsing accepts the retention flags and rejects anything else", () => {
  assert.deepEqual(parseBackupRetentionInvocation(["backup", "retention"]), {
    days: 30,
    userRoot: undefined,
    json: false,
  });
  assert.deepEqual(parseBackupRetentionInvocation(["backup", "retention", "--days", "7", "--json"]), {
    days: 7,
    userRoot: undefined,
    json: true,
  });
  assert.deepEqual(parseBackupRetentionInvocation(["backup", "retention", "--user-root", "/tmp/ha"]), {
    days: 30,
    userRoot: "/tmp/ha",
    json: false,
  });
  for (const argv of [
    ["backup", "retention", "--days", "0"],
    ["backup", "retention", "--days"],
    ["backup", "retention", "--days", "abc"],
    ["backup", "retention", "--user-root"],
    ["backup", "retention", "--wipe"],
  ])
    assert.equal(typeof parseBackupRetentionInvocation(argv), "string", JSON.stringify(argv));
});
