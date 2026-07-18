// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const bundledPresetIndexPath = path.resolve("packages/cli/src/commands/extensions/assets/software-coding/presets/index.json");

test("CLI preset summaries load PRESET.md frontmatter", () => {
  withTempRoot((rootDir) => {
    const presetRoot = ".harness/presets/custom-task";
    writePreset(rootDir, `${presetRoot}/preset.json`, "custom-task", "Custom Task");
    writeFile(rootDir, `${presetRoot}/PRESET.md`, [
      "---",
      "schema: preset-document/v1",
      "description: Prepare a custom implementation task.",
      "whenToUse: Use when the standard task shape needs project-specific guidance.",
      "inputs:",
      "  scope: Describe the implementation boundary.",
      "entrypoints:",
      "  plan: ha preset run custom-task plan --task <task-id>",
      "---",
      "",
      "# Custom Task",
      ""
    ].join("\n"));

    const listed = runJson(rootDir, ["preset", "list"]);
    const custom = listed.presets.find((preset: Record<string, unknown>) => preset.id === "custom-task");
    assert.equal(custom.description, "Prepare a custom implementation task.");
    assert.equal(custom.whenToUse, "Use when the standard task shape needs project-specific guidance.");
    assert.equal(custom.warningCount, 0);
    assert.equal(listed.warnings.some((warning: Record<string, unknown>) => warning.code === "preset_document_invalid"), false);
  });
});

test("CLI preset list text prints one semantic row per bundled preset", () => {
  withTempRoot((rootDir) => {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "preset", "list"], {
      encoding: "utf8",
      env: { ...process.env, HARNESS_DAEMON_MODE: "fixture" }
    });
    const rows = stdout.trim().split("\n");
    const bundledPresetIndex = JSON.parse(readFileSync(bundledPresetIndexPath, "utf8")) as { readonly presets: ReadonlyArray<string> };
    assert.equal(rows.length, bundledPresetIndex.presets.length);
    assert.equal(rows.every((row) => row.split(" — ").length === 3), true);
    assert.equal(rows.some((row) => row.startsWith("standard-task — Standard Task — Create the standard planning")), true);
  });
});

test("CLI preset summaries warn and fall back to title when PRESET.md is missing or invalid", () => {
  withTempRoot((rootDir) => {
    writePreset(rootDir, ".harness/presets/missing-doc/preset.json", "missing-doc", "Missing Document");
    writePreset(rootDir, ".harness/presets/invalid-doc/preset.json", "invalid-doc", "Invalid Document");
    writeFile(rootDir, ".harness/presets/invalid-doc/PRESET.md", [
      "---",
      "schema: preset-document/v1",
      "description:",
      "---",
      ""
    ].join("\n"));

    const listed = runJson(rootDir, ["preset", "list"]);
    const missing = listed.presets.find((preset: Record<string, unknown>) => preset.id === "missing-doc");
    const invalid = listed.presets.find((preset: Record<string, unknown>) => preset.id === "invalid-doc");
    assert.equal(missing.description, "Missing Document");
    assert.equal(missing.whenToUse, null);
    assert.equal(missing.valid, true);
    assert.equal(missing.warningCount, 1);
    assert.equal(invalid.description, "Invalid Document");
    assert.equal(invalid.valid, true);
    assert.equal(invalid.warningCount, 1);
    assert.equal(listed.warnings.some((warning: Record<string, unknown>) => warning.code === "preset_document_missing"), true);
    assert.equal(listed.warnings.some((warning: Record<string, unknown>) => warning.code === "preset_document_invalid"), true);

    const created = runJson(rootDir, ["new-task", "--title", "Compatibility Task", "--preset", "missing-doc"]);
    assert.equal(created.ok, true);
    assert.equal(created.warnings.some((warning: Record<string, unknown>) => warning.code === "preset_document_missing"), true);
  });
});

function runJson(rootDir: string, args: ReadonlyArray<string>): Record<string, any> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: { ...process.env, HARNESS_DAEMON_MODE: "fixture" }
  });
  return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-doc-"));
  ensureTestHarnessIdentity(rootDir);
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writePreset(rootDir: string, relativePath: string, id: string, title: string): void {
  writeFile(rootDir, relativePath, JSON.stringify({
    schema: "preset-manifest/v1",
    id,
    title,
    vertical: "software/coding",
    version: "1.0.0",
    kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
    capabilityImports: [],
    profiles: [{ id: "baseline", title: "Baseline", checkerProfile: "standard", templateSelections: [] }],
    defaultProfile: "baseline"
  }, null, 2));
}

function writeFile(rootDir: string, relativePath: string, body: string): void {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, "utf8");
}
