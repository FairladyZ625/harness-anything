import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const checkerPath = path.join(repoRoot, "tools/check-private-boundary.mjs");

test("private boundary check passes when private roots are ignored and untracked", () => {
  withBoundaryRepo((root) => {
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Private boundary check passed/u);
  });
});

test("private boundary check rejects tracked harness roots", () => {
  withBoundaryRepo((root) => {
    mkdirSync(path.join(root, "harness"), { recursive: true });
    writeFileSync(path.join(root, "harness/leak.md"), "private ledger\n", "utf8");
    git(root, "add", "-f", "harness/leak.md");
    git(root, "commit", "-m", "track harness leak");

    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /private path tracked in public repo: harness\/leak\.md/u);
  });
});

test("private boundary check rejects outer session branches", () => {
  withBoundaryRepo((root) => {
    git(root, "branch", "sessions/leak");

    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /forbidden session branch in public repo: sessions\/leak/u);
  });
});

function withBoundaryRepo(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-private-boundary-"));
  try {
    git(root, "init");
    writeFileSync(path.join(root, ".gitignore"), [
      "/.harness-private/",
      "/harness/",
      "/.harness/",
      ""
    ].join("\n"), "utf8");
    git(root, "add", ".gitignore");
    git(root, "commit", "-m", "seed boundary ignores");
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runChecker(root) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd: root,
    encoding: "utf8"
  });
}

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Harness Test",
      GIT_AUTHOR_EMAIL: "harness-test@example.invalid",
      GIT_COMMITTER_NAME: "Harness Test",
      GIT_COMMITTER_EMAIL: "harness-test@example.invalid"
    },
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
