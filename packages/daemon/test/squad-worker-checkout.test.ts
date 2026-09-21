// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareWorkerWorktree } from "../src/squad-worker-checkout.ts";

test("the same squad worker receives a distinct checkout for each attempt", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-worker-checkout-"));
  try {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: rootDir });
    writeFileSync(path.join(rootDir, "baseline.txt"), "baseline\n");
    execFileSync("git", ["add", "baseline.txt"], { cwd: rootDir });
    execFileSync(
      "git",
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "baseline"],
      {
        cwd: rootDir,
      },
    );
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: rootDir });
    execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: rootDir });
    execFileSync("git", ["branch", "-m", "codex/mission"], { cwd: rootDir });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim(),
      state = { squadRunId: "squad_0123456789abcdef01234567", cwd: rootDir, baseSha },
      first = await prepareWorkerWorktree(state, "worker-3", "worker-1"),
      second = await prepareWorkerWorktree(state, "worker-3", "worker-2");

    assert.notEqual(first?.cwd, second?.cwd);
    assert.notEqual(first?.branch, second?.branch);
    assert.match(first?.branch ?? "", /^codex\/mission--squad-/u);
    assert.equal(first?.baseSha, baseSha);
    assert.equal(second?.baseSha, baseSha);
    assert.deepEqual(await prepareWorkerWorktree(state, "worker-3", "worker-1"), first);

    writeFileSync(path.join(first!.cwd, "worker.txt"), "worker\n");
    execFileSync("git", ["add", "worker.txt"], { cwd: first!.cwd });
    execFileSync("git", ["commit", "-m", "worker change"], {
      cwd: first!.cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    });
    const childSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: first!.cwd, encoding: "utf8" }).trim();

    execFileSync("git", ["switch", "-c", "comparison/cherry-pick", baseSha], { cwd: rootDir });
    execFileSync("git", ["cherry-pick", childSha], {
      cwd: rootDir,
      env: { ...process.env, GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z" },
    });
    const cherryPickedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim();
    assert.notEqual(cherryPickedSha, childSha, "cherry-pick recreates the child commit");

    execFileSync("git", ["switch", "codex/mission"], { cwd: rootDir });
    execFileSync("git", ["merge", "--no-ff", "--no-edit", first!.branch], { cwd: rootDir });
    execFileSync("git", ["merge-base", "--is-ancestor", childSha, "HEAD"], { cwd: rootDir });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
