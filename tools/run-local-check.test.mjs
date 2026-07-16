// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildLocalStepInvocation,
  buildSteps,
  collectChangedFiles,
  deriveStopPointCoverage,
  deriveAffectedTestPrefixes,
  formatStopPointSummary,
  parseLocalCheckArgs
} from "./run-local-check.mjs";
import { npmCliInvocation } from "./node-cli-invocation.mjs";

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
    "manifest local stop gates",
    "changed-file lint",
    "affected fast tests",
    "affected contract tests"
  ]);
  assert.equal(steps.some(([label]) => label.includes("integration")), false);
  assert.equal(steps.filter(([label]) => label.includes("manifest")).length, 1);
});

test("manual full tier appends integration, GUI E2E, and manifest gates", () => {
  const labels = buildSteps(true, ["packages/gui/src/main.ts"]).map(([label]) => label);
  assert.ok(labels.includes("affected GUI tests"));
  assert.ok(labels.includes("integration tests"));
  assert.ok(labels.includes("GUI E2E"));
  assert.ok(labels.includes("manifest local stop gates"));
});

test("local steps apply the shared QoS prefix", () => {
  assert.deepEqual(buildLocalStepInvocation(["nice", "-n", "10"], "npm", ["run", "typecheck"]), {
    command: "nice",
    args: ["-n", "10", "npm", "run", "typecheck"]
  });
});

test("Windows npm resolution launches npm-cli.js through Node instead of a command wrapper", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-windows-npm-cli-"));
  try {
    const npmCli = path.join(rootDir, "npm-cli.js");
    writeFileSync(npmCli, "process.stdout.write(process.argv.slice(2).join('|'));\n", "utf8");
    const invocation = npmCliInvocation(["run", "typecheck"], {
      env: { npm_execpath: npmCli },
      execPath: process.execPath
    });
    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.args, [npmCli, "run", "typecheck"]);
    const launched = spawnSync(invocation.command, invocation.args, { encoding: "utf8" });
    assert.equal(launched.error, undefined);
    assert.equal(launched.status, 0);
    assert.equal(launched.stdout, "run|typecheck");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("stop-point summary derives completed and omitted gates from the manifest", () => {
  const manifest = {
    surfaces: { localStop: { gateIds: ["static-a"] } },
    gates: [
      { id: "static-a", executionSurfaces: { rewriteCi: { pullRequestJobs: ["boundaries"] } } },
      { id: "typecheck", executionSurfaces: { rewriteCi: { pullRequestJobs: ["typecheck"] } } },
      { id: "test-integration", executionSurfaces: { rewriteCi: { pullRequestJobs: ["integration"] } } }
    ]
  };
  const coverage = deriveStopPointCoverage(manifest, ["incremental typecheck"]);
  assert.deepEqual(coverage, { completed: ["static-a", "typecheck"], ciOnly: ["test-integration"] });
  assert.match(formatStopPointSummary(coverage), /CI still runs 1.*test-integration/u);
  assert.match(formatStopPointSummary(coverage), /npm run check:ci/u);
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
