import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Count production file reads, including baseline reads, rather than imposing a wall-clock budget. */
export async function measureWorktreeDocuments(rootDir, size) {
  const { taskWorktreeCandidateInventory } = await import(
    pathToFileURL(path.join(rootDir, "packages/daemon/src/task-worktree-candidates.ts")).href
  );
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-worktree-doc-cost-")),
    worker = path.join(scratch, "worker"),
    packagePath = "tasks/task-cost-package",
    documents = path.join(worker, "harness", packagePath, "artifacts"),
    bases = path.join(worker, ".harness", "ledger-base", packagePath, "artifacts"),
    counts = { fileReads: 0, fileReadBytes: 0 },
    read = fs.readFileSync;
  try {
    mkdirSync(path.join(scratch, "harness"));
    mkdirSync(documents, { recursive: true });
    mkdirSync(bases, { recursive: true });
    for (let index = 0; index < size; index += 1) {
      const name = `${String(index).padStart(5, "0")}.md`;
      writeFileSync(path.join(documents, name), index === size - 1 ? "worker edit\n" : "original\n");
      writeFileSync(path.join(bases, name), "original\n");
    }
    fs.readFileSync = function (file, ...args) {
      const result = read(file, ...args);
      if (String(file).startsWith(scratch + path.sep)) {
        counts.fileReads += 1;
        counts.fileReadBytes += Buffer.byteLength(result);
      }
      return result;
    };
    syncBuiltinESMExports();
    const inventory = taskWorktreeCandidateInventory(scratch, worker, packagePath, {
      repoId: "cost",
      revision: 1,
      headDigest: "sha256:" + "0".repeat(64),
    });
    assert.equal(inventory.rows.length, 1, "unchanged files never become writes");
    assert.equal(inventory.rows[0].path, `${packagePath}/artifacts/${String(size - 1).padStart(5, "0")}.md`);
    assert.equal(counts.fileReads, 2 * size, "each worker file and its base are read exactly once");
    return { size, counts };
  } finally {
    fs.readFileSync = read;
    syncBuiltinESMExports();
    rmSync(scratch, { recursive: true, force: true });
  }
}
