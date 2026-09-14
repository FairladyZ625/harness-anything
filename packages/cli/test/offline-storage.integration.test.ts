// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";
import { flatLedgerFixture } from "../../kernel/test/store/task-event-store.fixtures.ts";

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));

function invokeCli(argv: readonly string[]): Record<string, unknown> {
  const result = invokeCliResult(argv);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}
function invokeCliResult(argv: readonly string[]) {
  return spawnSync(process.execPath, [cli, ...argv, "--json"], { encoding: "utf8" });
}

test("daemon offline storage reports malformed invocations through the CLI", () => {
  const result = invokeCliResult(["restore"]),
    receipt = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  assert.equal(result.status, 1);
  assert.equal(receipt.code, "offline_storage_failed");
});

test("backup failure receipts carry the missing source path and errno through human rendering", () => {
  const missingRoot = path.join(os.tmpdir(), `ha-cli-missing-root-${process.pid}-${Date.now()}`),
    backupDir = path.join(os.tmpdir(), `ha-cli-missing-backup-${process.pid}-${Date.now()}`),
    result = invokeCliResult(["backup", backupDir, "--root", missingRoot]),
    receipt = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  try {
    assert.equal(result.status, 1);
    const hint = String(receipt.hint);
    assert.equal(receipt.code, "offline_storage_failed");
    assert.ok(hint.includes(`${missingRoot}/harness`), hint);
    assert.ok(hint.includes("No such file or directory"), hint);
    const rendered = renderCliReceipt(receipt);
    assert.equal(rendered.stream, "stderr");
    assert.ok(rendered.text.includes(hint), rendered.text);
  } finally {
    rmSync(backupDir, { recursive: true, force: true });
  }
});

test("CLI delegates backup, restore drill and event tail to the daemon offline host", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-cli-offline-spawn-")),
    backupDir = path.join(os.tmpdir(), `ha-cli-spawn-backup-${process.pid}-${Date.now()}`),
    { parent } = flatLedgerFixture(root, 1);
  try {
    execFileSync("git", ["update-ref", "refs/ha/canonical", parent], { cwd: root });
    const backup = invokeCli(["backup", backupDir, "--root", root]),
      restore = invokeCli([
        "restore",
        "--drill",
        backupDir,
        "--root",
        root,
        "--shadow-parent",
        path.join(root, "drills"),
      ]),
      events = invokeCli(["events", "tail", "--root", root, "--since", "0"]);
    assert.equal(backup.schema, "ledger-backup-receipt/v1");
    assert.equal(restore.schema, "ledger-restore-drill-receipt/v1");
    assert.equal(events.schema, "offline-ledger-events/v1");
    assert.equal((events.events as readonly unknown[]).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  }
});

test("offline restore drill reads retention from harness.yaml and defaults to three", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-cli-offline-retention-")),
    backupDir = path.join(os.tmpdir(), `ha-cli-retention-backup-${process.pid}-${Date.now()}`),
    shadowParent = path.join(root, "drills"),
    { parent } = flatLedgerFixture(root, 1);
  try {
    execFileSync("git", ["update-ref", "refs/ha/canonical", parent], { cwd: root });
    invokeCli(["backup", backupDir, "--root", root]);
    writeFileSync(path.join(root, "harness", "harness.yaml"), "settings:\n  restoreDrillRetention: 1\n");
    for (let index = 0; index < 2; index += 1)
      invokeCli(["restore", "--drill", backupDir, "--root", root, "--shadow-parent", shadowParent]);
    const configured = invokeCli(["restore", "--drill", backupDir, "--root", root, "--shadow-parent", shadowParent]);
    assert.equal((configured.removedShadowRoots as readonly string[]).length, 1);

    writeFileSync(path.join(root, "harness", "harness.yaml"), "settings:\n");
    for (let index = 0; index < 4; index += 1)
      invokeCli(["restore", "--drill", backupDir, "--root", root, "--shadow-parent", shadowParent]);
    const defaulted = invokeCli(["restore", "--drill", backupDir, "--root", root, "--shadow-parent", shadowParent]);
    assert.equal((defaulted.removedShadowRoots as readonly string[]).length, 1);
    assert.equal(readdirSync(shadowParent).filter((entry) => entry.startsWith("restore-drill-")).length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  }
});
