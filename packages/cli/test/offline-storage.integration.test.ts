// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isOfflineStorageCommand, runOfflineStorageCommand } from "../src/cli-offline-storage.ts";
import { flatLedgerFixture } from "../../kernel/test/store/task-event-store.fixtures.ts";

test("offline storage routing is limited to backup, restore and events", () => {
  assert.equal(isOfflineStorageCommand(["backup"]), true);
  assert.equal(isOfflineStorageCommand(["restore"]), true);
  assert.equal(isOfflineStorageCommand(["events"]), true);
  assert.equal(isOfflineStorageCommand(["task", "show"]), false);
});

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
