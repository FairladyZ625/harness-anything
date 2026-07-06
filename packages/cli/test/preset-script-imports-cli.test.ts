import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI process preset script entrypoint allows package-local helper imports", () => {
  withCanonicalTempRoot((rootDir) => {
    writeProcessPreset(rootDir, "local-helper", "Local Helper", "scripts/preset-action.mjs");
    writeFile(rootDir, ".harness/presets/local-helper/lib/helper.mjs", "export const helperValue = 'package-local';\n");
    writeFile(rootDir, ".harness/presets/local-helper/scripts/preset-action.mjs", [
      "#!/usr/bin/env node",
      "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "import { helperValue } from '../lib/helper.mjs';",
      "const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
      "mkdirSync(path.join(context.outputRoot, 'artifacts'), { recursive: true });",
      "writeFileSync(path.join(context.outputRoot, 'artifacts/preset-result.json'), JSON.stringify({",
      "  schema: 'script-result/v1',",
      "  ok: true,",
      "  report: { helperValue }",
      "}), 'utf8');",
      ""
    ].join("\n"));

    const result = runJson(rootDir, ["preset", "action", "local-helper", "scaffold", "--task", "task-1", "--allow-scripts"]);

    assert.equal(result.ok, true);
    assert.equal(result.report.helperValue, "package-local");
  });
});

test("CLI process preset script entrypoint blocks relative imports outside the preset package", () => {
  withTempRoot((rootDir) => {
    writeProcessPreset(rootDir, "import-escape", "Import Escape", "scripts/preset-action.mjs");
    writeFile(rootDir, ".harness/presets/shared/outside.mjs", "export const outside = 'not allowed';\n");
    writeFile(rootDir, ".harness/presets/import-escape/scripts/preset-action.mjs", [
      "#!/usr/bin/env node",
      "import { outside } from '../../shared/outside.mjs';",
      "console.log(outside);",
      ""
    ].join("\n"));

    const result = runJson(rootDir, ["preset", "action", "import-escape", "scaffold", "--task", "task-1", "--allow-scripts"], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "preset_read_scope_violation");
  });
});

function writeProcessPreset(rootDir: string, presetId: string, title: string, command: string): void {
  writeFile(rootDir, `.harness/presets/${presetId}/preset.json`, JSON.stringify({
    schema: "preset-manifest/v2",
    id: presetId,
    title,
    vertical: "software/coding",
    version: "1.0.0",
    kind: "process-action",
    kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
    capabilityImports: [],
    entrypoints: {
      scaffold: { type: "script", command, writes: ["{{outputRoot}}/**"] }
    },
    profiles: [{
      id: "baseline",
      title: "Baseline",
      checkerProfile: "standard",
      templateSelections: []
    }],
    defaultProfile: "baseline"
  }, null, 2));
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const output = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8"
    });
    const parsed = JSON.parse(output) as Record<string, any>;
    if (expectSuccess) assert.equal(parsed.ok, true, output);
    return unwrapCommandReceipt(parsed);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "harness-preset-imports-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function withCanonicalTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-preset-imports-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeFile(rootDir: string, relativePath: string, body: string): void {
  const target = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}
