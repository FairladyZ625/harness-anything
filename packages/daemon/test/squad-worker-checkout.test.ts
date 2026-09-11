// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareWorkerWorktree } from "../src/squad-worker-checkout.ts";

test("the same squad worker receives a distinct checkout for each attempt", () => {
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
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim(),
      state = { squadRunId: "squad_0123456789abcdef01234567", cwd: rootDir, baseSha },
      first = prepareWorkerWorktree(state, "worker-3", "worker-1"),
      second = prepareWorkerWorktree(state, "worker-3", "worker-2");

    assert.notEqual(first?.cwd, second?.cwd);
    assert.notEqual(first?.branch, second?.branch);
    assert.equal(first?.baseSha, baseSha);
    assert.equal(second?.baseSha, baseSha);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
