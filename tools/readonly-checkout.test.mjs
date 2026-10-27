// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { extractTree, materialize, resolveRevision, showPath } from "./readonly-checkout.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}:\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function git(cwd, ...args) {
  return run("git", args, { cwd, env: { ...process.env, HARNESS_TASK_BOUND: "" } });
}

/** A repository shaped like this one: npm workspaces whose store links each package relatively. */
function workspaceFixture(context) {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-readonly-checkout-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, "canonical"),
    names = ["application", "cli", "daemon"];
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", private: true, workspaces: ["packages/*"] }),
  );
  for (const name of names) {
    mkdirSync(path.join(root, "packages", name), { recursive: true });
    writeFileSync(path.join(root, "packages", name, "package.json"), JSON.stringify({ name: `@fixture/${name}` }));
  }
  // The store entry by entry: a relative workspace link plus one external entry, exactly as npm hoists them.
  mkdirSync(path.join(root, "node_modules", "@fixture"), { recursive: true });
  mkdirSync(path.join(root, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  for (const name of names)
    symlinkSync(`../../packages/${name}`, path.join(root, "node_modules", "@fixture", name), "junction");
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.com");
  git(root, "config", "user.name", "fixture");
  writeFileSync(path.join(root, ".gitignore"), "node_modules\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "workspace fixture");
  return { parent, root, names, commit: git(root, "rev-parse", "HEAD") };
}

function workspaceLinkTargets(root, names) {
  return names.map((name) => readlinkSync(path.join(root, "node_modules", "@fixture", name)));
}

test("a revision that names no commit is refused instead of resolving to something else", () => {
  const fixture = workspaceFixture({ after: () => {} });
  try {
    assert.equal(resolveRevision(fixture.root, "no-such-revision").ok, false);
    assert.equal(resolveRevision(fixture.root, fixture.commit).commit, fixture.commit);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("the extraction is a plain tree: no worktree registration, no node_modules, no .git", () => {
  const fixture = workspaceFixture({ after: () => {} });
  try {
    const out = path.join(fixture.parent, "baseline"),
      registered = git(fixture.root, "worktree", "list", "--porcelain").split("\n").filter(Boolean).length,
      result = materialize({ rootDir: fixture.root, revision: fixture.commit, out, deps: false });
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.dependencies, false);
    assert.equal(existsSync(path.join(out, "packages", "daemon", "package.json")), true, "the tree is materialized");
    assert.equal(existsSync(path.join(out, ".git")), false, "an extracted archive registers no Git state");
    assert.equal(existsSync(path.join(out, "node_modules")), false, "the default reads no shared store");
    assert.equal(
      git(fixture.root, "worktree", "list", "--porcelain").split("\n").filter(Boolean).length,
      registered,
      "no worktree is registered on the shared repository",
    );
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("--deps copies workspace links relative so they resolve inside the new tree", () => {
  const fixture = workspaceFixture({ after: () => {} });
  try {
    const out = path.join(fixture.parent, "baseline"),
      before = workspaceLinkTargets(fixture.root, fixture.names),
      result = materialize({ rootDir: fixture.root, revision: fixture.commit, out, deps: true });
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.dependencies, true);
    for (const name of fixture.names) {
      assert.equal(
        readlinkSync(path.join(out, "node_modules", "@fixture", name)),
        `../../packages/${name}`,
        `${name} keeps a relative link`,
      );
      // The link resolves to the extraction's own copy, which is the whole point of copying it.
      assert.equal(
        realpathSync(path.join(out, "node_modules", "@fixture", name, "package.json")),
        realpathSync(path.join(out, "packages", name, "package.json")),
      );
    }
    assert.equal(
      readlinkSync(path.join(out, "node_modules", "left-pad")),
      path.join(fixture.root, "node_modules", "left-pad"),
    );
    assert.deepEqual(workspaceLinkTargets(fixture.root, fixture.names), before, "the shared store is unchanged");
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("re-pointing a mirrored workspace link writes inside the checkout, never into the shared store", () => {
  const fixture = workspaceFixture({ after: () => {} });
  try {
    const out = path.join(fixture.parent, "baseline"),
      before = workspaceLinkTargets(fixture.root, fixture.names),
      result = materialize({ rootDir: fixture.root, revision: fixture.commit, out, deps: true });
    assert.equal(result.ok, true, result.detail);
    // The incident's own action: replace a workspace link so it points at "my own" packages directory.
    rmSync(path.join(out, "node_modules", "@fixture", "daemon"));
    symlinkSync(path.join(out, "packages", "cli"), path.join(out, "node_modules", "@fixture", "daemon"), "junction");
    assert.deepEqual(
      workspaceLinkTargets(fixture.root, fixture.names),
      before,
      "the shared store's workspace links still resolve where they did",
    );
    assert.equal(readlinkSync(path.join(out, "node_modules", "@fixture", "daemon")), path.join(out, "packages", "cli"));
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("the writing path this replaces shares the directory, so the same action rewrites the shared store", () => {
  const fixture = workspaceFixture({ after: () => {} });
  try {
    const scopeLink = path.join(fixture.parent, "scope"),
      before = workspaceLinkTargets(fixture.root, fixture.names);
    // The negative control for the incident: one link to the store's scope directory, then a link replaced
    // through it. Its parent resolves to the shared directory, so the write lands there.
    symlinkSync(path.join(fixture.root, "node_modules", "@fixture"), scopeLink, "junction");
    // `ln -sfn` replaces the entry: it unlinks the old link, then creates the new one. Both steps resolve the
    // parent through scopeLink, so both land in the shared store.
    rmSync(path.join(scopeLink, "daemon"));
    symlinkSync(path.join(fixture.parent, "elsewhere"), path.join(scopeLink, "daemon"), "junction");
    assert.notDeepEqual(
      workspaceLinkTargets(fixture.root, fixture.names),
      before,
      "the defect is real: sharing the directory lets a write reach the shared store",
    );
    assert.equal(
      readlinkSync(path.join(fixture.root, "node_modules", "@fixture", "daemon")),
      path.join(fixture.parent, "elsewhere"),
    );
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("--show reads one path at the commit without materializing a tree", () => {
  const fixture = workspaceFixture({ after: () => {} });
  try {
    const read = showPath(fixture.root, fixture.commit, "packages/cli/package.json");
    assert.equal(read.ok, true, read.detail);
    assert.match(read.body, /@fixture\/cli/u);
    assert.equal(showPath(fixture.root, fixture.commit, "packages/absent/package.json").ok, false);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("a commit outside the repository is refused rather than extracted from somewhere else", () => {
  const fixture = workspaceFixture({ after: () => {} });
  try {
    const out = path.join(fixture.parent, "not-a-repo"),
      result = extractTree(path.join(fixture.parent, "missing"), fixture.commit, out);
    assert.equal(result.ok, false);
    assert.match(result.detail, /git archive .* failed/u);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("this repository materializes its own HEAD with no shared state read", () => {
  const head = run("git", ["rev-parse", "HEAD"], { cwd: repoRoot }),
    storeBefore = existsSync(path.join(repoRoot, "node_modules")),
    out = mkdtempSync(path.join(tmpdir(), "ha-readonly-checkout-head-"));
  try {
    const result = materialize({ rootDir: repoRoot, revision: head, out, deps: false });
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.commit, head);
    assert.equal(lstatSync(out).isDirectory(), true);
    // A path that exists at every commit, so the assertion measures extraction rather than the working tree.
    assert.equal(existsSync(path.join(out, "packages", "kernel", "package.json")), true);
    assert.equal(existsSync(path.join(out, "node_modules")), false);
    assert.equal(existsSync(path.join(repoRoot, "node_modules")), storeBefore);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
