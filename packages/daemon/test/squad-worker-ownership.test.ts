// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkWorkerOwnership, overlappingWorkerPaths, parseWorkerOwnedPaths } from "../src/squad-worker-ownership.ts";

test("ownership declarations retain canonical files and directories and remove exact duplicates", () => {
  assert.deepEqual(parseWorkerOwnedPaths(["src/", "README.md", "src/", "docs/设计.md"]), [
    "src/",
    "README.md",
    "docs/设计.md",
  ]);
  assert.deepEqual(parseWorkerOwnedPaths([]), []);
});

test("ownership declarations reject non-finite or non-canonical path expressions", () => {
  for (const value of [undefined, null, "src/", [12], [null]]) assert.throws(() => parseWorkerOwnedPaths(value));
  for (const entry of [
    "",
    "/",
    "/src",
    "C:/src",
    "C:src",
    "\\\\server\\share",
    "../src",
    "src/../docs",
    "./src",
    "src//child",
    "src//",
    "src\\child",
    "src/*",
    "src/**",
    "src/?.ts",
    "src/[ab].ts",
    "src/{a,b}.ts",
    "src/\0bad",
    "src/e\u0301.ts",
  ])
    assert.throws(() => parseWorkerOwnedPaths([entry]), entry);
});

test("ownership overlap respects directory boundaries and folds cross-platform aliases", () => {
  for (const [left, right] of [
    ["src/", "src/a.ts"],
    ["src/", "src/nested/"],
    ["src", "src/"],
    ["SRC", "src/"],
    ["src/A.ts", "SRC/a.ts"],
    ["SRC/", "src/nested/"],
  ]) {
    assert.ok(overlappingWorkerPaths([left], [right]), `${left} overlaps ${right}`);
    assert.ok(overlappingWorkerPaths([right], [left]), `${right} overlaps ${left}`);
  }
  for (const [left, right] of [
    ["src/", "src-other/a.ts"],
    ["src/", "src-other/"],
    ["src/a.ts", "src/a.ts.bak"],
    ["src/a.ts", "src/b.ts"],
  ])
    assert.equal(overlappingWorkerPaths([left], [right]), null, `${left} is separate from ${right}`);
  assert.equal(overlappingWorkerPaths([], ["src/"]), null);
});

test("a repository without remotes retains the original ownership behavior", async (context) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "ha-squad-ownership-"));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Ownership Test");
  git(cwd, "config", "user.email", "ownership@example.invalid");
  for (const directory of ["src", "outside"]) mkdirSync(path.join(cwd, directory));
  writeFileSync(path.join(cwd, "src", "move.txt"), "rename payload\n");
  writeFileSync(path.join(cwd, "outside", "delete.txt"), "delete payload\n");
  writeFileSync(path.join(cwd, "outside", "stay.txt"), "untouched\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "test: baseline");
  const baseSha = git(cwd, "rev-parse", "HEAD").trim();
  renameSync(path.join(cwd, "src", "move.txt"), path.join(cwd, "outside", "moved.txt"));
  git(cwd, "rm", "--quiet", "outside/delete.txt");
  writeFileSync(path.join(cwd, "src", "new file.txt"), "inside\n");
  writeFileSync(path.join(cwd, "outside", "new file.txt"), "outside\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "test: worker delivery");
  const headSha = git(cwd, "rev-parse", "HEAD").trim(),
    checkout = { cwd, branch: git(cwd, "branch", "--show-current").trim(), baseSha },
    finding = await checkWorkerOwnership(checkout, ["SRC/"]);
  assert.deepEqual(finding, {
    baseSha,
    deliveryBaseSha: baseSha,
    headSha,
    changedPaths: [
      "outside/delete.txt",
      "outside/moved.txt",
      "outside/new file.txt",
      "src/move.txt",
      "src/new file.txt",
    ],
    outsidePaths: ["outside/delete.txt", "outside/moved.txt", "outside/new file.txt"],
  });
  assert.equal(git(cwd, "rev-parse", "HEAD").trim(), headSha);
  assert.equal(git(cwd, "status", "--porcelain"), "");
  assert.equal(readFileSync(path.join(cwd, "outside", "moved.txt"), "utf8"), "rename payload\n");
  const allOwned = await checkWorkerOwnership(checkout, ["src/", "outside/"]);
  assert.deepEqual(allOwned.outsidePaths, []);
  const unowned = await checkWorkerOwnership(checkout, []);
  assert.deepEqual(unowned.outsidePaths, unowned.changedPaths);
});

test("a worker without a rebase retains the original ownership behavior", async (context) => {
  const cwd = ownershipRepository(context),
    baseSha = git(cwd, "rev-parse", "HEAD").trim();
  git(cwd, "update-ref", "refs/remotes/origin/main", baseSha);
  writeFileSync(path.join(cwd, "src", "inside.txt"), "inside\n");
  writeFileSync(path.join(cwd, "outside", "worker.txt"), "outside\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "test: worker delivery");
  const finding = await checkWorkerOwnership({ cwd, branch: "worker", baseSha }, ["src/"]);
  assert.equal(finding.deliveryBaseSha, baseSha);
  assert.deepEqual(finding.changedPaths, ["outside/worker.txt", "src/inside.txt"]);
  assert.deepEqual(finding.outsidePaths, ["outside/worker.txt"]);
});

test("ownership ignores fetched upstream commits after a worker rebase", async (context) => {
  const cwd = ownershipRepository(context);
  writeFileSync(path.join(cwd, "outside", "upstream.txt"), "upstream\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "test: upstream delivery");
  const deliveryBaseSha = git(cwd, "rev-parse", "HEAD").trim();
  git(cwd, "update-ref", "refs/remotes/origin/main", deliveryBaseSha);
  writeFileSync(path.join(cwd, "src", "worker.txt"), "worker\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "test: worker delivery");
  const headSha = git(cwd, "rev-parse", "HEAD").trim(),
    finding = await checkWorkerOwnership({ cwd, branch: "worker", baseSha: git(cwd, "rev-parse", "HEAD~2").trim() }, [
      "src/",
    ]);
  assert.equal(finding.headSha, headSha);
  assert.equal(finding.deliveryBaseSha, deliveryBaseSha);
  assert.deepEqual(finding.changedPaths, ["src/worker.txt"]);
  assert.deepEqual(finding.outsidePaths, []);
});

test("ownership still reports a worker commit outside its declaration after a rebase", async (context) => {
  const cwd = ownershipRepository(context);
  writeFileSync(path.join(cwd, "outside", "upstream.txt"), "upstream\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "test: upstream delivery");
  git(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(path.join(cwd, "outside", "worker.txt"), "worker\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "test: worker delivery");
  const finding = await checkWorkerOwnership(
    { cwd, branch: "worker", baseSha: git(cwd, "rev-parse", "HEAD~2").trim() },
    ["src/"],
  );
  assert.deepEqual(finding.changedPaths, ["outside/worker.txt"]);
  assert.deepEqual(finding.outsidePaths, ["outside/worker.txt"]);
});

test("a remote-tracking worker branch cannot hide its own outside path", async (context) => {
  const cwd = ownershipRepository(context),
    baseSha = git(cwd, "rev-parse", "HEAD").trim();
  writeFileSync(path.join(cwd, "outside", "worker.txt"), "worker\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "test: worker delivery");
  git(cwd, "update-ref", "refs/remotes/origin/worker", "HEAD");
  const finding = await checkWorkerOwnership({ cwd, branch: "worker", baseSha }, ["src/"]);
  assert.deepEqual(finding.outsidePaths, ["outside/worker.txt"]);
});

test("ownership ignores fetched upstream commits merged into the worker branch", async (context) => {
  const cwd = ownershipRepository(context),
    baseSha = git(cwd, "rev-parse", "HEAD").trim();
  git(cwd, "checkout", "-qb", "worker");
  writeFileSync(path.join(cwd, "src", "worker.txt"), "worker\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "test: worker delivery");
  git(cwd, "checkout", "-qb", "upstream", baseSha);
  writeFileSync(path.join(cwd, "outside", "upstream.txt"), "upstream\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "test: upstream delivery");
  git(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(cwd, "checkout", "-q", "worker");
  git(cwd, "merge", "--no-edit", "upstream");
  const finding = await checkWorkerOwnership({ cwd, branch: "worker", baseSha }, ["src/"]);
  assert.deepEqual(finding.changedPaths, ["src/worker.txt"]);
  assert.deepEqual(finding.outsidePaths, []);
});

function ownershipRepository(context: test.TestContext): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "ha-squad-ownership-"));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Ownership Test");
  git(cwd, "config", "user.email", "ownership@example.invalid");
  mkdirSync(path.join(cwd, "src"));
  mkdirSync(path.join(cwd, "outside"));
  writeFileSync(path.join(cwd, "README.md"), "baseline\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "test: baseline");
  return cwd;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
