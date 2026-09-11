// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runOfflineStorageCommand } from "../src/cli-offline-storage.ts";
import { flatLedgerFixture } from "../../kernel/test/store/task-event-store.fixtures.ts";

test("offline storage reports malformed invocations without daemon dispatch", () => {
  const receipts: Record<string, unknown>[] = [],
    emit = (receipt: Record<string, unknown>): void => {
      receipts.push(receipt);
    };
  assert.equal(runOfflineStorageCommand(["restore"], emit), 1);
  assert.equal(receipts[0]?.code, "offline_storage_failed");
});

test("offline CLI runs backup, restore drill and event tail without daemon dispatch", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-cli-offline-")),
    backupDir = path.join(os.tmpdir(), `ha-cli-backup-${process.pid}-${Date.now()}`),
    { parent } = flatLedgerFixture(root, 1),
    receipts: Record<string, unknown>[] = [],
    emit = (receipt: Record<string, unknown>): void => {
      receipts.push(receipt);
    };
  try {
    execFileSync("git", ["update-ref", "refs/ha/canonical", parent], { cwd: root });
    assert.equal(runOfflineStorageCommand(["backup", backupDir, "--root", root, "--json"], emit), 0);
    assert.equal(
      runOfflineStorageCommand(
        ["restore", "--drill", backupDir, "--root", root, "--shadow-parent", path.join(root, "drills"), "--json"],
        emit,
      ),
      0,
    );
    assert.equal(runOfflineStorageCommand(["events", "tail", "--root", root, "--since", "0", "--json"], emit), 0);
    assert.deepEqual(
      receipts.map(({ ok }) => ok),
      [true, true, true],
    );
    assert.equal((receipts[2]?.events as readonly unknown[]).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  }
});

test("offline restore drill reads retention from harness.yaml and defaults to three", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-cli-offline-retention-")),
    backupDir = path.join(os.tmpdir(), `ha-cli-retention-backup-${process.pid}-${Date.now()}`),
    shadowParent = path.join(root, "drills"),
    { parent } = flatLedgerFixture(root, 1),
    receipts: Record<string, unknown>[] = [],
    emit = (receipt: Record<string, unknown>): void => {
      receipts.push(receipt);
    };
  try {
    execFileSync("git", ["update-ref", "refs/ha/canonical", parent], { cwd: root });
    assert.equal(runOfflineStorageCommand(["backup", backupDir, "--root", root, "--json"], emit), 0);
    writeFileSync(path.join(root, "harness", "harness.yaml"), "settings:\n  restoreDrillRetention: 1\n");
    for (let index = 0; index < 2; index += 1)
      assert.equal(
        runOfflineStorageCommand(
          ["restore", "--drill", backupDir, "--root", root, "--shadow-parent", shadowParent, "--json"],
          emit,
        ),
        0,
      );
    const configured = receipts.at(-1)!;
    assert.equal((configured.removedShadowRoots as readonly string[]).length, 1);

    writeFileSync(path.join(root, "harness", "harness.yaml"), "settings:\n");
    for (let index = 0; index < 4; index += 1)
      assert.equal(
        runOfflineStorageCommand(
          ["restore", "--drill", backupDir, "--root", root, "--shadow-parent", shadowParent, "--json"],
          emit,
        ),
        0,
      );
    const defaulted = receipts.at(-1)!;
    assert.equal((defaulted.removedShadowRoots as readonly string[]).length, 1);
    assert.equal(readdirSync(shadowParent).filter((entry) => entry.startsWith("restore-drill-")).length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  }
});
