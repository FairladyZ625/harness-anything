import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Count production file reads, including baseline reads, rather than imposing a wall-clock budget. */
export async function measureWorktreeDocuments(rootDir, size, legacy = false) {
  const { taskWorktreeCandidateInventory } = await import(
    pathToFileURL(path.join(rootDir, "packages/daemon/src/task-worktree-candidates.ts")).href
  );
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-worktree-doc-cost-")),
    worker = path.join(scratch, "worker"),
    packagePath = "tasks/task-cost-package",
    documents = path.join(worker, "harness", packagePath, "artifacts"),
    bases = path.join(scratch, "git-state", "harness-ledger-base", packagePath, "artifacts"),
    counts = { fileReads: 0, fileReadBytes: 0, metadataReads: 0 },
    recovery = { queries: 0, blobs: 0 },
    read = fs.readFileSync;
  try {
    mkdirSync(path.join(scratch, "harness"));
    mkdirSync(documents, { recursive: true });
    mkdirSync(bases, { recursive: true });
    writeFileSync(path.join(worker, ".git"), "gitdir: ../git-state\n");
    for (let index = 0; index < size; index += 1) {
      const name = `${String(index).padStart(5, "0")}.md`;
      writeFileSync(path.join(documents, name), index === size - 1 ? "worker edit\n" : "original\n");
      if (!legacy) writeFileSync(path.join(bases, name), "original\n");
    }
    fs.readFileSync = function (file, ...args) {
      const result = read(file, ...args);
      if (String(file).startsWith(scratch + path.sep)) {
        if (String(file) === path.join(worker, ".git")) counts.metadataReads += 1;
        else {
          counts.fileReads += 1;
          counts.fileReadBytes += Buffer.byteLength(result);
        }
      }
      return result;
    };
    syncBuiltinESMExports();
    const historicalEvent = {
      schema: "doc-event/v1",
      type: "documents_written",
      workspaceRevision: 1,
      occurredAt: "2000-01-01T00:00:00.000Z",
      actor: { principal: { personId: "cost" }, executor: null },
      source: "local",
      payload: {
        executionId: "execution-cost",
        changes: Array.from({ length: size }, (_, index) => ({
          path: `${packagePath}/artifacts/${String(index).padStart(5, "0")}.md`,
          candidate: { sha256: "0".repeat(64), size: 9, mediaType: "text/markdown" },
        })),
      },
    };
    const history = legacy
      ? {
          executionIds: ["execution-cost"],
          store: {
            queryEvents: ({ revisionBound }) => {
              recovery.queries += 1;
              return revisionBound === undefined ? [historicalEvent] : [];
            },
            readContentBlob: () => {
              recovery.blobs += 1;
              return Buffer.from("original\n");
            },
          },
        }
      : undefined;
    const inventory = taskWorktreeCandidateInventory(
      scratch,
      worker,
      packagePath,
      {
        repoId: "cost",
        revision: 1,
        headDigest: "sha256:" + "0".repeat(64),
      },
      history,
    );
    assert.equal(inventory.rows.length, 1, "unchanged files never become writes");
    assert.equal(inventory.rows[0].path, `${packagePath}/artifacts/${String(size - 1).padStart(5, "0")}.md`);
    assert.equal(counts.fileReads, 2 * size, "each worker file and its base are read exactly once");
    assert.equal(counts.metadataReads, legacy ? 2 : 1, "Git metadata is resolved per batch, never per file");
    if (legacy) {
      assert.equal(recovery.queries, 2, "one historical page plus EOF covers every missing base");
      assert.equal(recovery.blobs, 1, "the shared original blob is read exactly once");
    }
    return { size, counts, ...(legacy ? { recovery } : {}) };
  } finally {
    fs.readFileSync = read;
    syncBuiltinESMExports();
    rmSync(scratch, { recursive: true, force: true });
  }
}
