// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { ESLint } from "eslint";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// `.gitignore` and the ESLint `ignores` list are two hand-maintained answers to the same
// question: which trees under this repository are not source. They drifted once already —
// `harness-old-generation-*/` was ignored by git and still linted, which put 15,066 errors
// into `npm run lint` and made the root `check:local` step permanently red on any machine
// that had that archive checked out. This test states the one-directional invariant that
// closes the drift: whatever git refuses to track at the top level, ESLint must refuse to lint.
//
// The check runs through `isPathIgnored` rather than comparing the two pattern lists, because
// the same tree can be spelled differently in each file (`.harness*/` in git, `.harness/` plus
// `.harness-private/` in ESLint) without any drift existing. Only root-anchored directory
// patterns are covered: those are the ones that name a whole top-level tree, and they are the
// class that drifted.

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
    `git ignores these top-level trees but ESLint would still lint them; add each to the ignores list in eslint.config.mjs:\n  ${linted.join("\n  ")}`
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
