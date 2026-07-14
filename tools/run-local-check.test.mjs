// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLocalStepInvocation,
  buildSteps,
  collectChangedFiles,
  deriveAffectedTestPrefixes,
  parseLocalCheckArgs
} from "./run-local-check.mjs";

test("parseLocalCheckArgs defaults to the light stop gate", () => {
  assert.deepEqual(parseLocalCheckArgs([]), { full: false });
  assert.equal(parseLocalCheckArgs(["--full"]).full, true);
  assert.equal(parseLocalCheckArgs(["--full", "--fast"]).full, false);
  assert.throws(() => parseLocalCheckArgs(["--no-wait"]), /unknown run-local-check option/u);
});

test("affected test prefixes derive package, nested adapter, and tools scopes", () => {
  assert.deepEqual(deriveAffectedTestPrefixes([
    "packages/kernel/src/index.ts",
    "packages/adapters/local/src/index.ts",
    "tools/run-local-check.mjs",
    "docs-release/readme.md"
  ]), ["packages/adapters/local/", "packages/kernel/", "tools/"]);
  assert.deepEqual(deriveAffectedTestPrefixes(["package-lock.json"]), ["packages/", "tools/"]);
  assert.deepEqual(deriveAffectedTestPrefixes(["package.json"]), ["tools/"]);
});

test("light steps contain incremental typecheck, changed lint, and affected tests only", () => {
  const steps = buildSteps(false, ["tools/run-local-check.mjs", "docs-release/readme.md"]);
  assert.deepEqual(steps.map(([label]) => label), [
    "incremental typecheck",
    "changed-file lint",
    "affected fast tests",
    "affected contract tests"
  ]);
  assert.equal(steps.some(([label]) => label.includes("integration")), false);
  assert.equal(steps.some(([label]) => label.includes("manifest")), false);
});

test("manual full tier appends integration, GUI E2E, and manifest gates", () => {
  const labels = buildSteps(true, ["packages/gui/src/main.ts"]).map(([label]) => label);
  assert.ok(labels.includes("affected GUI tests"));
  assert.ok(labels.includes("integration tests"));
  assert.ok(labels.includes("GUI E2E"));
  assert.ok(labels.includes("manifest local gates"));
});

test("local steps apply the shared QoS prefix", () => {
  assert.deepEqual(buildLocalStepInvocation(["nice", "-n", "10"], "npm", ["run", "typecheck"]), {
    command: "nice",
    args: ["-n", "10", "npm", "run", "typecheck"]
  });
});

test("changed-file collection combines merge-base diff and untracked files", () => {
  const calls = [];
  const run = (_command, args) => {
    calls.push(args);
    if (args[0] === "merge-base") return { status: 0, stdout: "base\n", stderr: "" };
    if (args[0] === "diff") return { status: 0, stdout: "tools/a.mjs\n", stderr: "" };
    return { status: 0, stdout: "tools/b.test.mjs\n", stderr: "" };
  };
  assert.deepEqual(collectChangedFiles("/repo", run), ["tools/a.mjs", "tools/b.test.mjs"]);
  assert.deepEqual(calls[1].slice(0, 5), ["diff", "--name-only", "--diff-filter=ACMR", "base", "--"]);
});
