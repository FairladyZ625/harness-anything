// harness-test-tier: contract
import assert from "node:assert/strict";
import { rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { changedFiles, git, listWorktreeFiles, pullRequestBase } from "../git.mjs";
import { commitAll, makeRepo, writeRepoFile } from "./helpers.mjs";

test("changedFiles measures the head from its merge base when the target branch advances", () => {
  const { rootDir } = makeRepo({ "shared.txt": "shared\n" });
  const targetBranch = git(rootDir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();

  git(rootDir, ["checkout", "-q", "-b", "feature"]);
  writeRepoFile(rootDir, "feature.txt", "feature\n");
  const featureHead = commitAll(rootDir, "feature change");

  git(rootDir, ["checkout", "-q", targetBranch]);
  writeRepoFile(rootDir, "package.json", "{}\n");
  const advancedTarget = commitAll(rootDir, "target-only dependency manifest");

  assert.deepEqual(git(rootDir, ["diff", "--name-only", advancedTarget, featureHead, "--"]).trim().split("\n"), [
    "feature.txt",
    "package.json",
  ]);
  assert.deepEqual(changedFiles(rootDir, advancedTarget, featureHead), ["feature.txt"]);
});

test("pullRequestBase returns the merge-base with origin/main", () => {
  const { rootDir, base } = makeRepo({ "shared.txt": "shared\n" });
  git(rootDir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  writeRepoFile(rootDir, "feature.txt", "feature\n");
  commitAll(rootDir, "feature change");

  assert.equal(pullRequestBase(rootDir), base);
});

test("pullRequestBase without origin/main fails closed with a fix", () => {
  const { rootDir } = makeRepo({ "shared.txt": "shared\n" });

  assert.throws(() => pullRequestBase(rootDir), /git merge-base origin\/main HEAD` failed/u);
  assert.throws(() => pullRequestBase(rootDir), /git fetch origin main/u);
});

test("listWorktreeFiles enumerates tracked and untracked files but never gitignored or deleted entries", () => {
  const { rootDir } = makeRepo({ "packages/cli/src/index.ts": "export {};\n" });
  writeRepoFile(rootDir, ".gitignore", "packages/gui/build-resources/\n");
  commitAll(rootDir, "ignore rule");
  writeRepoFile(rootDir, "packages/gui/src/new.ts", "export {};\n");
  writeRepoFile(rootDir, "packages/gui/build-resources/app-node_modules/daemon/package.json", "{}\n");

  const files = listWorktreeFiles(rootDir, ["packages"]);
  assert.ok(files.includes("packages/cli/src/index.ts"));
  assert.ok(files.includes("packages/gui/src/new.ts"));
  assert.ok(!files.some((file) => file.includes("build-resources")), files.join("\n"));

  // A tracked file deleted without git rm stays in the index; it is not a worktree file.
  rmSync(path.join(rootDir, "packages/cli/src/index.ts"));
  assert.ok(!listWorktreeFiles(rootDir, ["packages"]).includes("packages/cli/src/index.ts"));
});

test("listWorktreeFiles skips symlinks the way Dirent-based walkers did", () => {
  const { rootDir } = makeRepo({ "real.ts": "export {};\n" });
  symlinkSync("real.ts", path.join(rootDir, "linked.ts"));

  const files = listWorktreeFiles(rootDir);
  assert.ok(files.includes("real.ts"));
  assert.ok(!files.includes("linked.ts"));
});
