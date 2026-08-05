// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hookPath = fileURLToPath(new URL("./pre-commit", import.meta.url));
const claEmail = "33339424+FairladyZ625@users.noreply.github.com";

// The hook only earns trust if it is shown to speak as well as to stay silent,
// so both directions are asserted: the accepting case and the rejecting one.

test("pre-commit accepts the CLA-signing author", () => {
  withRepo((root) => {
    setIdentity(root, "ZeyuLi", claEmail);
    assert.equal(runHook(root).status, 0);
  });
});

test("pre-commit rejects an author the CLA assistant does not accept", () => {
  withRepo((root) => {
    setIdentity(root, "Codex", "codex@openai.com");
    const result = runHook(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing to create a commit authored by <codex@openai\.com>/u);
    assert.match(result.stderr, new RegExp(claEmail.replace(/[.+]/gu, "\\$&"), "u"));
  });
});

// This is the case that actually happened: the repository identity is correct
// and a command-line override defeats it. A hook that read `git config`
// instead of `git var` would pass here and catch nothing.
test("pre-commit sees through a command-line identity override", () => {
  withRepo((root) => {
    setIdentity(root, "ZeyuLi", claEmail);
    const result = runHook(root, {
      GIT_AUTHOR_NAME: "Codex",
      GIT_AUTHOR_EMAIL: "codex@openai.com"
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /codex@openai\.com/u);
  });
});

function withRepo(body) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-pre-commit-hook-"));
  try {
    run("git", ["init", "-q"], root);
    writeFileSync(path.join(root, "README.md"), "one\n", "utf8");
    run("git", ["add", "README.md"], root);
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function setIdentity(root, name, email) {
  run("git", ["config", "user.name", name], root);
  run("git", ["config", "user.email", email], root);
}

function runHook(root, extraEnv = {}) {
  const result = execFileSync("sh", ["-c", `"${hookPath}" 2>&1; echo "EXIT:$?"`], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8"
  });
  const marker = result.lastIndexOf("EXIT:");
  return { status: Number(result.slice(marker + 5).trim()), stderr: result.slice(0, marker) };
}

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
