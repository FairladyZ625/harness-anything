// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { actor, git, initRepo, write } from "./doc-sync-slice-a.fixtures.ts";

test("WAL flush settles an eligible authored edit and status highlights blocked candidates", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-authored-wal-doc-sync-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("authored-wal-doc-sync"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "authored-wal-doc-sync-daemon",
  });
  const binding = { actor, source: "local" as const };
  try {
    assert.equal(
      (await cell.run({ kind: "task-create", taskId: "task-authored-wal", title: "Authored WAL" }, binding)).outcome,
      "applied",
    );
    write(rootDir, "context/auto.md", "# Settled by WAL\n");

    const tracked = path.join(rootDir, "harness/context/auto.md"),
      deadline = Date.now() + 10_000;
    while (!gitHasPath(rootDir, "harness/context/auto.md") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(gitHasPath(rootDir, "harness/context/auto.md"), true, "eligible edit did not reach HEAD in time");
    assert.equal(readFileSync(tracked, "utf8"), "# Settled by WAL\n");

    write(rootDir, "harness.yaml", "schema: hand-edited\n");
    const status = await cell.run({ kind: "doc-status", paths: ["harness.yaml"] }, binding);
    assert.match(status.summary ?? "", /doc-status: BLOCKED \(1\)/u);
    assert.match(status.summary ?? "", /harness\.yaml\tblocked/u);
  } finally {
    await cell.close();
    assert.equal(git(rootDir, "diff", "--name-only"), "");
    assert.match(git(rootDir, "status", "--porcelain", "-uall"), /\?\? harness\/harness\.yaml/u);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function gitHasPath(rootDir: string, target: string): boolean {
  try {
    execFileSync("git", ["-C", rootDir, "ls-files", "--error-unmatch", "--", target], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
