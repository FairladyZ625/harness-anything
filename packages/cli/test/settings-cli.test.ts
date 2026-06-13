import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI new-task uses project settings defaults and explicit flag precedence", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    runJson(rootDir, ["module", "register", "billing", "--title", "Billing", "--scope", "packages/billing/**"]);

    const defaulted = runJson(rootDir, ["new-task", "--title", "Default Coding Task"]);
    assert.equal(defaulted.report.vertical, "software/coding");
    assert.equal(defaulted.report.preset, "standard-task");
    assert.equal(defaulted.report.profile, "baseline");

    const moduleTask = runJson(rootDir, ["new-task", "--title", "Module Override", "--preset", "module", "--module", "billing"]);
    assert.equal(moduleTask.report.vertical, "software/coding");
    assert.equal(moduleTask.report.preset, "module");
    assert.equal(moduleTask.module.key, "billing");

    writeRawPreset(rootDir, ".harness/presets/profiled-task/preset.json", makeProfiledPreset());
    const profiled = runJson(rootDir, ["new-task", "--title", "Profile Override", "--preset", "profiled-task", "--profile", "extra"]);
    assert.equal(profiled.report.profile, "extra");
    assert.equal(profiled.generated.includes("extra.md"), true);
  });
});

test("CLI new-task keeps inert settings generic and legacy rebuild isolated", () => {
  withTempRoot((rootDir) => {
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  locale: zh-CN",
      "  defaultVertical: default",
      "  defaultPreset: default",
      "  defaultProfile: baseline",
      "  customVerticals:",
      "    enabled: false",
      ""
    ]);

    const generic = runJson(rootDir, ["new-task", "--title", "Generic Task"]);
    assert.equal(generic.report, undefined);
    assert.match(readFileSync(path.join(rootDir, generic.packagePath, "INDEX.md"), "utf8"), /vertical: default/);

    const explicitVertical = runJson(rootDir, ["new-task", "--title", "Explicit Vertical", "--vertical", "software/coding"]);
    assert.equal(explicitVertical.report.vertical, "software/coding");
    assert.equal(explicitVertical.report.preset, "standard-task");

    const explicitPreset = runJson(rootDir, ["new-task", "--title", "Explicit Preset", "--preset", "standard-task"]);
    assert.equal(explicitPreset.report.vertical, "software/coding");
    assert.equal(explicitPreset.report.preset, "standard-task");

    const legacy = runJson(rootDir, ["new-task", "--from-legacy", "legacy-1"], false);
    assert.equal(legacy.error.code, "legacy_index_missing");
  });
});

test("CLI settings fail closed for malformed and unsupported custom vertical defaults", () => {
  withTempRoot((rootDir) => {
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  locale: fr-FR",
      "  defaultVertical: software/coding",
      "  defaultPreset: standard-task",
      ""
    ]);

    const malformed = runJson(rootDir, ["new-task", "--title", "Bad Settings"], false);
    assert.equal(malformed.error.code, "harness_settings_invalid");
    assert.equal(malformed.command, "new-task");
  });

  withTempRoot((rootDir) => {
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  locale: zh-CN",
      "  defaultVertical: software/coding",
      "  defaultPreset: standard-task",
      "  customVerticals:",
      ""
    ]);

    const malformed = runJson(rootDir, ["new-task", "--title", "Missing Gate"], false);
    assert.equal(malformed.error.code, "harness_settings_invalid");
  });

  withTempRoot((rootDir) => {
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  locale: fr-FR",
      "  defaultVertical: custom/acme",
      "  defaultPreset: standard-task",
      "  customVerticals:",
      "    enabled: true",
      ""
    ]);
    writeUserSettings(rootDir, { schema: "user-settings/v1", devMode: {} });

    const malformedProjectFirst = runJson(rootDir, ["new-task", "--title", "Project Error First"], false);
    assert.equal(malformedProjectFirst.error.code, "harness_settings_invalid");
  });

  withTempRoot((rootDir) => {
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  locale: zh-CN",
      "  defaultVertical: custom/acme",
      "  defaultPreset: standard-task",
      "  defaultProfile: baseline",
      "  customVerticals:",
      "    enabled: true",
      ""
    ]);

    const custom = runJson(rootDir, ["new-task", "--title", "Custom Vertical"], false);
    assert.equal(custom.error.code, "custom_vertical_user_dev_mode_required");
  });
});

test("CLI custom vertical gates require user dev mode and project gate", () => {
  withTempRoot((rootDir) => {
    const missingBoth = runJson(rootDir, ["new-task", "--title", "Custom Missing Both", "--vertical", "custom/acme"], false);
    assert.equal(missingBoth.error.code, "custom_vertical_user_dev_mode_required");
  });

  withTempRoot((rootDir) => {
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  locale: zh-CN",
      "  defaultVertical: custom/acme",
      "  defaultPreset: standard-task",
      "  customVerticals:",
      "    enabled: true",
      ""
    ]);

    const missingUser = runJson(rootDir, ["new-task", "--title", "Project Gate Only"], false);
    assert.equal(missingUser.error.code, "custom_vertical_user_dev_mode_required");
  });

  withTempRoot((rootDir) => {
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  locale: zh-CN",
      "  defaultVertical: custom/acme",
      "  defaultPreset: standard-task",
      "  customVerticals:",
      "    enabled: false",
      ""
    ]);
    writeUserSettings(rootDir, { schema: "user-settings/v1", devMode: { customVerticals: true } });

    const missingProject = runJson(rootDir, ["new-task", "--title", "User Gate Only"], false);
    assert.equal(missingProject.error.code, "custom_vertical_project_gate_required");
  });

  withTempRoot((rootDir) => {
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  locale: zh-CN",
      "  defaultVertical: custom/acme",
      "  defaultPreset: missing-preset",
      "  customVerticals:",
      "    enabled: true",
      ""
    ]);
    writeUserSettings(rootDir, { schema: "user-settings/v1", devMode: { customVerticals: true } });

    const bothGates = runJson(rootDir, ["new-task", "--title", "Both Gates"], false);
    assert.equal(bothGates.error.code, "custom_vertical_contract_missing");
    assert.equal(existsSync(path.join(rootDir, "harness/planning/tasks")), false);
  });
});

test("CLI custom vertical gate ignores private harness context", () => {
  withTempRoot((rootDir) => {
    writePrivateHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  locale: zh-CN",
      "  defaultVertical: custom/private",
      "  defaultPreset: missing-preset",
      "  customVerticals:",
      "    enabled: true",
      ""
    ]);
    writeUserSettings(rootDir, { schema: "user-settings/v1", devMode: { customVerticals: true } });

    const privateConfigIgnored = runJson(rootDir, ["new-task", "--title", "Private Config Ignored", "--vertical", "custom/acme"], false);
    assert.equal(privateConfigIgnored.error.code, "custom_vertical_project_gate_required");
  });
});

test("CLI user dev mode stays local and does not affect bundled coding paths", () => {
  withTempRoot((rootDir) => {
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  locale: en-US",
      "  defaultVertical: software/coding",
      "  defaultPreset: standard-task",
      "  customVerticals:",
      "    enabled: true",
      ""
    ]);
    writeUserSettings(rootDir, { schema: "user-settings/v1", devMode: { customVerticals: true } });

    const created = runJson(rootDir, ["new-task", "--title", "Coding With Dev Mode"]);
    assert.equal(created.report.vertical, "software/coding");
    assert.match(readFileSync(path.join(rootDir, created.packagePath, "task_plan.md"), "utf8"), /Describe the verifiable result/);
  });

  withTempRoot((rootDir) => {
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  locale: zh-CN",
      "  defaultVertical: default",
      "  defaultPreset: default",
      "  customVerticals:",
      "    enabled: true",
      ""
    ]);
    writeUserSettings(rootDir, { schema: "user-settings/v1", devMode: { customVerticals: true } });

    const generic = runJson(rootDir, ["new-task", "--title", "Still Generic"]);
    assert.equal(generic.report, undefined);
  });

  withTempRoot((rootDir) => {
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  locale: zh-CN",
      "  defaultVertical: custom/acme",
      "  defaultPreset: standard-task",
      "  customVerticals:",
      "    enabled: true",
      ""
    ]);
    writeUserSettings(rootDir, { schema: "user-settings/v1", devMode: { customVerticals: false } });

    const explicitCoding = runJson(rootDir, ["new-task", "--title", "Explicit Coding", "--vertical", "software/coding"]);
    assert.equal(explicitCoding.report.vertical, "software/coding");
  });
});

test("CLI custom vertical reads malformed user settings only when authorization is needed", () => {
  withTempRoot((rootDir) => {
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  locale: zh-CN",
      "  defaultVertical: software/coding",
      "  defaultPreset: standard-task",
      ""
    ]);
    writeUserSettings(rootDir, { schema: "user-settings/v1", devMode: {} });

    const coding = runJson(rootDir, ["new-task", "--title", "Coding Ignores Bad User Settings"]);
    assert.equal(coding.report.vertical, "software/coding");
  });

  withTempRoot((rootDir) => {
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  locale: zh-CN",
      "  defaultVertical: custom/acme",
      "  defaultPreset: standard-task",
      "  customVerticals:",
      "    enabled: true",
      ""
    ]);
    writeUserSettings(rootDir, { schema: "user-settings/v1", devMode: {} });

    const custom = runJson(rootDir, ["new-task", "--title", "Custom Reads Bad User Settings"], false);
    assert.equal(custom.error.code, "user_settings_invalid");
  });

  withTempRoot((rootDir) => {
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  locale: zh-CN",
      "  defaultVertical: custom/acme",
      "  defaultPreset: standard-task",
      "  customVerticals:",
      "    enabled: true",
      ""
    ]);
    writeUserSettings(rootDir, {
      schema: "user-settings/v1",
      devMode: { customVerticals: true, extra: true },
      extra: true
    });

    const extraKeys = runJson(rootDir, ["new-task", "--title", "Exact User Settings Schema"], false);
    assert.equal(extraKeys.error.code, "user_settings_invalid");
  });
});

test("CLI settings locale controls bundled materialization and metadata check", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  locale: en-US",
      "  defaultVertical: software/coding",
      "  defaultPreset: standard-task",
      "  defaultProfile: baseline",
      "  customVerticals:",
      "    enabled: false",
      ""
    ]);

    const created = runJson(rootDir, ["new-task", "--title", "English Task"]);
    const taskPlan = readFileSync(path.join(rootDir, created.packagePath, "task_plan.md"), "utf8");
    assert.match(taskPlan, /Describe the verifiable result/);

    const checked = runJson(rootDir, ["check", "--profile", "target-project", "--strict"]);
    assert.equal(checked.ok, true);
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
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settings-cli-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeRawPreset(rootDir: string, relativePath: string, manifest: Record<string, unknown>): void {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(manifest, null, 2), "utf8");
}

function writeHarnessConfig(rootDir: string, lines: ReadonlyArray<string>): void {
  const filePath = path.join(rootDir, "harness/harness.yaml");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, lines.join("\n"), "utf8");
}

function writePrivateHarnessConfig(rootDir: string, lines: ReadonlyArray<string>): void {
  const filePath = path.join(rootDir, ".harness-private/coding-agent-harness/harness.yaml");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, lines.join("\n"), "utf8");
}

function writeUserSettings(rootDir: string, value: Record<string, unknown>): void {
  const filePath = path.join(rootDir, ".harness/user-settings.json");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function makeProfiledPreset(): Record<string, unknown> {
  return {
    schema: "preset-manifest/v1",
    id: "profiled-task",
    title: "Profiled Task",
    vertical: "software/coding",
    version: "1.0.0",
    kernelVersionRange: {
      min: "1.0.0",
      maxExclusive: "2.0.0"
    },
    capabilityImports: [],
    profiles: [
      {
        id: "baseline",
        title: "Baseline",
        checkerProfile: "standard",
        templateSelections: []
      },
      {
        id: "extra",
        title: "Extra",
        checkerProfile: "standard",
        templateSelections: [{
          slot: "task.extra",
          templateRef: "template://planning/references-index@1",
          materializeAs: "extra.md",
          localePolicy: {
            prefer: "project",
            fallback: "en-US"
          }
        }]
      }
    ],
    defaultProfile: "baseline"
  };
}
