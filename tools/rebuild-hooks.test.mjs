// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

for (const changed of ["cli", "daemon", "kernel"]) {
  test(
    `Git checkout, commit and fast-forward preserve dist after ${changed} changes`,
    { skip: posixShellSkip },
    (t) => {
      const root = makeRebuildRepo(t, "rebuild-explicit-");
      const base = commitAll(root, "base");
      git(root, "checkout", "-b", "update");
      writeFileSync(path.join(root, `packages/${changed}/src/main.ts`), "v2\n");
      git(root, "add", "packages");
      git(root, "commit", "-q", "-m", "source change");
      git(root, "checkout", "-b", "main-fixture", base);
      git(root, "merge", "--ff-only", "update");
      assert.deepEqual(readNpmLog(root), [], "Git synchronization must not replace the resident build");
      // Replacement stays an explicit operation, independent of repository synchronization.
      execFileSync(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["run", "build", "-w", "@harness-anything/daemon"],
        {
          cwd: root,
          stdio: "pipe",
          shell: process.platform === "win32",
        },
      );
      assert.deepEqual(readNpmLog(root), ["@harness-anything/daemon"]);
    },
  );
}

// Real Git operations use copied repository hooks and builds record their workspace.
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

  const hooks = path.join(root, "tools/git-hooks");
  mkdirSync(hooks, { recursive: true });
  for (const name of ["post-checkout", "post-commit", "post-merge", "lib.sh"]) {
    const source = path.join(repositoryRoot, "tools/git-hooks", name);
    if (existsSync(source)) {
      copyFileSync(source, path.join(hooks, name));
      chmodSync(path.join(hooks, name), 0o755);
    }
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
