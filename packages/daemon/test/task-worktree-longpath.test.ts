// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkoutTaskWorktree, reclaimReviewWorktree } from "../src/daemon-host/task-worktree.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "core.longpaths=true", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("reclaimReviewWorktree removes detached review checkouts containing deep >260-char paths", async (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "ha-review-longpath-")),
    root = path.join(base, "repo");
  t.after(() => removeTempRepository(base));
  mkdirSync(path.join(root, "harness"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Longpath Test");
  git(root, "config", "user.email", "longpath@example.invalid");
  writeFileSync(path.join(root, "harness", "harness.yaml"), "schema: harness-anything/v1\n");
  writeFileSync(path.join(root, "README.md"), "# base\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const commitSha = git(root, "rev-parse", "HEAD");
  const review = (await checkoutTaskWorktree(
    root,
    "task-completion-review",
    { kind: "worktree", branch: "task-completion-review", path: ".worktrees/task-completion-review" },
    { setup: [], setupStepTimeoutMs: 5_000, nodeModules: { mode: "off", roots: [] } },
    undefined,
    undefined,
    { pinnedCommit: commitSha },
  ))!;
  const deepFile = path.join(
    review.cwd,
    "harness",
    "tasks",
    "task-completion-review-completion-review-long-package-segment",
    "artifacts",
    "reports",
    "nested-segment-to-exceed-windows-max-path-260-characters",
    "review-dispatch_0123456789abcdef01234567.json",
  );
  assert.ok(deepFile.length > 260, `expected deep path > 260 chars, got ${deepFile.length}: ${deepFile}`);
  mkdirSync(path.dirname(deepFile), { recursive: true });
  writeFileSync(deepFile, '{"verdict":"approved"}\n');
  assert.equal(await reclaimReviewWorktree(root, review.cwd), null);
  assert.equal(existsSync(review.cwd), false);
});
