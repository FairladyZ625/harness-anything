// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const gitShell = process.platform === "win32" ? findGitShell() : "sh";
const posixShellSkip =
  process.platform === "win32" && gitShell === null
    ? "requires Git for Windows' POSIX shell to execute repository hooks"
    : false;

test("rebuild hooks rebuild only the daemon when daemon-side sources change", { skip: posixShellSkip }, (context) => {
  const root = makeRebuildRepo(context, "rebuild-daemon-");
  commitAll(root, "base");
  writeFileSync(path.join(root, "packages/kernel/src/main.ts"), "kernel v2\n");
  const kernelChange = commitAll(root, "kernel change");
  const base = git(root, "rev-parse", "HEAD~1").trim();
  writeFileSync(path.join(root, "npm.log"), "");

  const result = runHookScript(path.join(root, "tools/git-hooks/post-checkout"), [base, kernelChange, "1"], root);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rebuilding @harness-anything\/daemon/u);
  assert.doesNotMatch(result.stdout, /rebuilding @harness-anything\/cli/u);
  assert.deepEqual(readNpmLog(root), ["@harness-anything/daemon"]);
});

test("rebuild hooks rebuild only the CLI when CLI-only sources change", { skip: posixShellSkip }, (context) => {
  const root = makeRebuildRepo(context, "rebuild-cli-");
  commitAll(root, "base");
  writeFileSync(path.join(root, "packages/cli/src/main.ts"), "cli v2\n");
  const cliChange = commitAll(root, "cli change");
  const base = git(root, "rev-parse", "HEAD~1").trim();
  writeFileSync(path.join(root, "npm.log"), "");

  const checkout = runHookScript(path.join(root, "tools/git-hooks/post-checkout"), [base, cliChange, "1"], root);
  assert.equal(checkout.status, 0, checkout.stderr);
  assert.match(checkout.stdout, /rebuilding @harness-anything\/cli/u);
  assert.doesNotMatch(checkout.stdout, /rebuilding @harness-anything\/daemon/u);

  const commit = runHookScript(path.join(root, "tools/git-hooks/post-commit"), [], root);
  assert.equal(commit.status, 0, commit.stderr);
  assert.match(commit.stdout, /rebuilding @harness-anything\/cli/u);

  assert.deepEqual(readNpmLog(root), ["@harness-anything/cli", "@harness-anything/cli"]);
});

test("rebuild hooks skip builds when nothing they watch changed", { skip: posixShellSkip }, (context) => {
  const root = makeRebuildRepo(context, "rebuild-skip-");
  const base = commitAll(root, "base");
  writeFileSync(path.join(root, "tools/note.md"), "inert\n");
  const inert = commitAll(root, "inert change");
  writeFileSync(path.join(root, "npm.log"), "");

  const checkout = runHookScript(path.join(root, "tools/git-hooks/post-checkout"), [base, inert, "1"], root);
  assert.equal(checkout.status, 0, checkout.stderr);
  assert.match(checkout.stdout, /no CLI or daemon source changes; skipping builds/u);

  const commit = runHookScript(path.join(root, "tools/git-hooks/post-commit"), [], root);
  assert.equal(commit.status, 0, commit.stderr);
  assert.match(commit.stdout, /no CLI or daemon source changes; skipping builds/u);

  git(root, "update-ref", "ORIG_HEAD", base);
  const merge = runHookScript(path.join(root, "tools/git-hooks/post-merge"), [], root);
  assert.equal(merge.status, 0, merge.stderr);
  assert.match(merge.stdout, /skipping builds/u);
  assert.deepEqual(readNpmLog(root), []);
});

test(
  "post-merge rebuilds the daemon (and GUI) after a daemon-side fast-forward",
  { skip: posixShellSkip },
  (context) => {
    const root = makeRebuildRepo(context, "rebuild-merge-");
    const base = commitAll(root, "base");
    writeFileSync(path.join(root, "packages/daemon/src/main.ts"), "daemon v2\n");
    commitAll(root, "daemon change");
    writeFileSync(path.join(root, "npm.log"), "");

    git(root, "update-ref", "ORIG_HEAD", base);
    const result = runHookScript(path.join(root, "tools/git-hooks/post-merge"), [], root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /rebuilding @harness-anything\/daemon/u);
    assert.doesNotMatch(result.stdout, /rebuilding @harness-anything\/cli/u);
    // packages/daemon/src is also on post-merge's explicit GUI trigger list.
    assert.match(result.stdout, /rebuilding @harness-anything\/gui/u);
    assert.deepEqual(readNpmLog(root), ["@harness-anything/daemon", "@harness-anything/gui"]);
  },
);

test("rebuild hooks work inside a worktree without its own node_modules", { skip: posixShellSkip }, (context) => {
  const root = makeRebuildRepo(context, "rebuild-worktree-");
  const base = commitAll(root, "base");

  const worktreeRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rebuild-worktree-wt-")));
  context.after(() => rmSync(worktreeRoot, { recursive: true, force: true }));
  const worktreeAdd = spawnSync("git", ["-C", root, "worktree", "add", worktreeRoot, "-b", "linked"], {
    encoding: "utf8",
  });
  assert.equal(worktreeAdd.status, 0, worktreeAdd.stderr);
  // worktree add performs a checkout too (unborn prev ref): its conservative
  // rebuild is not what this test asserts.
  writeFileSync(path.join(worktreeRoot, "npm.log"), "");

  // The linked worktree shares the repository but has no node_modules of its
  // own; the hooks must still resolve tsc from the main checkout.
  assert.equal(existsSync(path.join(worktreeRoot, "node_modules")), false);

  writeFileSync(path.join(worktreeRoot, "packages/daemon/src/main.ts"), "daemon v2\n");
  git(worktreeRoot, "add", "packages", "tools");
  const commit = spawnSync("git", ["-C", worktreeRoot, "commit", "-q", "-m", "daemon change"], { encoding: "utf8" });
  assert.equal(commit.status, 0, commit.stderr);
  assert.deepEqual(readNpmLog(worktreeRoot), ["@harness-anything/daemon"]);

  const checkoutBack = spawnSync("git", ["-C", worktreeRoot, "checkout", "-q", "-b", "back", base], {
    encoding: "utf8",
  });
  assert.equal(checkoutBack.status, 0, checkoutBack.stderr);
  writeFileSync(path.join(worktreeRoot, "npm.log"), "");

  const checkoutLinked = spawnSync("git", ["-C", worktreeRoot, "checkout", "linked"], { encoding: "utf8" });
  assert.equal(checkoutLinked.status, 0, checkoutLinked.stderr);
  // git routes hook output to stderr, so check both streams.
  const output = checkoutLinked.stdout + checkoutLinked.stderr;
  assert.doesNotMatch(output, /No such file or directory/u);
  assert.match(output, /rebuilding @harness-anything\/daemon/u);
  assert.deepEqual(readNpmLog(worktreeRoot), ["@harness-anything/daemon"]);
});

// Fixture repository shaped like the minimum the rebuild hooks observe: real
// npm workspaces whose build scripts record themselves, and a tsc stub in the
// main checkout's node_modules exactly where lib.sh resolves it. The stub
// build programs intentionally split cli from daemon+kernel so the two trigger
// derivations can be asserted independently.
function makeRebuildRepo(context, prefix) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.email", "hook-test@example.invalid");
  git(root, "config", "user.name", "Hook Test");

  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      { name: "rebuild-hooks-fixture", private: true, workspaces: ["packages/cli", "packages/daemon", "packages/gui"] },
      null,
      2,
    ),
  );
  for (const [workspace, script] of [
    ["packages/cli", "node ../../tools/record-build.mjs @harness-anything/cli"],
    ["packages/daemon", "node ../../tools/record-build.mjs @harness-anything/daemon"],
    ["packages/gui", "node ../../tools/record-build.mjs @harness-anything/gui"],
  ]) {
    mkdirSync(path.join(root, workspace), { recursive: true });
    writeFileSync(
      path.join(root, workspace, "package.json"),
      JSON.stringify(
        { name: `@harness-anything/${path.basename(workspace)}`, private: true, scripts: { build: script } },
        null,
        2,
      ),
    );
    writeFileSync(
      path.join(root, workspace, "tsconfig.build.json"),
      JSON.stringify({ include: ["src/**/*.ts"] }, null, 2),
    );
  }
  for (const source of ["packages/cli/src/main.ts", "packages/daemon/src/main.ts", "packages/kernel/src/main.ts"]) {
    mkdirSync(path.dirname(path.join(root, source)), { recursive: true });
    writeFileSync(path.join(root, source), "v1\n");
  }

  mkdirSync(path.join(root, "node_modules/.bin"), { recursive: true });
  writeFileSync(
    path.join(root, "node_modules/.bin/tsc"),
    [
      "#!/bin/sh",
      "root=$(pwd -P)",
      'case "${2-}" in',
      "  packages/cli/tsconfig.build.json)",
      "    printf '%s\\n' \"$root/packages/cli/src/main.ts\"",
      "    ;;",
      "  packages/daemon/tsconfig.build.json)",
      '    printf \'%s\\n\' "$root/packages/daemon/src/main.ts" "$root/packages/kernel/src/main.ts"',
      "    ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(path.join(root, "node_modules/.bin/tsc"), 0o755);

  const hooks = path.join(root, "tools/git-hooks");
  mkdirSync(hooks, { recursive: true });
  for (const name of ["post-checkout", "post-commit", "post-merge", "lib.sh"]) {
    copyFileSync(path.join(repositoryRoot, "tools/git-hooks", name), path.join(hooks, name));
    chmodSync(path.join(hooks, name), 0o755);
  }
  writeFileSync(
    path.join(root, "tools/record-build.mjs"),
    [
      'import { appendFileSync } from "node:fs";',
      'appendFileSync(new URL("../npm.log", import.meta.url), `${process.argv[2]}\\n`);',
      "",
    ].join("\n"),
  );
  // Setup commits silence hooks so incidental rebuilds do not pay npm startup
  // on every fixture; the tests under assertion fire hooks explicitly.
  mkdirSync(path.join(root, "no-hooks"));
  // The real repository points core.hooksPath at the main checkout with an
  // absolute path, so linked worktrees fire the main checkout's hooks too.
  git(root, "config", "core.hooksPath", path.join(root, "tools/git-hooks"));
  return root;
}

function readNpmLog(root) {
  const log = path.join(root, "npm.log");
  return existsSync(log) ? readFileSync(log, "utf8").split(/\r?\n/u).filter(Boolean) : [];
}

function commitAll(root, message) {
  git(root, "add", "package.json", "packages", "tools");
  git(root, "-c", `core.hooksPath=${path.join(root, "no-hooks")}`, "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD").trim();
}

function runHookScript(script, args, root) {
  return spawnSync(
    process.platform === "win32" ? gitShell : script,
    process.platform === "win32" ? [script, ...args] : args,
    { cwd: root, encoding: "utf8" },
  );
}

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function findGitShell() {
  const result = execFileSync("where.exe", ["git.exe"], { encoding: "utf8" });
  for (const gitPath of result
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean)) {
    const root = path.resolve(path.dirname(gitPath), "..");
    for (const candidate of [path.join(root, "bin", "sh.exe"), path.join(root, "usr", "bin", "sh.exe")]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
