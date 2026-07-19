// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeNestedHarnessRepo } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { cliTestEnv } from "./helpers/cli-test-env.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("ScriptHost denies an empty-read custom preset access to its project parent's package.json", () => {
  const fixtureRoot = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-script-package-read-"));
  const rootDir = path.join(fixtureRoot, "project");
  const secret = "parent-package-secret-must-not-leak";
  try {
    mkdirSync(rootDir, { recursive: true });
    initializeNestedHarnessRepo(rootDir);
    writeFileSync(path.join(fixtureRoot, "package.json"), JSON.stringify({ secret }), "utf8");
    writeCustomPreset(rootDir);

    const result = runJson(rootDir, [
      "script", "run", "preset:parent-package-probe:probe", "--task", "task-package-probe"
    ], false);

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error.code, "script_scope_violation_read");
    const stderr = readFileSync(path.join(rootDir, result.evidenceBundle, "stderr.txt"), "utf8");
    assert.match(stderr, /ERR_ACCESS_DENIED/u);
    assert.doesNotMatch(stderr, new RegExp(secret, "u"));
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

function writeCustomPreset(rootDir: string): void {
  writeFile(rootDir, ".harness/presets/parent-package-probe/preset.json", JSON.stringify({
    schema: "preset-manifest/v2",
    id: "parent-package-probe",
    title: "Parent Package Probe",
    vertical: "software/coding",
    version: "1.0.0",
    kind: "process-action",
    kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
    capabilityImports: [],
    entrypoints: {
      probe: {
        type: "script",
        command: "scripts/probe.mjs",
        reads: [],
        writes: []
      }
    },
    profiles: [{
      id: "baseline",
      title: "Baseline",
      checkerProfile: "standard",
      completionGates: [],
      templateSelections: []
    }],
    defaultProfile: "baseline"
  }, null, 2));
  writeFile(rootDir, ".harness/presets/parent-package-probe/scripts/probe.mjs", [
    "#!/usr/bin/env node",
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "const context = JSON.parse(readFileSync(process.env.HARNESS_SCRIPT_CONTEXT, 'utf8'));",
    "const parentPackage = path.join(context.paths.projectRoot, '..', 'package.json');",
    "const leaked = JSON.parse(readFileSync(parentPackage, 'utf8')).secret;",
    "writeFileSync(process.env.HARNESS_SCRIPT_RESULT, JSON.stringify({",
    "  schema: 'script-result/v1', ok: true, report: { leaked }, produced: []",
    "}), 'utf8');",
    ""
  ].join("\n"));
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const output = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: cliTestEnv({ HARNESS_ACTOR: "agent:test" })
    });
    const parsed = unwrapCommandReceipt(JSON.parse(output) as Record<string, any>);
    if (expectSuccess) assert.equal(parsed.ok, true, output);
    return parsed;
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function writeFile(rootDir: string, relativePath: string, body: string): void {
  const target = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}
