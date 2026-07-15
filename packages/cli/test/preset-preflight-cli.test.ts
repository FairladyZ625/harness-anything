// harness-test-tier: integration
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runJson, withTempRoot, writeFile } from "./helpers/preset-script-fixtures.ts";

test("validate, check, audit, and install share executable package preflight receipts", () => {
  withTempRoot((rootDir) => {
    const sourceManifest = path.join(rootDir, "source/missing-script/preset.json");
    const manifest = legacyManifest("missing-script", {
      check: {
        type: "script",
        command: "scripts/check.mjs",
        writes: ["{{outputRoot}}/**"]
      }
    });
    writeFile(rootDir, "source/missing-script/preset.json", JSON.stringify(manifest, null, 2));
    writeFile(rootDir, ".harness/presets/missing-script/preset.json", JSON.stringify(manifest, null, 2));

    const validated = runJson(rootDir, ["preset", "validate", sourceManifest], false);
    const checked = runJson(rootDir, ["preset", "check", "missing-script"], false);
    const audited = runJson(rootDir, ["preset", "audit"], false);
    const installed = runJson(rootDir, ["preset", "install", path.dirname(sourceManifest), "--project"], false);

    for (const result of [validated, checked, installed]) {
      assert.equal(result.preset.valid, false);
      assert.equal(result.issues.some((issue: Record<string, unknown>) => issue.code === "preset_entrypoint_script_missing"), true);
      assert.equal(result.report.preflight.schema, "preset-preflight-receipt/v1");
      assert.equal(result.report.preflight.runtimeSmoke.ok, false);
      assert.match(result.error.hint, /not runnable/u);
    }
    assert.equal(audited.report.preflights.some((receipt: Record<string, unknown>) => receipt.schema === "preset-preflight-receipt/v1"), true);
    assert.equal(audited.issues.some((issue: Record<string, unknown>) => issue.code === "preset_entrypoint_script_missing"), true);
  });
});

test("validate now runs smoke and legacy packages retain their adapter warning", () => {
  withTempRoot((rootDir) => {
    const sourceManifest = path.join(rootDir, "source/smoke-success/preset.json");
    writeFile(rootDir, "source/smoke-success/preset.json", JSON.stringify(legacyManifest("smoke-success", {}), null, 2));

    const validated = runJson(rootDir, ["preset", "validate", sourceManifest]);
    assert.equal(validated.ok, true);
    assert.equal(validated.preset.id, "smoke-success");
    assert.equal(validated.report.preflight.runtimeSmoke.ok, true);
    assert.deepEqual(validated.report.preflight.runtimeSmoke.entrypoints, []);
    assert.equal(validated.warnings.some((warning: Record<string, unknown>) => warning.code === "legacy-physical-scope"), true);
  });
});

test("validate and check reject an installed package shell after its script is removed", () => {
  withTempRoot((rootDir) => {
    const sourceManifest = path.join(rootDir, "source/removed-script/preset.json");
    const manifest = legacyManifest("removed-script", {
      check: { type: "script", command: "scripts/check.mjs", writes: ["{{outputRoot}}/**"] }
    });
    const script = [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.HARNESS_SCRIPT_RESULT, JSON.stringify({ schema: 'script-result/v1', ok: true, report: {}, produced: [] }));",
      ""
    ].join("\n");
    writeFile(rootDir, "source/removed-script/preset.json", JSON.stringify(manifest, null, 2));
    writeFile(rootDir, "source/removed-script/scripts/check.mjs", script);
    writeFile(rootDir, ".harness/presets/removed-script/preset.json", JSON.stringify(manifest, null, 2));
    writeFile(rootDir, ".harness/presets/removed-script/scripts/check.mjs", script);
    assert.equal(runJson(rootDir, ["preset", "validate", sourceManifest]).ok, true);
    assert.equal(runJson(rootDir, ["preset", "check", "removed-script"]).ok, true);

    rmSync(path.join(rootDir, "source/removed-script/scripts/check.mjs"));
    rmSync(path.join(rootDir, ".harness/presets/removed-script/scripts/check.mjs"));
    const validated = runJson(rootDir, ["preset", "validate", sourceManifest], false);
    const checked = runJson(rootDir, ["preset", "check", "removed-script"], false);

    for (const result of [validated, checked]) {
      assert.equal(result.ok, false);
      assert.equal(result.issues[0].code, "preset_entrypoint_script_missing");
    }
  });
});

test("v3 validate fails closed on missing semantic providers without raw-fs fallback", () => {
  withTempRoot((rootDir) => {
    const sourceManifest = path.join(rootDir, "source/v3-provider/preset.json");
    writeFile(rootDir, "source/v3-provider/preset.json", JSON.stringify(v3Manifest(), null, 2));
    writeFile(rootDir, "source/v3-provider/scripts/check.mjs", "console.log('semantic host must not execute this script during Phase 0');\n");

    const validated = runJson(rootDir, ["preset", "validate", sourceManifest], false);
    assert.equal(validated.preset.valid, false);
    assert.equal(validated.issues.some((issue: Record<string, unknown>) => issue.code === "capability_provider_missing"), true);
    assert.equal(validated.report.preflight.semanticFailureFallback, "forbidden");
    assert.equal(validated.report.preflight.entrypoints[0].capabilities[0].provider, "missing");
    assert.match(validated.error.hint, /raw-fs is not an automatic fallback/u);
  });
});

test("v3 check exposes denied raw-fs as an auditable badge and receipt", () => {
  withTempRoot((rootDir) => {
    const manifest = v3Manifest();
    manifest.id = "raw-fs-badge";
    const check = (manifest.entrypoints as Record<string, Record<string, unknown>>).check;
    check.requires = [];
    check.sideEffects = [{
      effect: "raw-fs",
      id: "source-scan",
      access: "read",
      scopes: [{ root: "project", pattern: "packages/**" }],
      justification: "The source syntax is not represented by a semantic projection.",
      approval: {
        owner: "person_zeyu",
        decisionRef: "dec_RAWFSBADGE",
        policyGrant: "raw-fs/source-scan",
        expiresAt: "2026-08-01T00:00:00Z"
      }
    }];
    writeFile(rootDir, ".harness/presets/raw-fs-badge/preset.json", JSON.stringify(manifest, null, 2));

    const checked = runJson(rootDir, ["preset", "check", "raw-fs-badge"], false);
    assert.equal(checked.preset.badges[0].kind, "raw-fs");
    assert.equal(checked.preset.badges[0].status, "denied");
    const escapeHatch = checked.report.preflight.entrypoints[0].escapeHatches[0];
    assert.deepEqual(escapeHatch.originalScopes, [{ root: "project", pattern: "packages/**" }]);
    assert.deepEqual(escapeHatch.normalizedScopeCeiling, ["project:packages/**"]);
    assert.equal(escapeHatch.policyGrant, "raw-fs/source-scan");
    assert.equal(escapeHatch.denialCodes.includes("raw_fs_grant_missing"), true);
  });
});

function legacyManifest(id: string, entrypoints: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "preset-manifest/v2",
    id,
    title: id,
    vertical: "software/coding",
    version: "1.0.0",
    kind: "process-action",
    kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
    capabilityImports: [],
    entrypoints,
    profiles: [{ id: "baseline", title: "Baseline", checkerProfile: "standard", completionGates: [], templateSelections: [] }],
    defaultProfile: "baseline"
  };
}

function v3Manifest(): Record<string, unknown> {
  return {
    schema: "preset-manifest/v3",
    id: "v3-provider",
    title: "V3 Provider",
    vertical: "software/coding",
    version: "1.0.0",
    kind: "process-action",
    kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
    capabilityImports: [],
    entrypoints: {
      check: {
        type: "script",
        command: "scripts/check.mjs",
        intent: { verb: "check", subject: "provider-readiness" },
        inputs: { sourcePack: { type: "string", required: true } },
        requires: [{ capability: "external-source-pack", version: "1", select: { packFrom: "sourcePack", view: "files-with-provenance" } }],
        produces: [],
        sideEffects: []
      }
    },
    profiles: [{ id: "baseline", title: "Baseline", checkerProfile: "standard", completionGates: [], templateSelections: [] }],
    defaultProfile: "baseline"
  };
}
