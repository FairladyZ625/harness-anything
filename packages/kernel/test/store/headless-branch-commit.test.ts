// harness-test-tier: fast
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { commitPathsToBranchHeadless } from "../../src/persistence/git/headless-branch-commit.ts";
import type { ScopedIndexGitOperations } from "../../src/persistence/git/scoped-index-commit.ts";

test("headless branch publication batches ref resolution and path staging", () => {
  const calls: ReadonlyArray<string>[] = [];
  const present = new Set(["first.md", "second.md"]);
  const git: ScopedIndexGitOperations = {
    runGitBytes: () => new Uint8Array(),
    runGitWithInput: () => "",
    runGitWithInputEnvironment: () => "",
    runGitWithEnvironment: (_repoRoot, _author, _environment, ...args) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args.includes("--verify")) throw new Error("missing session branch");
      if (args[0] === "rev-parse") return "base-sha\nbase-tree\n";
      if (args[0] === "write-tree") return "new-tree\n";
      if (args[0] === "commit-tree") return "commit-sha\n";
      return "";
    },
    fileSystem: {
      exists: () => false,
      lstat: (inputPath) => {
        if (!present.has(path.basename(inputPath))) throw new Error("missing");
        return { mode: 0o100644, isSymbolicLink: () => false };
      },
      readFile: () => new Uint8Array(),
      readLink: () => "",
      makeTemporaryDirectory: () => "/tmp/ha-headless-branch-commit-test",
      removeTemporaryDirectory: () => undefined
    }
  };

  const commitSha = commitPathsToBranchHeadless("/repo", {
    branchName: "sessions/test",
    baseBranchName: "main",
    stagePaths: ["first.md", "second.md", "removed-one.md", "removed-two.md", "excluded.log"],
    excludePaths: new Set(["excluded.log"]),
    message: "batch paths"
  }, git);

  assert.equal(commitSha, "commit-sha");
  assert.deepEqual(
    calls.filter((args) => args[0] === "rev-parse"),
    [
      ["rev-parse", "--verify", "--quiet", "sessions/test^{commit}"],
      ["rev-parse", "main", "main^{tree}"]
    ]
  );
  assert.deepEqual(
    calls.filter((args) => args[0] === "update-index"),
    [
      ["update-index", "--add", "--", "first.md", "second.md"],
      ["update-index", "--force-remove", "--", "removed-one.md", "removed-two.md"]
    ]
  );
});
