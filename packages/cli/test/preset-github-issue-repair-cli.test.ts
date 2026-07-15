// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeNestedHarnessRepo } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const presetRoot = path.resolve(
  "packages/cli/src/commands/extensions/assets/software-coding/presets/github-issue-repair"
);

test("CLI github issue repair preset exposes agent guidance without a script runtime", () => {
  const guidance = readFileSync(path.join(presetRoot, "PRESET.md"), "utf8");
  assert.match(guidance, /agent's own authenticated GitHub tooling/u);
  assert.match(guidance, /gh issue view/u);
  assert.match(guidance, /Stop and ask the user or maintainer/u);
  assert.equal(existsSync(path.join(presetRoot, "scripts", "preset-action.mjs")), false);

  withTempRoot((rootDir) => {
    const presets = runJson(rootDir, ["preset", "list"]);
    const summary = presets.presets.find((preset: Record<string, unknown>) => preset.id === "github-issue-repair");
    assert.notEqual(summary, undefined);
    assert.match(String(summary.description), /using its own gh and repository tools/u);
    assert.match(String(summary.whenToUse), /without guessing past missing maintainer decisions/u);

    const inspected = runJson(rootDir, ["preset", "inspect", "github-issue-repair"]);
    assert.equal(inspected.preset.kind, "process-action");
    assert.equal(inspected.preset.version, "2.0.0");
    assert.deepEqual(inspected.preset.entrypoints, []);
    assert.equal(inspected.preset.manifest.schema, "preset-manifest/v3");
    assert.deepEqual(inspected.preset.manifest.capabilityImports, []);
    assert.equal(Object.hasOwn(inspected.preset.manifest, "entrypoints"), false);

    const listed = runJson(rootDir, ["script", "list", "--source", "preset", "--purpose", "generate"]);
    assert.equal(listed.scripts.some(
      (script: Record<string, unknown>) => String(script.id).startsWith("preset:github-issue-repair:")
    ), false);

    const created = runJson(rootDir, [
      "task", "create",
      "--title", "Repair GitHub issue 42",
      "--vertical", "software/coding",
      "--preset", "github-issue-repair"
    ]);
    assert.equal(created.report.preset, "github-issue-repair");
    const contract = JSON.parse(readFileSync(path.join(rootDir, created.packagePath, "task-contract.json"), "utf8"));
    assert.equal(contract.preset.id, "github-issue-repair");
    assert.equal(contract.preset.version, "2.0.0");
  });
});

function runJson(rootDir: string, args: ReadonlyArray<string>): Record<string, any> {
  const output = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HARNESS_ACTOR: "agent:github-issue-repair-test",
      HARNESS_GIT_AUTHOR_NAME: "Harness Test",
      HARNESS_GIT_AUTHOR_EMAIL: "harness@example.test",
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_DIRECT_WRITE_REASON: "test",
      HARNESS_USER_HOME: path.join(rootDir, ".empty-user-home")
    }
  });
  const parsed = JSON.parse(output) as Record<string, any>;
  assert.equal(parsed.ok, true, output);
  return unwrapCommandReceipt(parsed);
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "harness-preset-github-issue-"));
  try {
    initializeNestedHarnessRepo(rootDir);
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
