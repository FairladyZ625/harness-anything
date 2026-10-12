// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  affectedTestFiles,
  changedFilesSince,
  dispatchArguments,
  formatSummary,
  parseFailingTests,
  parseFileOutcomes,
  parseSkillArgs,
  workspacePackagesByDirectory,
} from "../skills/harness-contributing/scripts/test-on-server.mjs";

test("parseSkillArgs selects exactly one of changed, files, or tier with prefixes", () => {
  assert.deepEqual(parseSkillArgs(["--changed"]), { mode: "changed", base: "origin/main" });
  assert.deepEqual(parseSkillArgs(["--changed", "origin/release"]), { mode: "changed", base: "origin/release" });
  assert.deepEqual(parseSkillArgs(["--file", "tools/a.test.mjs", "--file", "tools/b.test.ts"]), {
    mode: "files",
    files: ["tools/a.test.mjs", "tools/b.test.ts"],
  });
  assert.deepEqual(parseSkillArgs(["--tier", "integration", "--prefix", "packages/daemon/test"]), {
    mode: "tier",
    tier: "integration",
    prefixes: ["packages/daemon/test"],
  });
  assert.throws(() => parseSkillArgs([]), /choose exactly one selector/u);
  assert.throws(() => parseSkillArgs(["--changed", "origin/main", "--tier", "fast"]), /choose exactly one selector/u);
  assert.throws(() => parseSkillArgs(["--prefix", "tools/"]), /choose exactly one selector/u);
  assert.throws(() => parseSkillArgs(["--file", "tools/a.test.mjs", "--prefix", "tools/"]), /--prefix narrows/u);
  assert.throws(() => parseSkillArgs(["--file", "../outside.test.mjs"]), /repository-relative/u);
});

test("changedFilesSince lists the committed delta from the merge base", () => {
  const root = seedRepository();
  try {
    write(root, "tools/kept.txt");
    execFileSync("git", ["-C", root, "add", "tools/kept.txt"]);
    execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "test: change tracked file"]);
    assert.deepEqual(changedFilesSince(root, "main"), ["tools/kept.txt"]);
    assert.deepEqual(changedFilesSince(root, "HEAD"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("affectedTestFiles selects changed tests and tests importing changed sources", () => {
  const manifest = { fast: ["tools/a.test.mjs", "packages/daemon/test/b.test.ts", "tools/c.test.mjs"] };
  const sources = {
    "tools/a.test.mjs": 'import { helper } from "./helper.mjs";\nimport test from "node:test";\n',
    "packages/daemon/test/b.test.ts":
      'import { thing } from "@harness-anything/daemon";\nimport { more } from "../../src/thing.ts";\n',
    "tools/c.test.mjs": 'import test from "node:test";\n',
  };
  const packages = new Map([["@harness-anything/daemon", "packages/daemon"]]);
  const select = (changed) => affectedTestFiles(changed, manifest, (file) => sources[file], packages).files;

  // A changed test file is selected directly.
  assert.deepEqual(select(["tools/c.test.mjs"]), ["tools/c.test.mjs"]);
  // A relative import with or without extension, and a directory import, reach the changed source.
  assert.deepEqual(select(["tools/helper.mjs"]), ["tools/a.test.mjs"]);
  assert.deepEqual(select(["packages/daemon/src/thing.ts"]), ["packages/daemon/test/b.test.ts"]);
  assert.deepEqual(select(["packages/daemon/src/index.ts"]), ["packages/daemon/test/b.test.ts"]);
  // A workspace-name import follows the owning package directory.
  assert.deepEqual(select(["packages/daemon/src/store/other.ts"]), ["packages/daemon/test/b.test.ts"]);
  // A source nothing imports selects nothing; a vitest change is reported instead of selected.
  assert.deepEqual(select(["docs/readme.md"]), []);
  const vitest = affectedTestFiles(["packages/gui/test/x.vitest.ts"], manifest, (file) => sources[file], packages);
  assert.deepEqual(vitest.files, []);
  assert.deepEqual(vitest.vitestNotices, ["packages/gui/test/x.vitest.ts"]);
});

test("workspacePackagesByDirectory maps package names from the workspace manifests", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-workspace-packages-"));
  try {
    writePackage(root, "daemon", "@harness-anything/daemon");
    writePackage(root, "adapters/local", "@harness-anything/adapter-local");
    assert.deepEqual(
      workspacePackagesByDirectory(path.join(root, "packages")),
      new Map([
        ["@harness-anything/daemon", "packages/daemon"],
        ["@harness-anything/adapter-local", "packages/adapters/local"],
      ]),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatchArguments forwards repeated files or a tier with prefixes", () => {
  assert.deepEqual(dispatchArguments({ mode: "files", files: ["tools/a.test.mjs", "tools/b.test.ts"] }), [
    "--file",
    "tools/a.test.mjs",
    "--file",
    "tools/b.test.ts",
  ]);
  assert.deepEqual(dispatchArguments({ mode: "tier", tier: "fast", prefixes: [] }), ["--tier", "fast"]);
  assert.deepEqual(dispatchArguments({ mode: "tier", tier: "integration", prefixes: ["packages/daemon/test"] }), [
    "--tier",
    "integration",
    "--prefix",
    "packages/daemon/test",
  ]);
});

test("parseFileOutcomes reads one outcome per started file", () => {
  const outcomes = parseFileOutcomes(
    [
      "[node-test-file] pass tools/a.test.mjs",
      "noise without marker",
      "[node-test-file] fail packages/b.test.ts",
      "[node-test-file] timeout tools/c.test.mjs",
    ].join("\n"),
  );
  assert.deepEqual(
    outcomes,
    new Map([
      ["tools/a.test.mjs", "pass"],
      ["packages/b.test.ts", "fail"],
      ["tools/c.test.mjs", "timeout"],
    ]),
  );
});

test("parseFailingTests extracts names and message excerpts from the spec recap", () => {
  const output = [
    "ℹ pass 1",
    "✖ failing tests:",
    "",
    "test at tools/b.test.mjs:4:1",
    "✖ failing case name (1.234ms)",
    "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
    "  ",
    "  1 !== 2",
    "      at TestContext.<anonymous> (file:///repo/tools/b.test.mjs:4:41)",
    "",
    "test at packages/c.test.ts:6:1",
    "✖ another case (0.5ms)",
    "  Error: boom",
    "",
    "Slow test summary: no tests at or above 1000ms.",
    "[node-test-file] pass packages/c.test.ts",
  ].join("\n");
  assert.deepEqual(parseFailingTests(output), [
    {
      file: "tools/b.test.mjs",
      name: "failing case name",
      excerpt: ["AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:", "1 !== 2"],
    },
    { file: "packages/c.test.ts", name: "another case", excerpt: ["Error: boom"] },
  ]);
  assert.deepEqual(parseFailingTests("all green\nℹ pass 3"), []);
});

test("formatSummary lists every selected file with its outcome and the failure details", () => {
  const summary = formatSummary({
    selection: ["tools/a.test.mjs", "tools/b.test.mjs", "tools/never-ran.test.mjs"],
    outcomes: new Map([
      ["tools/a.test.mjs", "pass"],
      ["tools/b.test.mjs", "fail"],
    ]),
    failures: [{ file: "tools/b.test.mjs", name: "failing case", excerpt: ["Error: boom"] }],
    exitCode: 1,
    durationMs: 109123,
  });
  assert.equal(
    summary,
    [
      "[test-on-server] 3 file(s): 1 pass, 1 fail, 1 not run; exit=1; server duration_ms=109123",
      "  ✔ tools/a.test.mjs",
      "  ✖ tools/b.test.mjs",
      "  – tools/never-ran.test.mjs",
      "      ✖ failing case (tools/b.test.mjs)",
      "         Error: boom",
    ].join("\n"),
  );
});

function writePackage(root, directory, name) {
  const target = path.join(root, "packages", directory);
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, "package.json"), `${JSON.stringify({ name })}\n`);
}

function write(root, relativePath) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${relativePath}\n`);
}

function seedRepository() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-test-on-server-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Selection Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "selection@example.invalid"]);
  write(root, "tools/base.txt");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "test: seed base"]);
  execFileSync("git", ["-C", root, "checkout", "--quiet", "-b", "work"]);
  return root;
}
