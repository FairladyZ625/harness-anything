// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeLocalVersionControlCommands } from "../../src/store/local-version-control-commands.ts";
import { makeLocalVersionControlSystem } from "../../src/store/local-version-control-system.ts";
import { removeTempRepository } from "../../../../tools/fixtures/remove-temp-repository.ts";

test("currentBranch resolves unborn symbolic HEAD, committed branch, and null on detached HEAD", (t) => {
  const calls: string[][] = [],
    commands = makeLocalVersionControlCommands({
      normalizePath: (p) => p,
      topLevel: (p) => p,
      execute: (_repoRoot, ...args) => {
        calls.push([...args]);
        if (args[0] === "symbolic-ref" && args[1] === "--quiet" && args[2] === "--short" && args[3] === "HEAD")
          return "main\n";
        throw new Error(`unexpected git args: ${args.join(" ")}`);
      },
      executeAs: () => "",
    });
  assert.equal(commands.currentBranch("/repo"), "main");
  assert.deepEqual(calls, [["symbolic-ref", "--quiet", "--short", "HEAD"]]);

  const root = mkdtempSync(path.join(tmpdir(), "ha-vcs-unborn-branch-"));
  t.after(() => removeTempRepository(root));
  mkdirSync(path.join(root, ".git", "objects"), { recursive: true });
  mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(
    path.join(root, ".git", "config"),
    "[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = false\n[commit]\n\tgpgsign = false\n",
  );
  writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/trunk\n");

  const vcs = makeLocalVersionControlSystem();
  assert.equal(vcs.currentBranch(root), "trunk", "unborn HEAD resolves its symbolic branch name");

  writeFileSync(path.join(root, "README.md"), "hello\n");
  vcs.add(root, { paths: ["README.md"] });
  vcs.commit(root, "initial commit", { name: "Test Author", email: "test@example.invalid" });
  const headSha = vcs.currentHead(root);
  assert.match(headSha, /^[0-9a-f]{40}$/u);
  assert.equal(vcs.currentBranch(root), "trunk", "committed branch resolves its name");

  writeFileSync(path.join(root, ".git", "HEAD"), `${headSha}\n`);
  assert.equal(vcs.currentBranch(root), null, "detached HEAD returns null");
});
