import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI preset discovery honors project over user over bundled presets", () => {
  withTempRoot((rootDir) => {
    writePreset(rootDir, ".harness/user-presets/standard-task/preset.json", {
      id: "standard-task",
      title: "User Standard Task",
      version: "1.0.0"
    });
    writePreset(rootDir, ".harness/presets/standard-task/preset.json", {
      id: "standard-task",
      title: "Project Standard Task",
      version: "2.0.0"
    });

    const result = runJson(rootDir, ["preset", "list"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "preset-list");
    const standard = result.presets.find((preset: Record<string, unknown>) => preset.id === "standard-task");
    assert.equal(standard.title, "Project Standard Task");
    assert.equal(standard.layer, "project");
    assert.equal(result.presets.some((preset: Record<string, unknown>) => preset.id === "module"), true);
  });
});

test("CLI preset CRUD validates, installs, audits, and removes project presets", () => {
  withTempRoot((rootDir) => {
    const sourceDir = path.join(rootDir, "source-preset");
    writePreset(sourceDir, "preset.json", {
      id: "custom-task",
      title: "Custom Task",
      version: "1.0.0"
    });

    const installed = runJson(rootDir, ["preset", "install", sourceDir, "--project"]);
    assert.equal(installed.ok, true);
    assert.equal(installed.command, "preset-install");
    assert.equal(installed.preset.id, "custom-task");

    const inspected = runJson(rootDir, ["preset", "inspect", "custom-task"]);
    assert.equal(inspected.ok, true);
    assert.equal(inspected.preset.layer, "project");

    const checked = runJson(rootDir, ["preset", "check", "custom-task"]);
    assert.equal(checked.ok, true);
    assert.deepEqual(checked.issues, []);

    const audit = runJson(rootDir, ["preset", "audit"]);
    assert.equal(audit.ok, true);
    assert.equal(audit.report.totalResolved, 8);

    const removed = runJson(rootDir, ["preset", "uninstall", "custom-task", "--project"]);
    assert.equal(removed.ok, true);
    assert.equal(removed.command, "preset-uninstall");

    const missing = runJson(rootDir, ["preset", "inspect", "custom-task"], false);
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, "preset_not_found");
  });
});

test("CLI preset run writes scoped evidence bundles and rejects unknown actions", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, ["preset", "run", "module", "check", "--task", "task-1"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "preset-run");
    assert.equal(result.evidenceBundle.startsWith(".harness/evidence/presets/module/"), true);
    const evidence = JSON.parse(readFileSync(path.join(rootDir, result.evidenceBundle, "evidence.json"), "utf8"));
    assert.equal(evidence.presetId, "module");
    assert.equal(evidence.entrypoint, "check");

    const rejected = runJson(rootDir, ["preset", "action", "module", "deploy", "--task", "task-1"], false);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "preset_action_forbidden");

    const action = runJson(rootDir, ["preset", "action", "module", "check", "--task", "task-1"]);
    assert.equal(action.ok, true);
    assert.equal(action.command, "preset-action");

    const invalidTask = runJson(rootDir, ["preset", "run", "module", "check", "--task", "../task"], false);
    assert.equal(invalidTask.ok, false);
    assert.equal(invalidTask.error.code, "invalid_registry_key");
  });
});

test("CLI module CRUD maintains generated module view and module-step state", () => {
  withTempRoot((rootDir) => {
    const registered = runJson(rootDir, ["module", "register", "billing", "--title", "Billing", "--scope", "packages/billing/**"]);
    assert.equal(registered.ok, true);
    assert.equal(registered.command, "module-register");
    assert.equal(registered.module.key, "billing");

    const listed = runJson(rootDir, ["module", "list"]);
    assert.equal(listed.ok, true);
    assert.equal(listed.modules.length, 1);
    assert.equal(listed.modules[0].key, "billing");

    const inspected = runJson(rootDir, ["module", "inspect", "billing"]);
    assert.equal(inspected.ok, true);
    assert.deepEqual(inspected.module.scopes, ["packages/billing/**"]);

    const scaffolded = runJson(rootDir, ["module", "scaffold", "billing"]);
    assert.equal(scaffolded.ok, true);
    assert.equal(scaffolded.path, "harness/planning/modules/billing/module_plan.md");

    const stepped = runJson(rootDir, ["module-step", "billing", "BILL-01", "--state", "done"]);
    assert.equal(stepped.ok, true);
    assert.equal(stepped.module.steps[0].state, "done");

    const registry = readFileSync(path.join(rootDir, ".harness/generated/Module-Registry.md"), "utf8");
    assert.match(registry, /\| billing \| Billing \| active \|/);

    const removed = runJson(rootDir, ["module", "unregister", "billing"]);
    assert.equal(removed.ok, true);
    assert.equal(removed.module.status, "unregistered");
  });
});

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8"
    });
    return JSON.parse(stdout) as Record<string, any>;
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return JSON.parse(failure.stdout ?? "{}") as Record<string, any>;
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-p2-cli-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writePreset(rootDir: string, relativePath: string, overrides: { readonly id: string; readonly title: string; readonly version: string }): void {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(makePreset(overrides), null, 2), "utf8");
}

function makePreset(overrides: { readonly id: string; readonly title: string; readonly version: string }): Record<string, unknown> {
  return {
    schema: "preset-manifest/v1",
    id: overrides.id,
    title: overrides.title,
    vertical: "software/coding",
    version: overrides.version,
    kernelVersionRange: {
      min: "1.0.0",
      maxExclusive: "2.0.0"
    },
    capabilityImports: [],
    profiles: [{
      id: "baseline",
      title: "Baseline",
      checkerProfile: "standard",
      templateSelections: []
    }],
    defaultProfile: "baseline"
  };
}
