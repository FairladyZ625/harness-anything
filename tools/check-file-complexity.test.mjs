// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const checker = path.resolve(import.meta.dirname, "check-file-complexity.mjs");

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
  const base = () => {
    commit();
    git("update-ref", "refs/remotes/origin/main", "HEAD");
  };
  const check = (expected, pattern) => {
    const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, expected, output);
    if (pattern) assert.match(output, pattern);
  };
  return { root, git, write, commit, base, check };
}

for (const [file, limit] of [
  ["packages/demo/src/file.ts", 1000],
  ["packages/demo/test/file.ts", 1200],
  ["packages/demo/src/file.test.ts", 1200],
  ["tools/example.mjs", 1000],
]) {
  test(`new ${file} respects the standard boundary`, (t) => {
    const f = fixture(t);
    f.base();
    f.write(file, limit);
    f.check(0);
    f.write(file, limit + 1);
    f.check(1, /exceeds max/);
  });
}

test("existing source files may grow freely within the stage ceiling (no shrink-only ratchet)", (t) => {
  const f = fixture(t);
  const file = "packages/demo/src/file.ts";
  f.write(file, 1000);
  f.base();
  f.check(0);
  f.write(file, 1050);
  f.check(0);
  f.write(file, 1100);
  f.check(0);
  f.write(file, 1101);
  f.check(1, /1101 lines exceeds max 1100/);
});

test("existing test files may grow within the test stage ceiling", (t) => {
  const f = fixture(t);
  const file = "packages/demo/test/big.test.ts";
  f.write(file, 1200);
  f.base();
  f.check(0);
  f.write(file, 1500);
  f.check(0);
  f.write(file, 1901);
  f.check(1, /1901 lines exceeds max 1900/);
});

test("the current stage still rejects 1101 source, 1901 test, and 1101 tool lines", (t) => {
  const f = fixture(t);
  for (const [file, lines] of [
    ["packages/demo/src/file.ts", 1101],
    ["packages/demo/test/file.ts", 1901],
    ["tools/example.mjs", 1101],
  ])
    f.write(file, lines);
  f.base();
  f.check(1, /1101 lines exceeds max 1100/);
  f.check(1, /1901 lines exceeds max 1900/);
});

test("uses merge-base even when origin/main advanced independently", (t) => {
  const f = fixture(t);
  const file = "packages/demo/src/file.ts";
  f.base();
  const base = f.git("rev-parse", "HEAD");
  f.write(file, 1090);
  f.commit();
  f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  f.git("checkout", "--quiet", "--detach", base);
  f.write(file, 1050);
  f.commit();
  f.check(1, /file.ts: 1050 lines exceeds max 1000/);
});

test("committed additions do not acquire a historical allowance", (t) => {
  const f = fixture(t);
  f.base();
  f.write("packages/demo/src/fresh.ts", 1050);
  f.commit();
  f.check(1, /fresh.ts: 1050 lines exceeds max 1000/);
});

test("renamed paths inherit merge-base existence and keep the stage ceiling", (t) => {
  const f = fixture(t);
  f.write("packages/demo/src/old.ts", 1050);
  f.base();
  f.git("mv", "packages/demo/src/old.ts", "packages/demo/src/new name.ts");
  f.commit();
  f.check(0);
  f.write("packages/demo/src/new name.ts", 1101);
  f.check(1, /new name.ts: 1101 lines exceeds max 1100/);
});

test("retains empty, CRLF, trailing newline and excluded-directory counting behavior", (t) => {
  const f = fixture(t);
  f.base();
  f.write("packages/demo/src/empty.ts", 0);
  f.write("packages/demo/src/file.ts", 1000, "\r\n");
  f.write("packages/demo/dist/generated.ts", 2000);
  f.write("packages/demo/src/types.d.ts", 2000);
  f.check(0);
  const file = path.join(f.root, "packages/demo/src/file.ts");
  writeFileSync(file, readFileSync(file, "utf8") + "\r\n");
  f.check(1, /1001 lines exceeds max 1000/);
});

test("missing origin/main fails instead of disabling the base comparison", (t) => {
  const f = fixture(t);
  f.commit();
  f.check(1, /origin\/main/);
});
