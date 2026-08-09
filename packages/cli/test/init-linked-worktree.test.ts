// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { toCommandReceipt } from "../src/cli/receipt.ts";
import { initializeHarness } from "../src/commands/init.ts";

test("init from a linked worktree initializes and names the canonical repository", () => {
  const container = mkdtempSync(path.join(tmpdir(), "ha-init-linked-worktree-"));
  const canonicalRoot = path.join(container, "canonical");
  const worktreeRoot = path.join(container, "linked");
  try {
    execFileSync("git", ["init", "--initial-branch=main", canonicalRoot]);
    execFileSync("git", ["-C", canonicalRoot, "config", "user.name", "Harness Test"]);
    execFileSync("git", ["-C", canonicalRoot, "config", "user.email", "harness-test@example.invalid"]);
    writeFileSync(path.join(canonicalRoot, "README.md"), "fixture\n", "utf8");
    execFileSync("git", ["-C", canonicalRoot, "add", "README.md"]);
    execFileSync("git", ["-C", canonicalRoot, "commit", "-m", "fixture"]);
    execFileSync("git", ["-C", canonicalRoot, "worktree", "add", "-b", "linked", worktreeRoot]);

    const result = initializeHarness({ rootDir: worktreeRoot }, false, "Linked fixture");

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const canonical = realpathSync.native(canonicalRoot);
    assert.equal(existsSync(path.join(canonical, "harness/harness.yaml")), true);
    assert.equal(existsSync(path.join(worktreeRoot, "harness/harness.yaml")), false);
    assert.deepEqual(result.report.isolation.nextSteps.slice(0, 2), [
      `ha daemon repo register --root ${canonical}`,
      `ha --root ${canonical} doctor --json`
    ]);
    assert.equal(result.report.isolation.nextSteps.includes("ha daemon start --service"), false);
    const receipt = toCommandReceipt(result);
    assert.equal(receipt.ok, true);
    assert.match(receipt.summary, new RegExp(`Next: ha daemon repo register --root ${escapeRegExp(canonical)}; then ha --root ${escapeRegExp(canonical)} doctor --json\\.$`, "u"));
    assert.doesNotMatch(receipt.summary, /--root \.|daemon start/u);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
