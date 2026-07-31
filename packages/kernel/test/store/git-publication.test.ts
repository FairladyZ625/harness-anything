// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { commitTouchedPaths } from "../../src/write-coordination/journal/publication/git.ts";
import { withTempStore } from "./helpers.ts";

test("Git publication commits only exact logs explicitly preserved by operations", () => {
  withTempStore((rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    mkdirSync(harnessRoot, { recursive: true });
    runGit(harnessRoot, "init");
    writeFileSync(path.join(harnessRoot, "harness.yaml"), "schema: harness-anything/v1\n", "utf8");
    runGit(harnessRoot, "add", "harness.yaml");
    runGit(harnessRoot, "commit", "-m", "seed harness");

    const declaredLog = path.join(harnessRoot, "tasks/task-1/artifacts/declared.log");
    const runtimeLog = path.join(harnessRoot, "tasks/task-1/runtime.log");
    const authoredNote = path.join(harnessRoot, "tasks/task-1/notes.md");
    mkdirSync(path.dirname(declaredLog), { recursive: true });
    writeFileSync(declaredLog, "authored trace\n", "utf8");
    writeFileSync(runtimeLog, "runtime trace\n", "utf8");
    writeFileSync(authoredNote, "authored note\n", "utf8");

    const commitSha = commitTouchedPaths(
      rootDir,
      [declaredLog, runtimeLog, authoredNote],
      ["op-publication-log-boundary"],
      rootDir,
      "test authored log publication",
      undefined,
      {
        author: { name: "Harness Test", email: "harness-test@example.invalid" },
        preserveExplicitLogPaths: [declaredLog]
      }
    );

    assert.equal(runGit(harnessRoot, "show", `${commitSha}:tasks/task-1/artifacts/declared.log`), "authored trace");
    assert.equal(runGit(harnessRoot, "show", `${commitSha}:tasks/task-1/notes.md`), "authored note");
    assert.equal(
      runGit(harnessRoot, "ls-tree", "--name-only", commitSha, "--", "tasks/task-1/runtime.log"),
      ""
    );
    assert.equal(runGit(harnessRoot, "status", "--short", "--", "tasks/task-1/runtime.log"), "?? tasks/task-1/runtime.log");
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
