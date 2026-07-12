// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PRESET_POLICY_SCHEMA_CREATE_MILESTONE } from "../src/commands/extensions/preset-policy.ts";
import { executeScript } from "../src/commands/extensions/script-executor.ts";
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
          enforcement: "fail"
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

test("policy envelope capability can be reused by a non-native preset id", () => {
  withCanonicalTempRoot((rootDir) => {
    writePolicyCapturePreset(rootDir, "policy-envelope-mock", `{{paths.authoredRoot}}/policies/presets/policy-envelope-mock.policy.json`, [
      { id: PRESET_POLICY_SCHEMA_CREATE_MILESTONE, kind: "command", version: "1", required: true }
    ]);
    writeFile(rootDir, "harness/policies/presets/policy-envelope-mock.policy.json", JSON.stringify({
      schema: "preset-policy/create-milestone/v1",
      presetId: "policy-envelope-mock",
      rules: {
        requiredArtifacts: [
          { id: "overview", role: "overview", root: "milestones", path: "{{line}}/{{slug}}/00-overview.md" },
          { id: "index", role: "index", root: "milestones", path: "00-roadmap.md" },
          { id: "machine-summary", role: "machine-summary", root: "milestones", path: "dossier-data.md" }
        ]
      }
    }));

    const result = runJson(rootDir, [
      "preset", "action", "policy-envelope-mock", "capture", "--task", "task-policy-mock", "--allow-scripts",
      "--input", "line=platform", "--input", "slug=pilot"
    ]);

    assert.equal(result.report.policy.presetId, "policy-envelope-mock");
    assert.equal(result.report.policy.schema, "preset-policy/create-milestone/v1");
  });
});

test("host and preset runner reject the same conflicting vertical policy owners", () => {
  withCanonicalTempRoot((rootDir) => {
    const sharedCapability = "vertical:software-coding:repository-audit";
    for (const presetId of ["policy-owner-a", "policy-owner-b"]) {
      writePolicyCapturePreset(rootDir, presetId, undefined, [
        { id: sharedCapability, kind: "checker", version: "1", required: true },
        { id: PRESET_POLICY_SCHEMA_CREATE_MILESTONE, kind: "command", version: "1", required: true }
      ]);
      writeFile(rootDir, `harness/policies/presets/${presetId}.policy.json`, JSON.stringify({
        schema: "preset-policy/create-milestone/v1",
        presetId,
        rules: {}
      }));
    }

    const host = runJson(rootDir, ["script", "run", sharedCapability], false);
    const runner = runJson(rootDir, [
      "preset", "action", "policy-owner-a", "capture", "--task", "task-policy-conflict", "--allow-scripts"
    ], false);

    assert.equal(host.ok, false);
    assert.equal(runner.ok, false);
    assert.deepEqual(runner.error, host.error);
  });
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

test("ScriptExecutor classifies a filesystem read outside its permission scope", () => {
  withCanonicalTempRoot((rootDir) => {
    const evidenceDir = path.join(rootDir, "evidence");
    const outputRoot = path.join(rootDir, "output");
    const forbiddenPath = path.join(rootDir, "forbidden.txt");
    const scriptPath = path.join(rootDir, "read-outside.cjs");
    mkdirSync(evidenceDir, { recursive: true });
    mkdirSync(outputRoot, { recursive: true });
    writeFileSync(forbiddenPath, "private\n", "utf8");
    writeFileSync(scriptPath, [
      "const { readFileSync } = require('node:fs');",
      `readFileSync(${JSON.stringify(forbiddenPath)}, 'utf8');`,
      ""
    ].join("\n"), "utf8");

    const result = executeScript({
      scriptPath,
      cwd: rootDir,
      evidenceDir,
      outputRoot,
      readPermissions: [scriptPath],
      writePermissions: [outputRoot],
      env: {},
      artifactRoots: [outputRoot],
      outputBoundary: { kind: "roots", roots: [outputRoot], inspect: "generated" }
    });

    assert.equal(result.ok, false);
    assert.equal(result.failure, "read-scope-violation");
  });
});

test("ScriptExecutor classifies a filesystem write outside its permission scope", () => {
  withCanonicalTempRoot((rootDir) => {
    const evidenceDir = path.join(rootDir, "evidence");
    const outputRoot = path.join(rootDir, "output");
    const forbiddenPath = path.join(rootDir, "escaped.txt");
    const scriptPath = path.join(rootDir, "write-outside.cjs");
    mkdirSync(evidenceDir, { recursive: true });
    mkdirSync(outputRoot, { recursive: true });
    writeFileSync(scriptPath, [
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(forbiddenPath)}, 'escaped', 'utf8');`,
      ""
    ].join("\n"), "utf8");

    const result = executeScript({
      scriptPath,
      cwd: rootDir,
      evidenceDir,
      outputRoot,
      readPermissions: [scriptPath],
      writePermissions: [outputRoot],
      env: {},
      artifactRoots: [outputRoot],
      outputBoundary: { kind: "roots", roots: [outputRoot], inspect: "generated" }
    });

    assert.equal(result.ok, false);
    assert.equal(result.failure, "write-scope-violation");
  });
});

test("ScriptExecutor diffs generated artifacts and registers machine evidence", () => {
  withCanonicalTempRoot((rootDir) => {
    const evidenceDir = path.join(rootDir, "evidence");
    const outputRoot = path.join(rootDir, "output");
    const artifactsRoot = path.join(outputRoot, "artifacts");
    const scriptPath = path.join(rootDir, "write-evidence.cjs");
    const evidencePath = path.join(artifactsRoot, "evidence.json");
    mkdirSync(evidenceDir, { recursive: true });
    mkdirSync(artifactsRoot, { recursive: true });
    writeFileSync(path.join(artifactsRoot, "existing.json"), "{}\n", "utf8");
    writeFileSync(scriptPath, [
      "const { writeFileSync } = require('node:fs');",
      "const path = require('node:path');",
      "writeFileSync(path.join(process.env.OUTPUT_ROOT, 'artifacts/evidence.json'), '{\"ok\":true}\\n', 'utf8');",
      ""
    ].join("\n"), "utf8");

    const result = executeScript({
      scriptPath,
      cwd: rootDir,
      evidenceDir,
      outputRoot,
      readPermissions: [scriptPath],
      writePermissions: [outputRoot, `${outputRoot}/**`],
      env: { OUTPUT_ROOT: outputRoot },
      artifactRoots: [outputRoot],
      outputBoundary: { kind: "roots", roots: [outputRoot], inspect: "generated" }
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.generated, [evidencePath]);
    const registry = JSON.parse(readFileSync(path.join(artifactsRoot, ".machine-evidence.registry.json"), "utf8"));
    assert.deepEqual(registry.entries.map((entry: Record<string, unknown>) => entry.path), ["artifacts/evidence.json"]);
  });
});

test("ScriptExecutor registers overwritten machine evidence without re-registering untouched files", () => {
  withCanonicalTempRoot((rootDir) => {
    const evidenceDir = path.join(rootDir, "evidence");
    const outputRoot = path.join(rootDir, "output");
    const artifactsRoot = path.join(outputRoot, "artifacts");
    const scriptPath = path.join(rootDir, "write-snapshot.cjs");
    const snapshotPath = path.join(artifactsRoot, "gate-retro.snapshot.json");
    const registryPath = path.join(artifactsRoot, ".machine-evidence.registry.json");
    mkdirSync(evidenceDir, { recursive: true });
    mkdirSync(artifactsRoot, { recursive: true });
    writeFileSync(snapshotPath, "{\"version\":1}\n", "utf8");
    writeFileSync(scriptPath, [
      "const { writeFileSync } = require('node:fs');",
      "const path = require('node:path');",
      "writeFileSync(path.join(process.env.OUTPUT_ROOT, 'artifacts/gate-retro.snapshot.json'), process.env.SNAPSHOT, 'utf8');",
      ""
    ].join("\n"), "utf8");

    const execute = (snapshot: string) => executeScript({
      scriptPath,
      cwd: rootDir,
      evidenceDir,
      outputRoot,
      readPermissions: [scriptPath],
      writePermissions: [outputRoot, `${outputRoot}/**`],
      env: { OUTPUT_ROOT: outputRoot, SNAPSHOT: snapshot },
      artifactRoots: [outputRoot],
      outputBoundary: { kind: "roots", roots: [outputRoot], inspect: "generated" }
    });

    const overwritten = execute("{\"version\":2}\n");
    assert.equal(overwritten.ok, true);
    assert.deepEqual(overwritten.generated, [snapshotPath]);
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.deepEqual(registry.entries.map((entry: Record<string, unknown>) => entry.path), ["artifacts/gate-retro.snapshot.json"]);
    assert.notEqual(registry.entries[0].sha256, "sha256:missing");

    utimesSync(registryPath, new Date(0), new Date(0));
    const untouched = execute("{\"version\":2}\n");
    assert.equal(untouched.ok, true);
    assert.deepEqual(untouched.generated, []);
    assert.equal(statSync(registryPath).mtimeMs, 0);
  });
});

test("ScriptExecutor rejects generated files outside the declared output boundary", () => {
  withCanonicalTempRoot((rootDir) => {
    const evidenceDir = path.join(rootDir, "evidence");
    const outputRoot = path.join(rootDir, "output");
    const allowedRoot = path.join(outputRoot, "allowed");
    const scriptPath = path.join(rootDir, "write-undeclared.cjs");
    mkdirSync(evidenceDir, { recursive: true });
    mkdirSync(allowedRoot, { recursive: true });
    writeFileSync(scriptPath, [
      "const { writeFileSync } = require('node:fs');",
      "const path = require('node:path');",
      "writeFileSync(path.join(process.env.OUTPUT_ROOT, 'undeclared.json'), '{}\\n', 'utf8');",
      ""
    ].join("\n"), "utf8");

    const result = executeScript({
      scriptPath,
      cwd: rootDir,
      evidenceDir,
      outputRoot,
      readPermissions: [scriptPath],
      writePermissions: [outputRoot, `${outputRoot}/**`],
      env: { OUTPUT_ROOT: outputRoot },
      artifactRoots: [outputRoot],
      outputBoundary: { kind: "roots", roots: [allowedRoot], inspect: "generated" }
    });

    assert.equal(result.ok, false);
    assert.equal(result.failure, "produced-outside-boundary");
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
        completionGates: [],
      templateSelections: []
    }],
    defaultProfile: "baseline"
  }, null, 2));
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const output = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: { ...process.env, HARNESS_ACTOR: "agent:test" }
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

type CapturePresetCapability = {
  readonly id: string;
  readonly kind: "checker" | "scaffold" | "projection" | "command" | "template";
  readonly version: string;
  readonly required: boolean;
};

const policyPresetCapabilities: Record<string, ReadonlyArray<CapturePresetCapability>> = {
  "create-milestone": [{ id: PRESET_POLICY_SCHEMA_CREATE_MILESTONE, kind: "command", version: "1", required: true }],
  "milestone-closeout": [{ id: "policy:closeout-boundary/v1", kind: "command", version: "1", required: true }],
  "decision-conformance": [{ id: "policy:decision-conformance-rules/v1", kind: "command", version: "1", required: true }]
};

function writePolicyCapturePreset(
  rootDir: string,
  id: string,
  policyPath = `{{paths.authoredRoot}}/policies/presets/${id}.policy.json`,
  capabilityImports: ReadonlyArray<CapturePresetCapability> = policyPresetCapabilities[id] ?? []
): void {
  writeFile(rootDir, `.harness/presets/${id}/preset.json`, JSON.stringify({
    schema: "preset-manifest/v2",
    id,
    title: "Policy Capture",
    vertical: "software/coding",
    version: "1.0.0",
    kind: "process-action",
    policyPath,
    kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
    capabilityImports,
    entrypoints: { capture: { type: "script", command: "scripts/capture.mjs", writes: ["{{outputRoot}}/**"] } },
    profiles: [{ id: "baseline", title: "Baseline", checkerProfile: "standard", completionGates: [], templateSelections: [] }],
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

test("CLI preset run scripted success emits a contract-complete receipt", () => {
  withCanonicalTempRoot((rootDir) => {
    writeProcessPreset(rootDir, "run-receipt", "Run Receipt", "scripts/preset-action.mjs");
    writeFile(rootDir, ".harness/presets/run-receipt/scripts/preset-action.mjs", [
      "#!/usr/bin/env node",
      "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
      "mkdirSync(path.join(context.outputRoot, 'artifacts'), { recursive: true });",
      "writeFileSync(path.join(context.outputRoot, 'artifacts/preset-result.json'), JSON.stringify({",
      "  schema: 'script-result/v1',",
      "  ok: true,",
      "  rows: 2,",
      "  report: { schema: 'run-receipt-report/v1' }",
      "}), 'utf8');",
      ""
    ].join("\n"));

    const result = runJson(rootDir, ["preset", "run", "run-receipt", "scaffold", "--task", "task-1", "--allow-scripts"]);

    assert.equal(result.ok, true);
    assert.equal(result.taskId, "task-1");
    assert.equal(result.rows, 2);
    assert.equal(result.report.schema, "run-receipt-report/v1");
  });
});

test("CLI preset run scripted success without rows still passes the receipt contract", () => {
  withCanonicalTempRoot((rootDir) => {
    writeProcessPreset(rootDir, "run-no-rows", "Run No Rows", "scripts/preset-action.mjs");
    writeFile(rootDir, ".harness/presets/run-no-rows/scripts/preset-action.mjs", [
      "#!/usr/bin/env node",
      "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
      "mkdirSync(path.join(context.outputRoot, 'artifacts'), { recursive: true });",
      "writeFileSync(path.join(context.outputRoot, 'artifacts/preset-result.json'), JSON.stringify({",
      "  schema: 'script-result/v1',",
      "  ok: true,",
      "  report: { schema: 'run-no-rows-report/v1' }",
      "}), 'utf8');",
      ""
    ].join("\n"));

    const result = runJson(rootDir, ["preset", "run", "run-no-rows", "scaffold", "--task", "task-1", "--allow-scripts"]);

    assert.equal(result.ok, true);
    assert.equal(result.taskId, "task-1");
    assert.equal(result.rows, undefined);
  });
});
