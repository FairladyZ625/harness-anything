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

test("preset runner injects each strict v1 policy and runtime input cannot override policyPath", () => {
  const fixtures = [
    {
      id: "create-milestone",
      document: {
        schema: "preset-policy/create-milestone/v1",
        presetId: "create-milestone",
        rules: {
          charterAnchor: { required: true, entityType: "decision", idPattern: "^dec_[A-Za-z0-9_]+$" },
          requiredSections: ["gate-retro", "fact-evidence"],
          additionalReferences: [{ kind: "command", ref: "npm run pr:doctor", label: "PR diagnostics" }]
        }
      }
    },
    {
      id: "milestone-closeout",
      document: {
        schema: "preset-policy/milestone-closeout/v1",
        presetId: "milestone-closeout",
        rules: {
          requireLoadBearingClaimCoverage: true,
          boundary: { kind: "root-task-subtree", rootTaskInput: "milestoneRootTaskId" },
          evidenceMode: "typed-canonical-projection"
        }
      }
    },
    {
      id: "decision-conformance",
      document: {
        schema: "preset-policy/decision-conformance/v1",
        presetId: "decision-conformance",
        rules: {
          adoptionCutoff: "2026-07-06T23:21:56.224Z",
          legacyExemptions: [{ kind: "decided-before-cutoff" }, { kind: "missing-decided-at-with-legacy-id" }],
          proposedMaxAgeDays: 14,
          hardFail: true
        }
      }
    }
  ] as const;

  for (const fixture of fixtures) {
    withCanonicalTempRoot((rootDir) => {
      writePolicyCapturePreset(rootDir, fixture.id);
      writeFile(rootDir, `harness/policies/presets/${fixture.id}.policy.json`, JSON.stringify(fixture.document));
      const result = runJson(rootDir, [
        "preset", "action", fixture.id, "capture", "--task", "task-policy", "--allow-scripts",
        "--input", "policyPath=ignored.json"
      ]);

      assert.equal(result.report.policy.presetId, fixture.id);
      assert.equal(result.report.policy.schema, fixture.document.schema);
      assert.equal(result.report.policy.sourcePath, `harness/policies/presets/${fixture.id}.policy.json`);
      assert.equal(result.report.runtimePolicyPath, "ignored.json");
    });
  }
});

test("missing policy is public-default null while malformed, unknown-key, wrong-preset, and escape fixtures fail closed", () => {
  withCanonicalTempRoot((rootDir) => {
    writePolicyCapturePreset(rootDir, "create-milestone");
    const missing = runJson(rootDir, ["preset", "action", "create-milestone", "capture", "--task", "task-missing", "--allow-scripts"]);
    assert.equal(missing.report.policy, null);
  });

  const invalidFixtures = [
    { name: "malformed", body: "{", code: "preset_policy_invalid" },
    {
      name: "unknown-key",
      body: JSON.stringify({ schema: "preset-policy/create-milestone/v1", presetId: "create-milestone", rules: { surprise: true } }),
      code: "preset_policy_invalid"
    },
    {
      name: "wrong-preset",
      body: JSON.stringify({ schema: "preset-policy/decision-conformance/v1", presetId: "decision-conformance", rules: {} }),
      code: "preset_policy_invalid"
    },
    {
      name: "version-mismatch",
      body: JSON.stringify({ schema: "preset-policy/create-milestone/v2", presetId: "create-milestone", rules: {} }),
      code: "preset_policy_invalid"
    }
  ];
  for (const fixture of invalidFixtures) {
    withCanonicalTempRoot((rootDir) => {
      writePolicyCapturePreset(rootDir, "create-milestone");
      writeFile(rootDir, "harness/policies/presets/create-milestone.policy.json", fixture.body);
      const result = runJson(rootDir, ["preset", "action", "create-milestone", "capture", "--task", `task-${fixture.name}`, "--allow-scripts"], false);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, fixture.code);
    });
  }

  withCanonicalTempRoot((rootDir) => {
    writePolicyCapturePreset(rootDir, "create-milestone", "{{paths.authoredRoot}}/policies/presets/../create-milestone.policy.json");
    const result = runJson(rootDir, ["preset", "action", "create-milestone", "capture", "--task", "task-escape", "--allow-scripts"], false);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "preset_manifest_invalid");
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

function writePolicyCapturePreset(rootDir: string, id: string, policyPath = `{{paths.authoredRoot}}/policies/presets/${id}.policy.json`): void {
  writeFile(rootDir, `.harness/presets/${id}/preset.json`, JSON.stringify({
    schema: "preset-manifest/v2",
    id,
    title: "Policy Capture",
    vertical: "software/coding",
    version: "1.0.0",
    kind: "process-action",
    policyPath,
    kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
    capabilityImports: [],
    entrypoints: { capture: { type: "script", command: "scripts/capture.mjs", writes: ["{{outputRoot}}/**"] } },
    profiles: [{ id: "baseline", title: "Baseline", checkerProfile: "standard", templateSelections: [] }],
    defaultProfile: "baseline"
  }, null, 2));
  writeFile(rootDir, `.harness/presets/${id}/scripts/capture.mjs`, [
    "#!/usr/bin/env node",
    "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
    "const artifacts = path.join(context.outputRoot, 'artifacts');",
    "mkdirSync(artifacts, { recursive: true });",
    "writeFileSync(path.join(artifacts, 'preset-result.json'), JSON.stringify({",
    "  ok: true, report: { policy: context.policy, runtimePolicyPath: context.inputs.policyPath }, produced: []",
    "}), 'utf8');",
    ""
  ].join("\n"));
}
