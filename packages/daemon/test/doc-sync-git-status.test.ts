// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDocSyncDirtyEntries } from "../src/service/doc-sync-git-status.ts";

test("doc-sync dirty scan ignores the machine-internal .harness layer but still sees authored edits", () => {
  const authoredRoot = mkdtempSync(path.join(tmpdir(), "ha-doc-sync-status-"));
  try {
    writeFileSync(path.join(authoredRoot, "tracked.md"), "seed\n");
    git(authoredRoot, "init", "-b", "main");
    git(authoredRoot, "config", "user.name", "Harness Test");
    git(authoredRoot, "config", "user.email", "harness@example.test");
    git(authoredRoot, "add", ".");
    git(authoredRoot, "commit", "-m", "seed");

    // Machine layer: preserved snapshots must never surface as dirty prose (issue #1340).
    const preserved = path.join(authoredRoot, ".harness", "preserved-worktree-edits", "snap", "tasks");
    mkdirSync(preserved, { recursive: true });
    writeFileSync(path.join(preserved, "progress.md"), "machine snapshot\n");
    assert.deepEqual(readDocSyncDirtyEntries(authoredRoot), []);

    // Positive control: an authored edit is still reported.
    writeFileSync(path.join(authoredRoot, "tracked.md"), "edited\n");
    writeFileSync(path.join(authoredRoot, "new.md"), "fresh\n");
    const entries = readDocSyncDirtyEntries(authoredRoot);
    assert.deepEqual(
      entries.map((entry) => `${entry.status}:${entry.path}`).sort(),
      ["added:new.md", "modified:tracked.md"]
    );
  } finally {
    rmSync(authoredRoot, { recursive: true, force: true });
  }
});

function git(repoRoot: string, ...args: ReadonlyArray<string>): void {
  execFileSync("git", ["-C", repoRoot, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}
