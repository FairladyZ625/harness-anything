// harness-test-tier: contract
// dec_42EB7B8F636C12381A447E52A3/CH2: end-to-end headless GUI-FDE domain compilation, HTML sandbox preview,
// V4 positive/negative gate simulation, rename cross-reference synchronization, and scaffold persistence tests.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyPresetScaffold,
  compileStudioDraft,
  createDefaultFdeDraft,
  persistStudioDraft,
  renameEntityInDraft,
  renameGateInDraft,
  renamePresetInDraft,
  renameProfileInDraft,
  simulateStudioDraft,
  updateGateInDraft,
  updatePresetInDraft,
  updateProfileInDraft,
} from "../src/index.ts";

function makeTempDir(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ha-gui-fde-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("compiles a custom business vertical across all five FDE sections and renders zero-JS HTML previews", (t) => {
  const rootDir = makeTempDir(t);
  const draft = createDefaultFdeDraft({
    verticalId: "legal/contract-review",
    title: "Contract Review",
    defaultPresetId: "clause-audit",
    locale: "zh-CN",
  });

  const compiled = compileStudioDraft(draft, rootDir);
  assert.equal(compiled.verticalId, "legal/contract-review");
  assert.equal(compiled.slug, "legal-contract-review");
  assert.equal(compiled.relativeTargetDir, "verticals/legal-contract-review");
  assert.equal(compiled.dossierValidation.ok, true, compiled.dossierValidation.error);

  const filePaths = compiled.files.map((file) => file.relativePath);
  assert.ok(filePaths.includes("vertical.json"));
  assert.ok(filePaths.includes("presets/clause-audit/preset.json"));
  assert.ok(filePaths.includes("presets/clause-audit/templates/brief/zh-CN.md"));
  assert.ok(filePaths.includes("presets/clause-audit/templates/brief/en-US.md"));
  assert.ok(filePaths.includes("presets/clause-audit/checks/verify-deliverable.mjs"));
  assert.ok(filePaths.includes("agents/contributor.json"));
  assert.ok(filePaths.includes("agents/closeout-reviewer.json"));
  assert.ok(filePaths.includes("samples/deliverable-contract/positive.json"));
  assert.ok(filePaths.includes("samples/deliverable-contract/negative.json"));

  const verticalJson = JSON.parse(compiled.files.find((f) => f.relativePath === "vertical.json")!.body) as {
    readonly livingDossier?: { readonly slots: readonly { readonly id: string }[] };
    readonly entityKinds: readonly { readonly id: string; readonly relations?: readonly unknown[] }[];
  };
  assert.equal(verticalJson.livingDossier?.slots.length, 2);
  const deliverableKind = verticalJson.entityKinds.find((kind) => kind.id === "deliverable");
  assert.ok(deliverableKind);
  assert.equal(deliverableKind.relations?.length, 1);

  assert.match(compiled.htmlPreviews.explainerHtml, /Contract Review/u);
  assert.match(compiled.htmlPreviews.explainerHtml, /legal\/contract-review/u);
  assert.doesNotMatch(compiled.htmlPreviews.explainerHtml, /<script/iu);

  assert.match(compiled.htmlPreviews.projectAtlasHtml, /harness:living-dossier:watermark=0/u);
  assert.match(compiled.htmlPreviews.projectAtlasHtml, /project-atlas\.html/u);
  assert.doesNotMatch(compiled.htmlPreviews.projectAtlasHtml, /<script/iu);
});

test("detects invalid LivingDossier slot contracts via Kernel validateDossierSlots", (t) => {
  const rootDir = makeTempDir(t);
  const base = createDefaultFdeDraft({ verticalId: "finance/audit" });
  const invalidDraft = {
    ...base,
    livingDossier: [
      {
        ...base.livingDossier[0]!,
        path: "wrong-extension.md",
        kind: "html" as const,
      },
    ],
  };

  const compiled = compileStudioDraft(invalidDraft, rootDir);
  assert.equal(compiled.dossierValidation.ok, false);
  assert.match(compiled.dossierValidation.error ?? "", /\.html/u);
});

test("runs real V4 simulateVerticalPackage with zero ledger writes and verifies positive PASS vs negative FAIL", async (t) => {
  const rootDir = makeTempDir(t);
  const draft = createDefaultFdeDraft({
    verticalId: "procurement/review",
    title: "Procurement Review",
    defaultPresetId: "vendor-audit",
    locale: "zh-CN",
  });

  const sim = await simulateStudioDraft({ draft, rootDir, locale: "zh-CN" });
  assert.equal(sim.report.ok, true, JSON.stringify(sim.report.diagnostics, null, 2));
  assert.equal(sim.report.zeroLedgerWrites, true);
  assert.equal(sim.report.vertical.valid, true);
  assert.equal(sim.report.bootstrap.ok, true);
  assert.equal(sim.report.agents.ok, true);
  assert.ok(sim.report.previews.regularTask !== null);
  assert.ok(sim.report.previews.workTask !== null);
  assert.equal(sim.report.gates.length, 1);
  assert.equal(sim.report.gates[0]!.ok, true);
  assert.equal(sim.report.gates[0]!.positive.result, "pass");
  assert.equal(sim.report.gates[0]!.positive.ok, true);
  assert.equal(sim.report.gates[0]!.negative.result, "fail");
  assert.equal(sim.report.gates[0]!.negative.ok, true);
  assert.equal(existsSync(path.join(rootDir, "verticals")), false, "simulation must not write to workspace");

  // Mutate positive sample to violate the gate and prove V4 catches the regression.
  const brokenDraft = {
    ...draft,
    gates: [
      {
        ...draft.gates[0]!,
        positiveSampleJson: JSON.stringify({
          schema: draft.gates[0]!.artifactSchema,
          owner: "",
          summary: "Broken positive",
          status: "draft",
          approved: false,
        }),
      },
    ],
  };
  const brokenSim = await simulateStudioDraft({ draft: brokenDraft, rootDir, locale: "en-US" });
  assert.equal(brokenSim.report.ok, false);
  assert.equal(brokenSim.report.gates[0]!.positive.result, "fail");
  assert.equal(brokenSim.report.gates[0]!.positive.ok, false);
});

test("persists drafted vertical to disk and supports scaffolding an additional preset inside it", (t) => {
  const rootDir = makeTempDir(t);
  const draft = createDefaultFdeDraft({
    verticalId: "supply/intake",
    title: "Supply Intake",
    defaultPresetId: "intake-check",
  });

  const persisted = persistStudioDraft({ draft, rootDir, overwrite: false, dryRun: false });
  assert.equal(persisted.ok, true);
  assert.equal(persisted.mode, "apply");
  assert.equal(persisted.targetDir, "verticals/supply-intake");
  assert.ok(existsSync(path.join(rootDir, "verticals/supply-intake/vertical.json")));

  const writtenVertical = JSON.parse(
    readFileSync(path.join(rootDir, "verticals/supply-intake/vertical.json"), "utf8"),
  ) as { readonly id: string; readonly livingDossier?: { readonly slots: readonly unknown[] } };
  assert.equal(writtenVertical.id, "supply/intake");
  assert.equal(writtenVertical.livingDossier?.slots.length, 2);

  const extraPreset = applyPresetScaffold({
    rootDir,
    verticalId: "supply/intake",
    presetId: "supplier-scorecard",
    title: "Supplier Scorecard",
  });
  assert.equal(extraPreset.bundledInLocalVertical, true);
  assert.ok(existsSync(path.join(rootDir, "verticals/supply-intake/presets/supplier-scorecard/preset.json")));
});

test("renaming default preset, gate, profile, and entity keeps cross-references valid in live V4 simulation", async (t) => {
  const rootDir = makeTempDir(t);
  const base = createDefaultFdeDraft({
    verticalId: "ops/rename-regression",
    title: "Ops Rename Regression",
    defaultPresetId: "domain-task",
    locale: "zh-CN",
  });

  // 1. Rename default preset: domain-task -> custom-preset
  const afterPresetRename = renamePresetInDraft(base, "domain-task", "custom-preset");
  const presetSim = await simulateStudioDraft({ draft: afterPresetRename, rootDir, locale: "zh-CN" });
  assert.equal(presetSim.report.ok, true, JSON.stringify(presetSim.report.diagnostics, null, 2));
  assert.equal(presetSim.report.bootstrap.defaultPresetId, "custom-preset");
  assert.equal(presetSim.report.gates.length, 1);
  assert.equal(presetSim.report.gates[0]!.positive.result, "pass");
  assert.equal(presetSim.report.gates[0]!.negative.result, "fail");

  // 2. Rename gate: deliverable-contract -> deliverable-v2
  const afterGateRename = renameGateInDraft(base, "deliverable-contract", "deliverable-v2");
  const gateSim = await simulateStudioDraft({ draft: afterGateRename, rootDir, locale: "zh-CN" });
  assert.equal(gateSim.report.ok, true, JSON.stringify(gateSim.report.diagnostics, null, 2));
  assert.equal(gateSim.report.gates.length, 1);
  assert.equal(gateSim.report.gates[0]!.gateId, "deliverable-v2");
  assert.equal(gateSim.report.gates[0]!.positive.result, "pass");
  assert.equal(gateSim.report.gates[0]!.negative.result, "fail");

  // 3. Rename profile: verified -> renamed
  const afterProfileRename = renameProfileInDraft(base, "domain-task", "verified", "renamed");
  const profileSim = await simulateStudioDraft({ draft: afterProfileRename, rootDir, locale: "zh-CN" });
  assert.equal(profileSim.report.ok, true, JSON.stringify(profileSim.report.diagnostics, null, 2));
  assert.equal(profileSim.report.bootstrap.defaultProfileId, "renamed");
  assert.equal(profileSim.report.gates.length, 1);
  assert.equal(profileSim.report.gates[0]!.profileId, "renamed");
  assert.equal(profileSim.report.gates[0]!.positive.result, "pass");
  assert.equal(profileSim.report.gates[0]!.negative.result, "fail");

  // 4. Combined sequential UI-handler renames: preset + gate + profile + entity
  let combined = updatePresetInDraft(base, 0, { presetId: "custom-preset" });
  combined = updateGateInDraft(combined, 0, { gateId: "deliverable-v2" });
  combined = updateProfileInDraft(combined, 0, 0, { id: "renamed" });
  combined = renameEntityInDraft(combined, "deliverable", "audit-packet");
  const combinedSim = await simulateStudioDraft({ draft: combined, rootDir, locale: "en-US" });
  assert.equal(combinedSim.report.ok, true, JSON.stringify(combinedSim.report.diagnostics, null, 2));
  assert.equal(combinedSim.compiled.dossierValidation.ok, true, combinedSim.compiled.dossierValidation.error);
  assert.equal(combinedSim.report.bootstrap.defaultPresetId, "custom-preset");
  assert.equal(combinedSim.report.bootstrap.defaultProfileId, "renamed");
  assert.equal(combinedSim.report.gates.length, 1);
  assert.equal(combinedSim.report.gates[0]!.gateId, "deliverable-v2");
  assert.equal(combinedSim.report.gates[0]!.presetId, "custom-preset");
  assert.equal(combinedSim.report.gates[0]!.profileId, "renamed");
  assert.equal(combinedSim.report.gates[0]!.positive.result, "pass");
  assert.equal(combinedSim.report.gates[0]!.negative.result, "fail");
});
