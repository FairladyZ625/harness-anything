// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { observeDeliveryBaseline } from "../src/repo-cell-proof.ts";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
function init(root: string) {
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "commit.gpgsign", "false");
}
function commitAll(root: string) {
  git(root, "add", "-A");
  git(root, "commit", "-qm", "cut");
  return git(root, "rev-parse", "HEAD");
}

test("a repository with commits freezes HEAD as the baseline", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-baseline-head-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  init(root);
  writeFileSync(path.join(root, "a.txt"), "a\n");
  const head = commitAll(root);
  assert.deepEqual(observeDeliveryBaseline(root), { kind: "commit", commitSha: head });
});

test("an unborn repository freezes the empty tree without committing user files", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-baseline-unborn-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  init(root);
  writeFileSync(path.join(root, "untracked.txt"), "user work\n");
  assert.deepEqual(observeDeliveryBaseline(root), { kind: "empty-tree" });
  assert.throws(() => git(root, "rev-parse", "--verify", "HEAD"), /single revision|ambiguous argument/iu);
});

test("a nested path inside a parent repository uses the parent's HEAD", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-baseline-parent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  init(root);
  writeFileSync(path.join(root, "a.txt"), "a\n");
  const head = commitAll(root),
    nested = path.join(root, "sub", "dir");
  execFileSync("mkdir", ["-p", nested]);
  assert.deepEqual(observeDeliveryBaseline(nested), { kind: "commit", commitSha: head });
});

test("a repository with history but no readable HEAD fails closed", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-baseline-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  init(root);
  writeFileSync(path.join(root, "a.txt"), "a\n");
  commitAll(root);
  // Detach into an unborn state while a commit still lives on another ref.
  git(root, "checkout", "-q", "--orphan", "unborn-head");
  assert.throws(() => observeDeliveryBaseline(root), /no readable HEAD baseline/u);
});

test("a path outside any repository fails closed", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-baseline-none-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => observeDeliveryBaseline(root), /project Git repository/u);
});
