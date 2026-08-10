// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalCommitContaining } from "../src/runtime/canonical-commit-ancestry.ts";
import { removeTemporaryTestRoot } from "../../../tools/test-temp-root-cleanup.mjs";

test("canonical ancestry resolves the first merge containing an accepted session commit", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "canonical-commit-containing-"));
  context.after(async () => await removeTemporaryTestRoot(root));
  git(root, "init", "-q", "-b", "master");
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(root, "add", "--", "seed.txt");
  git(root, "commit", "-q", "-m", "seed");

  git(root, "checkout", "-q", "-b", "sessions/shared");
  writeFileSync(path.join(root, "first.txt"), "first\n");
  git(root, "add", "--", "first.txt");
  git(root, "commit", "-q", "-m", "first accepted operation");
  const acceptedCommit = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "master");
  git(root, "merge", "-q", "--no-ff", "sessions/shared", "-m", "materializer: merge session shared");
  const containingMerge = git(root, "rev-parse", "HEAD");
  git(root, "branch", "-D", "sessions/shared");

  git(root, "checkout", "-q", "-b", "sessions/shared");
  writeFileSync(path.join(root, "second.txt"), "second\n");
  git(root, "add", "--", "second.txt");
  git(root, "commit", "-q", "-m", "second accepted operation");
  git(root, "checkout", "-q", "master");
  git(root, "merge", "-q", "--no-ff", "sessions/shared", "-m", "materializer: merge session shared");
  const laterHead = git(root, "rev-parse", "HEAD");

  assert.notEqual(laterHead, containingMerge);
  assert.equal(canonicalCommitContaining(root, acceptedCommit), containingMerge);
});

function git(root: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", [
    "-C", root,
    "-c", "user.name=Harness Test",
    "-c", "user.email=harness@example.test",
    "-c", "commit.gpgSign=false",
    ...args
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  }).trim();
}
