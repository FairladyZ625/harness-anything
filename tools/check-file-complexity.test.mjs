// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const checker = path.resolve(import.meta.dirname, "check-file-complexity.mjs");
const MAX_LINES = 2000;

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "file-complexity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  const write = (file, lines, ending = "\n") => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), Array.from({ length: lines }, () => "// fixture").join(ending));
  };
  const commit = () => {
    git("add", ".");
    git("-c", "core.hooksPath=", "commit", "--quiet", "--allow-empty", "-m", "test: fixture");
  };
  const check = (expected, pattern) => {
    const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, expected, output);
    if (pattern) assert.match(output, pattern);
  };
  return { root, git, write, commit, check };
}

for (const file of [
  "packages/demo/src/file.ts",
  "packages/demo/test/file.ts",
  "packages/demo/src/file.test.ts",
  "tools/example.mjs",
]) {
  test(`${file} passes at 2000 lines and fails at 2001 (single ceiling)`, (t) => {
    const f = fixture(t);
    f.write(file, MAX_LINES - 1);
    f.check(0);
    f.write(file, MAX_LINES);
    f.check(0);
    f.write(file, MAX_LINES + 1);
    f.check(1, new RegExp(`${MAX_LINES + 1} lines exceeds max ${MAX_LINES};`));
  });
}

test("files present at the merge base get no historical allowance", (t) => {
  const f = fixture(t);
  f.write("packages/demo/src/existing.ts", MAX_LINES);
  f.write("packages/demo/test/existing.test.ts", MAX_LINES);
  f.commit();
  f.check(0);
  f.write("packages/demo/src/existing.ts", MAX_LINES + 1);
  f.write("packages/demo/test/existing.test.ts", MAX_LINES + 1);
  f.check(1, /existing\.ts: 2001 lines exceeds max 2000;/);
  f.check(1, /existing\.test\.ts: 2001 lines exceeds max 2000;/);
});

test("committed additions are scanned like untracked additions", (t) => {
  const f = fixture(t);
  f.write("packages/demo/src/fresh.ts", MAX_LINES + 1);
  f.check(1, /fresh\.ts: 2001 lines exceeds max 2000;/);
  f.commit();
  f.check(1, /fresh\.ts: 2001 lines exceeds max 2000;/);
});

test("the checker no longer needs an origin/main base ref", (t) => {
  const f = fixture(t);
  const remoteRefs = f.git("for-each-ref", "--format=%(refname)", "refs/remotes");
  assert.equal(remoteRefs, "", "fixture must have no remote-tracking refs");
  f.write("packages/demo/src/file.ts", MAX_LINES);
  f.check(0);
  f.write("packages/demo/src/file.ts", MAX_LINES + 1);
  f.check(1, /file\.ts: 2001 lines exceeds max 2000;/);
});

test("retains empty, CRLF, trailing newline and excluded-directory counting behavior", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, ".gitignore"), "dist/\n");
  f.write("packages/demo/src/empty.ts", 0);
  f.write("packages/demo/src/file.ts", MAX_LINES, "\r\n");
  f.write("packages/demo/dist/generated.ts", MAX_LINES + 1);
  f.write("packages/demo/src/types.d.ts", MAX_LINES + 1);
  f.check(0);
  const file = path.join(f.root, "packages/demo/src/file.ts");
  writeFileSync(file, readFileSync(file, "utf8") + "\r\n");
  f.check(1, /2001 lines exceeds max 2000;/);
});

test("gitignored build output is not scanned while tracked and untracked files are", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, ".gitignore"), "packages/gui/dist-electron/\n");
  f.write("packages/gui/dist-electron/preload.js", MAX_LINES + 1);
  f.check(0);
  f.write("packages/gui/src/untracked.ts", MAX_LINES + 1);
  f.check(1, /untracked\.ts: 2001 lines exceeds max 2000;/);
  f.commit();
  f.check(1, /untracked\.ts: 2001 lines exceeds max 2000;/);
});

test("tracked files deleted from the worktree are skipped", (t) => {
  const f = fixture(t);
  f.write("packages/demo/src/gone.ts", 10);
  f.commit();
  rmSync(path.join(f.root, "packages/demo/src/gone.ts"));
  f.check(0);
});
