// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { ESLint } from "eslint";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Check real ESLint behavior against the root trees declared by Git. The isolated
// fixture below also verifies that newly added patterns work without a config edit.

function rootAnchoredIgnoredDirectories() {
  const body = readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
  const patterns = [];
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    if (!line.startsWith("/") || !line.endsWith("/")) continue;
    patterns.push(line.slice(1, -1));
  }
  return patterns;
}

// A pattern may contain a glob; substitute a concrete name so the probe is a real path.
function probePathFor(pattern) {
  return `${pattern.replaceAll("*", "probe")}/probe.ts`;
}

test("every root-anchored directory ignored by git is also ignored by ESLint", async () => {
  const patterns = rootAnchoredIgnoredDirectories();
  assert.ok(patterns.length > 0, ".gitignore declares no root-anchored directories; the parser is wrong");

  const eslint = new ESLint({ cwd: repoRoot });
  const linted = [];
  for (const pattern of patterns) {
    const probe = probePathFor(pattern);
    if (!(await eslint.isPathIgnored(probe))) linted.push(`${pattern} (probe ${probe})`);
  }

  assert.deepEqual(
    linted,
    [],
    `git ignores these top-level trees but ESLint would still lint them:\n  ${linted.join("\n  ")}`,
  );
});

test("the probe is capable of failing: real source is not ignored", async () => {
  const eslint = new ESLint({ cwd: repoRoot });
  assert.equal(await eslint.isPathIgnored("packages/kernel/src/probe.ts"), false);
  assert.equal(await eslint.isPathIgnored("tools/gates/probe.mjs"), false);
});

test("probePathFor substitutes globs so the probe is a concrete path", () => {
  assert.equal(probePathFor("harness-old-generation-*"), "harness-old-generation-probe/probe.ts");
  assert.equal(probePathFor("docs"), "docs/probe.ts");
});

test("new gitignore rules take effect without editing ESLint configuration", async (t) => {
  const fixture = mkdtempSync(path.join(repoRoot, ".eslint-ignore-test-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  copyFileSync(path.join(repoRoot, "eslint.config.mjs"), path.join(fixture, "eslint.config.mjs"));
  symlinkSync(path.join(repoRoot, "tools"), path.join(fixture, "tools"), "junction");
  writeFileSync(
    path.join(fixture, ".gitignore"),
    [
      "# Newly added local trees and files",
      "/new-local-tree/",
      "generated-cache/",
      "*.generated.js",
      "!keep.generated.js",
      "",
    ].join("\r\n"),
  );

  const eslint = new ESLint({
    cwd: fixture,
    overrideConfig: { languageOptions: { parserOptions: { tsconfigRootDir: fixture } } },
  });
  for (const filePath of [
    "new-local-tree/probe.js",
    "packages/example/generated-cache/probe.js",
    "packages/example/output.generated.js",
  ]) {
    assert.equal(await eslint.isPathIgnored(filePath), true, filePath);
  }
  for (const filePath of ["nested/new-local-tree/probe.js", "keep.generated.js", "src/probe.js"]) {
    assert.equal(await eslint.isPathIgnored(filePath), false, filePath);
  }
  const [ignored] = await eslint.lintText("const = ;", { filePath: "new-local-tree/probe.js" });
  assert.equal(ignored.errorCount, 0);
  const [source] = await eslint.lintText("debugger;", { filePath: "src/probe.js" });
  assert.ok(
    source.messages.some(({ ruleId }) => ruleId === "no-debugger"),
    JSON.stringify(source),
  );
});

test("unanchored gitignored trees are ignored below source packages", async () => {
  const eslint = new ESLint({ cwd: repoRoot });
  for (const directory of ["dist", "coverage", "tmp", ".harness-local", ".playwright-mcp"]) {
    const probe = `packages/example/${directory}/probe.js`;
    assert.equal(await eslint.isPathIgnored(probe), true, probe);
  }
});
