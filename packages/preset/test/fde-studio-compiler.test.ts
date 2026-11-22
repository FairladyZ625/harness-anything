// harness-test-tier: fast
// dec_42EB7B8F636C12381A447E52A3/CH2: pure Vertical/Preset/Gate compiler and cross-reference rename unit tests in @harness-anything/preset.
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFdeGateCheckerScript,
  buildFdeGateResultSchema,
  compileFdeStudioDraft,
  createDefaultFdeDraft,
  renameEntityInDraft,
  renameGateInDraft,
  renamePresetInDraft,
  renameProfileInDraft,
  updateEntityInDraft,
  updateGateInDraft,
  updatePresetInDraft,
  updateProfileInDraft,
  updateVerticalIdInDraft,
} from "../src/index.ts";

test("pure rename transforms keep preset, gate, profile, and entity cross-references synchronized", () => {
  const base = createDefaultFdeDraft({
    verticalId: "ops/rename-check",
    title: "Ops Rename Check",
    defaultPresetId: "domain-task",
  });

  const renamedPreset = renamePresetInDraft(base, "domain-task", "custom-preset");
  assert.equal(renamedPreset.defaultPresetId, "custom-preset");
  assert.equal(renamedPreset.presets[0]!.presetId, "custom-preset");
  assert.equal(renamedPreset.gates[0]!.entrypoint, "custom-preset/verify-deliverable");
  assert.equal(renamedPreset.agents[0]!.preset, "custom-preset");
  assert.equal(renamedPreset.presets[0]!.templates[0]!.materializeAs, "custom-preset-brief.md");

  const renamedGate = renameGateInDraft(renamedPreset, "deliverable-contract", "deliverable-v2");
  assert.equal(renamedGate.gates[0]!.gateId, "deliverable-v2");
  assert.equal(renamedGate.gates[0]!.sourceId, "ops-rename-check/deliverable-v2");
  assert.deepEqual(renamedGate.presets[0]!.profiles[0]!.completionGates, ["deliverable-v2"]);
  assert.deepEqual(renamedGate.presets[0]!.profiles[1]!.completionGates, ["deliverable-v2"]);
  assert.deepEqual(renamedGate.presets[0]!.profiles[2]!.completionGates, []);

  const renamedProfile = renameProfileInDraft(renamedGate, "custom-preset", "verified", "renamed");
  assert.equal(renamedProfile.presets[0]!.defaultProfile, "renamed");
  assert.equal(renamedProfile.presets[0]!.profiles[0]!.id, "renamed");

  const renamedEntity = renameEntityInDraft(renamedProfile, "deliverable", "audit-packet");
  assert.equal(renamedEntity.entities[0]!.id, "audit-packet");
  assert.equal(renamedEntity.relations[0]!.sourceKind, "audit-packet");
  assert.ok(renamedEntity.livingDossier[0]!.entityKinds.includes("audit-packet"));
  assert.ok(!renamedEntity.livingDossier[0]!.entityKinds.includes("deliverable"));
});

test("index-based UI draft updaters preserve cross-references across edits and verticalId changes", () => {
  let draft = createDefaultFdeDraft({ verticalId: "finance/intake", defaultPresetId: "domain-task" });
  draft = updatePresetInDraft(draft, 0, { presetId: "custom-intake" });
  draft = updateGateInDraft(draft, 0, { gateId: "intake-v2" });
  draft = updateProfileInDraft(draft, 0, 0, { id: "strict" });
  draft = updateEntityInDraft(draft, 0, { id: "dossier-record" });
  draft = updateVerticalIdInDraft(draft, "finance/audit-intake");

  assert.equal(draft.verticalId, "finance/audit-intake");
  assert.equal(draft.slug, "finance-audit-intake");
  assert.equal(draft.defaultPresetId, "custom-intake");
  assert.equal(draft.gates[0]!.entrypoint, "custom-intake/verify-deliverable");
  assert.equal(draft.gates[0]!.sourceId, "finance-audit-intake/intake-v2");
  assert.equal(draft.presets[0]!.defaultProfile, "strict");
  assert.deepEqual(draft.presets[0]!.profiles[0]!.completionGates, ["intake-v2"]);
  assert.equal(draft.relations[0]!.sourceKind, "dossier-record");
  assert.ok(draft.livingDossier[0]!.entityKinds.includes("dossier-record"));

  // Removing the active default profile falls back to the first remaining profile.
  const withoutStrict = updatePresetInDraft(draft, 0, {
    profiles: draft.presets[0]!.profiles.slice(1),
  });
  assert.equal(withoutStrict.presets[0]!.defaultProfile, "standard");
});

test("compileFdeStudioDraft derives single-source gate entrypoints, schemas, and checker scripts", () => {
  const base = createDefaultFdeDraft({ verticalId: "ops/single-source", defaultPresetId: "domain-task" });
  // Even if defaultPresetId is changed without updating gate.entrypoint directly, compiler keeps them aligned.
  const mutated = {
    ...base,
    defaultPresetId: "custom-preset",
    presets: [{ ...base.presets[0]!, presetId: "custom-preset" }],
  };

  const plan = compileFdeStudioDraft(mutated, "/tmp/fde-preset-unit");
  assert.equal(plan.defaultPresetId, "custom-preset");
  assert.equal(plan.dossierValidation.ok, true);

  const verticalJson = JSON.parse(plan.files.find((file) => file.relativePath === "vertical.json")!.body) as {
    readonly completion: {
      readonly sources: Record<string, { readonly entrypoint?: string }>;
    };
  };
  assert.equal(
    verticalJson.completion.sources["ops-single-source/deliverable-contract"]?.entrypoint,
    "custom-preset/verify-deliverable",
  );
  assert.ok(plan.files.some((file) => file.relativePath === "presets/custom-preset/checks/verify-deliverable.mjs"));

  const schema = buildFdeGateResultSchema(base.gates[0]!);
  assert.deepEqual(schema.required, ["schema", "owner", "summary", "status", "approved"]);
  const checker = buildFdeGateCheckerScript(base.gates[0]!);
  assert.match(checker, /preset-script-result\/v1/u);
  assert.match(checker, /readPointer/u);
});
