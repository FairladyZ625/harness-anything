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
  ["packages/demo/src/file.ts", 600],
  ["packages/demo/test/file.ts", 700],
  ["packages/demo/src/file.test.ts", 700],
  ["tools/example.mjs", 650],
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

test("existing oversized files can shrink or stay equal but cannot grow below the stage ceiling", (t) => {
  const f = fixture(t);
  const file = "packages/demo/src/file.ts";
  f.write(file, 800);
  f.base();
  f.check(0);
  f.write(file, 799);
  f.check(0);
  f.write(file, 801);
  f.check(1, /801 lines exceeds max 800/);
});

test("existing compliant files may grow to the standard but never cross it", (t) => {
  const f = fixture(t);
  const file = "packages/demo/src/file.ts";
  f.write(file, 500);
  f.base();
  f.write(file, 600);
  f.check(0);
  f.write(file, 601);
  f.check(1);
});

test("the current stage still rejects 1101 source, 1901 test, and 701 tool lines", (t) => {
  const f = fixture(t);
  for (const [file, lines] of [
    ["packages/demo/src/file.ts", 1101],
    ["packages/demo/test/file.ts", 1901],
    ["tools/example.mjs", 701],
  ])
    f.write(file, lines);
  f.base();
  f.check(1, /1101 lines exceeds max 1100/);
  f.check(1, /1901 lines exceeds max 1900/);
  f.check(1, /701 lines exceeds max 700/);
});

test("uses merge-base even when origin/main advanced independently", (t) => {
  const f = fixture(t);
  const file = "packages/demo/src/file.ts";
  f.write(file, 800);
  f.base();
  const base = f.git("rev-parse", "HEAD");
  f.write(file, 900);
  f.commit();
  f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  f.git("checkout", "--quiet", "--detach", base);
  f.write(file, 801);
  f.commit();
  f.check(1, /801 lines exceeds max 800/);
});

test("committed additions and renamed paths do not acquire a historical allowance", (t) => {
  const f = fixture(t);
  f.write("packages/demo/src/old.ts", 800);
  f.base();
  f.git("mv", "packages/demo/src/old.ts", "packages/demo/src/new name.ts");
  f.commit();
  f.check(1, /new name.ts: 800 lines exceeds max 600/);
  rmSync(path.join(f.root, "packages/demo/src/new name.ts"));
  f.check(0);
});

test("retains empty, CRLF, trailing newline and excluded-directory counting behavior", (t) => {
  const f = fixture(t);
  f.base();
  f.write("packages/demo/src/empty.ts", 0);
  f.write("packages/demo/src/file.ts", 600, "\r\n");
  f.write("packages/demo/dist/generated.ts", 2000);
  f.write("packages/demo/src/types.d.ts", 2000);
  f.check(0);
  const file = path.join(f.root, "packages/demo/src/file.ts");
  writeFileSync(file, readFileSync(file, "utf8") + "\r\n");
  f.check(1, /601 lines exceeds max 600/);
});

test("missing origin/main fails instead of disabling the ratchet", (t) => {
  const f = fixture(t);
  f.commit();
  f.check(1, /origin\/main/);
});
