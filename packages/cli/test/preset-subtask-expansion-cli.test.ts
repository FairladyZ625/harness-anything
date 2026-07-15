// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeNestedHarnessRepo } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const presetId = "subtask-expansion";
const presetRoot = path.resolve(
  "packages/cli/src/commands/extensions/assets/software-coding/presets",
  presetId
);

test("CLI subtask-expansion exposes v3 agent guidance without a script runtime", () => {
  const guidance = readFileSync(path.join(presetRoot, "PRESET.md"), "utf8");
  assert.match(guidance, /agent's normal task and relation commands/u);
  assert.match(guidance, /ha task create --parent/u);

  withTempRoot((rootDir) => {
    const presets = runJson(rootDir, ["preset", "list"]);
    const summary = presets.presets.find((preset: Record<string, unknown>) => preset.id === presetId);
    assert.notEqual(summary, undefined);
    assert.match(String(summary.description), /concrete worker plan/u);
    assert.match(String(summary.whenToUse), /decomposed/u);

    const inspected = runJson(rootDir, ["preset", "inspect", presetId]);
    assert.equal(inspected.preset.kind, "process-action");
    assert.equal(inspected.preset.version, "2.0.0");
    assert.deepEqual(inspected.preset.entrypoints, []);
    assert.equal(inspected.preset.manifest.schema, "preset-manifest/v3");
    assert.equal(Object.hasOwn(inspected.preset.manifest, "entrypoints"), false);

    const checked = runJson(rootDir, ["preset", "check", presetId]);
    assert.equal(checked.report.preflight.valid, true);
    assert.deepEqual(checked.report.preflight.entrypoints, []);

    const scripts = runJson(rootDir, ["script", "list", "--source", "preset"]);
    assert.equal(scripts.scripts.some(
      (script: Record<string, unknown>) => String(script.id).startsWith(`preset:${presetId}:`)
    ), false);

    const created = runJson(rootDir, [
      "task", "create",
      "--title", "Expand guided subtasks",
      "--vertical", "software/coding",
      "--preset", presetId
    ]);
    assert.equal(created.report.preset, presetId);
    const contract = JSON.parse(readFileSync(path.join(rootDir, created.packagePath, "task-contract.json"), "utf8"));
    assert.equal(contract.preset.id, presetId);
    assert.equal(contract.preset.version, "2.0.0");
  });
});

function runJson(rootDir: string, args: ReadonlyArray<string>): Record<string, any> {
  const output = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HARNESS_ACTOR: "agent:subtask-expansion-guidance-test",
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
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-subtask-expansion-guidance-"));
  try {
    initializeNestedHarnessRepo(rootDir);
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
