import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const load = (rootDir, relative) => import(pathToFileURL(path.join(rootDir, relative)).href);

/**
 * The scheduled ledger backup (`schedule-run-now` of builtin ledger-backup) holds the single write
 * queue for its capture. Measure the files that capture copies while `size` ledger files stay
 * unchanged between the pre-cut stage and the cut and one file changes: the held copy work must not
 * grow with the ledger (2026-11-08: a whole-ledger capture held the canonical queue for ~10 minutes).
 */
export async function measureBackupCaptureCopies(rootDir, size) {
  const [{ createLedgerBackup, stageLedgerBackup }, { flatLedgerFixture }] = await Promise.all([
      load(rootDir, "packages/storage/src/store/ledger-backup.ts"),
      load(rootDir, "packages/storage/test/store/task-event-store.fixtures.ts"),
    ]),
    root = mkdtempSync(path.join(tmpdir(), "ha-g38-backup-capture-")),
    authored = path.join(root, "harness"),
    backupDir = path.join(root, "backup");
  try {
    flatLedgerFixture(root, 1);
    for (let index = 0; index < size; index += 1)
      writeFileSync(path.join(authored, `ledger-file-${String(index).padStart(5, "0")}.md`), `unchanged ${index}\n`);
    const git = (...args) => execFileSync("git", args, { cwd: authored, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.name", "G38 Backup Capture");
    git("config", "user.email", "g38@example.invalid");
    git("config", "gc.auto", "0");
    git("add", "-A", ".");
    git("commit", "-qm", "ledger");
    git("update-ref", "refs/ha/canonical", "HEAD");
    const stage = stageLedgerBackup({ rootInput: root, backupDir });
    writeFileSync(path.join(authored, "ledger-file-00000.md"), "changed between stage and cut\n");
    let capture;
    createLedgerBackup({
      generation: 1,
      rootInput: root,
      backupDir,
      stage,
      onSnapshotCaptured: (captured) => {
        capture = captured;
      },
    });
    assert.ok(capture, "the capture must report what it copied while the writer is held");
    return { size, counts: { captureCopiedFiles: capture.copiedFiles } };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
