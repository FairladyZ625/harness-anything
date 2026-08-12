// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRepoCell } from "../src/repo-cell.ts";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;

test("RepoCell serializes identical lifecycle intents into one Git publication and one applied receipt", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId: "alpha", rootDir, ownerId: "daemon-test" });
    const action = { kind: "task-create", verb: "create", commandType: "CreateReplayTask", taskId: "task-alpha",
      title: "Alpha task", completionGateIds: [] } as const;

    const [left, right] = await Promise.all([
      cell.run(action, { actor, source: "local" }),
      cell.run(action, { actor, source: "local" })
    ]);

    assert.deepEqual([left.outcome, right.outcome], ["applied", "applied"], JSON.stringify([left, right]));
    assert.equal(left.opId, right.opId);
    assert.equal(left.revision, 1);
    assert.equal(git(rootDir, "rev-list", "--count", "HEAD"), "2");
    const shown = await cell.run({ kind: "task-show", verb: "show", taskId: "task-alpha" }, { actor, source: "local" });
    assert.equal(shown.outcome, "applied");
    assert.match(String(shown.evidence), /Alpha task/u);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

for (const killpoint of ["before_event_write", "after_event_write", "after_head_write", "after_git_commit",
  "after_sqlite_commit", "before_response_write", "after_response_write"] as const) {
  test(`RepoCell new generation recovers ${killpoint} without a duplicate publication`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repo-cell-crash-"));
    const action = { kind: "task-create", taskId: `task-${killpoint}`, title: killpoint, completionGateIds: [] } as const;
    let crashed: Awaited<ReturnType<typeof openRepoCell>> | undefined, recovered: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      initRepo(rootDir); crashed = await openRepoCell({ repoId: "crash", rootDir, ownerId: "generation-one",
        killpoint: (point) => { if (point === killpoint) throw new Error(`crash:${point}`); } });
      const first = await crashed.run(action, { actor, source: "local" });
      assert.equal(first.outcome, "rejected"); assert.equal(crashed.status().state, "unavailable");
      await crashed.close(); crashed = undefined;
      recovered = await openRepoCell({ repoId: "crash", rootDir, ownerId: "generation-two" });
      const retried = await recovered.run(action, { actor, source: "local" });
      assert.equal(retried.outcome, "applied", JSON.stringify(retried));
      assert.equal(git(rootDir, "rev-list", "--count", "HEAD"), "2");
    } finally { await crashed?.close(); await recovered?.close(); rmSync(rootDir, { recursive: true, force: true }); }
  });
}

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "RepoCell Test");
  git(rootDir, "config", "user.email", "repo-cell@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "config", "maintenance.auto", "false");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
