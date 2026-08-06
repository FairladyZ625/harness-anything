// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { resolveCommitPlan } from "../../src/write-coordination/journal/publication/git.ts";
import { withTempStore } from "./helpers.ts";

test("resolveCommitPlan fails closed when missing authored root is inside the outer repo", () => {
  withTempStore((rootDir) => {
    runGit(rootDir, "init");
    writeFileSync(path.join(rootDir, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
    runGit(rootDir, "add", ".gitignore");
    runGit(rootDir, "commit", "-m", "ignore private harness");
    const beforeHead = runGit(rootDir, "rev-parse", "HEAD");

    assert.throws(
      () => resolveCommitPlan(rootDir, [path.join(rootDir, "harness/tasks/task-1/notes.md")], rootDir),
      (error: unknown) => {
        assert.equal((error as { readonly code?: unknown }).code, "authored_root_not_isolated");
        assert.match(String(error), /authored root is not isolated from the outer code repository/u);
        return true;
      }
    );
    assert.equal(runGit(rootDir, "rev-parse", "HEAD"), beforeHead);
    assert.equal(runGit(rootDir, "branch", "--list", "sessions/*"), "");
  });
});

function runGit(repoRoot: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Harness Test",
      GIT_AUTHOR_EMAIL: "harness-test@example.invalid",
      GIT_COMMITTER_NAME: "Harness Test",
      GIT_COMMITTER_EMAIL: "harness-test@example.invalid"
    }
  }).trim();
}
