// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { PresetManifest } from "../../kernel/src/index.ts";
import { resolvePresetCompletionGates } from "../src/commands/core/task-completion-contract.ts";

test("completion gate resolver accepts v2 and v3 profile contracts", () => {
  for (const schema of ["preset-manifest/v2", "preset-manifest/v3"] as const) {
    const manifest = presetManifest(schema);
    assert.deepEqual(resolvePresetCompletionGates(manifest, manifest.id), ["ci", "code-doc-reconciliation"]);
  }
});

test("completion gate resolver fails closed for schemas without the completion contract", () => {
  const manifest = presetManifest("preset-manifest/v4");
  assert.throws(
    () => resolvePresetCompletionGates(manifest, manifest.id),
    /does not declare a v2\/v3 completion contract/u
  );
});

function presetManifest(schema: string): PresetManifest {
  return {
    schema,
    id: "completion-contract-fixture",
    title: "Completion Contract Fixture",
    vertical: "software/coding",
    version: "1.0.0",
    kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
    capabilityImports: [],
    profiles: [{
      id: "baseline",
      title: "Baseline",
      checkerProfile: "standard",
      completionGates: ["ci", "code-doc-reconciliation"],
      templateSelections: []
    }],
    defaultProfile: "baseline"
  } as unknown as PresetManifest;
}
