// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createLedgerBackup,
  readVerifiedLedgerBackup,
  stageLedgerBackup,
  type LedgerBackupCapture,
} from "../../src/store/ledger-backup.ts";
import { flatLedgerFixture } from "./task-event-store.fixtures.ts";

// The scheduled backup holds the single writer queue only for its capture. A capture that re-copies
// every ledger file holds it for minutes on a production-sized ledger (2026-11-08: 03:17-03:27 UTC,
// task-create queued 570 s); after a stage, the capture copies only what changed since the stage.
test("a staged capture copies only changed sources and yields the same payload as a single pass", () => {
  const root = fixture(),
    authored = path.join(root, "harness"),
    stagedDir = path.join(root, "backup-staged"),
    singleDir = path.join(root, "backup-single"),
    unchangedCount = 40;
  try {
    for (let index = 0; index < unchangedCount; index += 1)
      writeFileSync(path.join(authored, `note-${index}.md`), `unchanged ${index}\n`);
    writeFileSync(path.join(authored, "edited.md"), "before stage\n");
    writeFileSync(path.join(authored, "deleted.md"), "deleted after stage\n");
    writeFileSync(path.join(authored, "becomes-dir"), "file before stage\n");
    commitAll(authored, "stage sources");

    const stage = stageLedgerBackup({ rootInput: root, backupDir: stagedDir });
    assert.ok(stage.copied.size > unchangedCount, "the stage copies the live sources before the cut");

    // Writes the writer accepts between stage and cut.
    writeFileSync(path.join(authored, "edited.md"), "after stage, before cut\n");
    writeFileSync(path.join(authored, "added.md"), "added after stage\n");
    rmSync(path.join(authored, "deleted.md"));
    rmSync(path.join(authored, "becomes-dir"));
    mkdirSync(path.join(authored, "becomes-dir"));
    writeFileSync(path.join(authored, "becomes-dir", "inner.md"), "directory after stage\n");

    let capture: LedgerBackupCapture | undefined;
    const staged = createLedgerBackup({
      generation: 1,
      rootInput: root,
      backupDir: stagedDir,
      stage,
      onSnapshotCaptured: (captured) => {
        capture = captured;
        writeFileSync(path.join(authored, "edited.md"), "after cut\n");
      },
    });
    writeFileSync(path.join(authored, "edited.md"), "after stage, before cut\n");
    let singleCapture: LedgerBackupCapture | undefined;
    const single = createLedgerBackup({
      generation: 1,
      rootInput: root,
      backupDir: singleDir,
      onSnapshotCaptured: (captured) => {
        singleCapture = captured;
      },
    });

    assert.equal(capture!.copiedFiles, 3, "the capture copies edited.md, added.md and becomes-dir/inner.md only");
    assert.equal(capture!.removedFiles, 1, "the deleted staged file leaves the payload");
    assert.ok(
      singleCapture!.copiedFiles > unchangedCount,
      "negative control: a single pass copies every source inside the capture",
    );
    const contentOf = (manifest: typeof staged) =>
      manifest.files.map(({ path: file, backupSha256 }) => `${file} ${backupSha256}`);
    assert.deepEqual(contentOf(staged), contentOf(single));
    const payload = path.join(stagedDir, "payload", "harness");
    assert.equal(readFileSync(path.join(payload, "edited.md"), "utf8"), "after stage, before cut\n");
    assert.equal(readFileSync(path.join(payload, "added.md"), "utf8"), "added after stage\n");
    assert.equal(readFileSync(path.join(payload, "becomes-dir", "inner.md"), "utf8"), "directory after stage\n");
    assert.equal(existsSync(path.join(payload, "deleted.md")), false);
    assert.deepEqual(readVerifiedLedgerBackup(stagedDir), staged);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stage is bound to its own backup directory", () => {
  const root = fixture();
  try {
    const stage = stageLedgerBackup({ rootInput: root, backupDir: path.join(root, "backup-a") });
    assert.throws(
      () => createLedgerBackup({ generation: 1, rootInput: root, backupDir: path.join(root, "backup-b"), stage }),
      /backup stage belongs to another directory/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function commitAll(cwd: string, message: string): void {
  execFileSync("git", ["add", "-A", "."], { cwd });
  execFileSync("git", ["commit", "-qm", message], { cwd });
}

function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-ledger-backup-stage-")),
    cwd = path.join(root, "harness");
  flatLedgerFixture(root, 1);
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.name", "Store Test"], { cwd });
  execFileSync("git", ["config", "user.email", "store@example.invalid"], { cwd });
  execFileSync("git", ["config", "gc.auto", "0"], { cwd });
  commitAll(cwd, "tracked authored backup fixture");
  const parent = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  execFileSync("git", ["update-ref", "refs/ha/canonical", parent], { cwd });
  return root;
}
