// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import { runJson, withTempRoot } from "./helpers/preset-script-fixtures.ts";

test("CLI legacy-migration exposes v3 agent guidance without a script runtime", () => {
  const presetId = "legacy-migration";
  const guidance = readFileSync(path.resolve(
    "packages/cli/src/commands/extensions/assets/software-coding/presets",
    presetId,
    "PRESET.md"
  ), "utf8");
  assert.match(guidance, /Inventory and migrate legacy material/u);
  assert.match(guidance, /identify the exact legacy source roots/u);

  withTempRoot((rootDir) => {
    const previousUserHome = process.env.HARNESS_USER_HOME;
    process.env.HARNESS_USER_HOME = path.join(rootDir, ".empty-user-home");
    try {
      ensureTestHarnessIdentity(rootDir);
      const presets = runJson(rootDir, ["preset", "list"]);
      const summary = presets.presets.find((preset: Record<string, unknown>) => preset.id === presetId);
      assert.notEqual(summary, undefined);
      assert.match(String(summary.description), /Inventory legacy harness material/u);
      assert.match(String(summary.whenToUse), /older task, decision, or documentation layouts/u);

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

      runJson(rootDir, ["init"]);
      const created = runJson(rootDir, [
        "task", "create",
        "--title", "Guided legacy migration",
        "--vertical", "software/coding",
        "--preset", presetId
      ]);
      assert.equal(created.report.preset, presetId);
      const contract = JSON.parse(readFileSync(path.join(rootDir, created.packagePath, "task-contract.json"), "utf8"));
      assert.equal(contract.preset.id, presetId);
      assert.equal(contract.preset.version, "2.0.0");
    } finally {
      if (previousUserHome === undefined) delete process.env.HARNESS_USER_HOME;
      else process.env.HARNESS_USER_HOME = previousUserHome;
    }
  });
});
