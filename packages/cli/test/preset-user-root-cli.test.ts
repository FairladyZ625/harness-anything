import assert from "node:assert/strict";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI preset discovery honors project over user over bundled presets", () => {
  withTempRoot((rootDir) => {
    const userHome = mkdtempSync(path.join(tmpdir(), "ha-user-presets-"));
    try {
      writePreset(userHome, "presets/standard-task/preset.json", {
        id: "standard-task",
        title: "Home User Standard Task",
        version: "1.5.0"
      });
      writePreset(rootDir, ".harness/user-presets/standard-task/preset.json", {
        id: "standard-task",
        title: "Legacy User Standard Task",
        version: "1.0.0"
      });
      writePreset(rootDir, ".harness/presets/standard-task/preset.json", {
        id: "standard-task",
        title: "Project Standard Task",
        version: "2.0.0"
      });

      const result = runJson(rootDir, ["preset", "list"], true, {
        HARNESS_USER_HOME: userHome
      });

      assert.equal(result.ok, true);
      assert.equal(result.command, "preset-list");
      const standard = result.presets.find((preset: Record<string, unknown>) => preset.id === "standard-task");
      assert.equal(standard.title, "Project Standard Task");
      assert.equal(standard.layer, "project");
      assert.equal(result.presets.some((preset: Record<string, unknown>) => preset.id === "module"), true);
    } finally {
      rmSync(userHome, { recursive: true, force: true });
    }
  });
});

test("CLI preset discovery honors home user presets over legacy user-presets", () => {
  withTempRoot((rootDir) => {
    const userHome = mkdtempSync(path.join(tmpdir(), "ha-user-presets-"));
    try {
      writePreset(rootDir, ".harness/user-presets/standard-task/preset.json", {
        id: "standard-task",
        title: "Legacy User Standard Task",
        version: "1.0.0"
      });
      writePreset(userHome, "presets/standard-task/preset.json", {
        id: "standard-task",
        title: "Home User Standard Task",
        version: "1.5.0"
      });

      const result = runJson(rootDir, ["preset", "list"], true, {
        HARNESS_USER_HOME: userHome
      });

      assert.equal(result.ok, true);
      assert.equal(result.command, "preset-list");
      const standard = result.presets.find((preset: Record<string, unknown>) => preset.id === "standard-task");
      assert.equal(standard.title, "Home User Standard Task");
      assert.equal(standard.layer, "user");
    } finally {
      rmSync(userHome, { recursive: true, force: true });
    }
  });
});

test("CLI preset install/uninstall/list/audit operate in injected home user root", () => {
  withTempRoot((rootDir) => {
    const userHome = mkdtempSync(path.join(tmpdir(), "ha-user-presets-"));
    const sourceDir = path.join(rootDir, "source-preset");
    const homePresetPath = path.join(userHome, "presets", "custom-task", "preset.json");
    try {
      writePreset(sourceDir, "preset.json", {
        id: "custom-task",
        title: "Custom Task",
        version: "1.0.0"
      });

      const installed = runJson(rootDir, ["preset", "install", sourceDir], true, {
        HARNESS_USER_HOME: userHome
      });
      assert.equal(installed.ok, true);
      assert.equal(installed.command, "preset-install");
      assert.equal(installed.preset.id, "custom-task");
      assert.equal(existsSync(homePresetPath), true);

      const listed = runJson(rootDir, ["preset", "list"], true, {
        HARNESS_USER_HOME: userHome
      });
      assert.equal(listed.presets.some((preset: Record<string, unknown>) => preset.id === "custom-task" && preset.layer === "user"), true);

      const audited = runJson(rootDir, ["preset", "audit"], true, {
        HARNESS_USER_HOME: userHome
      });
      assert.equal(audited.ok, true);
      assert.equal(audited.presets.some((preset: Record<string, unknown>) => preset.id === "custom-task" && preset.layer === "user"), true);

      const removed = runJson(rootDir, ["preset", "uninstall", "custom-task"], true, {
        HARNESS_USER_HOME: userHome
      });
      assert.equal(removed.ok, true);
      assert.equal(removed.command, "preset-uninstall");
      assert.equal(existsSync(homePresetPath), false);
    } finally {
      rmSync(userHome, { recursive: true, force: true });
    }
  });
});

test("CLI missing injected home user preset root is treated as empty until install", () => {
  withTempRoot((rootDir) => {
    const userHome = mkdtempSync(path.join(tmpdir(), "ha-user-presets-"));
    const sourceDir = path.join(rootDir, "source-preset");
    const homePresetRoot = path.join(userHome, "presets");
    const homePresetPath = path.join(homePresetRoot, "custom-task", "preset.json");
    try {
      rmSync(userHome, { recursive: true, force: true });
      writePreset(sourceDir, "preset.json", {
        id: "custom-task",
        title: "Custom Task",
        version: "1.0.0"
      });

      const listed = runJson(rootDir, ["preset", "list"], true, {
        HARNESS_USER_HOME: userHome
      });
      assert.equal(listed.ok, true);
      assert.equal(existsSync(homePresetRoot), false);

      const audited = runJson(rootDir, ["preset", "audit"], true, {
        HARNESS_USER_HOME: userHome
      });
      assert.equal(audited.ok, true);
      assert.equal(existsSync(homePresetRoot), false);

      const installed = runJson(rootDir, ["preset", "install", sourceDir], true, {
        HARNESS_USER_HOME: userHome
      });
      assert.equal(installed.ok, true);
      assert.equal(installed.preset.layer, "user");
      assert.equal(existsSync(homePresetPath), true);
    } finally {
      rmSync(userHome, { recursive: true, force: true });
    }
  });
});

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true, env: NodeJS.ProcessEnv = {}): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env }
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
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

function writePreset(rootDir: string, relativePath: string, overrides: {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly templateSelections?: ReadonlyArray<Record<string, unknown>>;
}): void {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(makePreset(overrides), null, 2), "utf8");
}

function makePreset(overrides: {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly templateSelections?: ReadonlyArray<Record<string, unknown>>;
}): Record<string, unknown> {
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
      templateSelections: overrides.templateSelections ?? []
    }],
    defaultProfile: "baseline"
  };
}
