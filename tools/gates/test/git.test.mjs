// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { changedFiles, git } from "../git.mjs";
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
