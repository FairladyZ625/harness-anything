// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIAL_SETTINGS_V1 } from "@harness-anything/kernel";
import {
  listBundledAgentDeclarationIds,
  presetUserRoot,
  resolveRepoBootstrapDefaults,
  runPresetAction,
  simulateVerticalPackage,
  type PresetScaffoldReport,
  type VerticalScaffoldReport,
  type VerticalSimulateReport,
} from "../src/index.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

function makeWorkspace(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test("vertical-init + preset-init produce a zero-manual-edit vertical that passes validate and simulate (positive PASS + negative FAIL) with zero ledger writes", async () => {
  const rootDir = makeWorkspace("ha-fde-vertical-init-");
  try {
    // 1. Dry-run vertical init leaves the directory clean.
    const dryVertical = (await runPresetAction({
      rootDir,
      action: {
        kind: "vertical-init",
        verticalId: "procurement/review",
        title: "Procurement Review",
        dryRun: true,
      },
    })) as VerticalScaffoldReport;
    assert.equal(dryVertical.schema, "vertical-scaffold-report/v1");
    assert.equal(dryVertical.mode, "dry-run");
    assert.equal(dryVertical.targetDir, "verticals/procurement-review");
    assert.equal(dryVertical.workPresetId, "work-root");
    assert.ok(dryVertical.created.length >= 25);
    assert.equal(existsSync(path.join(rootDir, "verticals/procurement-review")), false);

    // 2. Apply vertical init from an empty directory.
    const createdVertical = (await runPresetAction({
      rootDir,
      action: {
        kind: "vertical-init",
        verticalId: "procurement/review",
        title: "Procurement Review",
      },
    })) as VerticalScaffoldReport;
    assert.equal(createdVertical.mode, "apply");
    assert.equal(createdVertical.verticalId, "procurement/review");
    assert.equal(createdVertical.defaultPresetId, "domain-task");
    assert.deepEqual(createdVertical.agentIds, ["contributor", "closeout-reviewer"]);

    // 3. Idempotent overwrite protection refuses to clobber existing files unless --force.
    await assert.rejects(
      runPresetAction({
        rootDir,
        action: { kind: "vertical-init", verticalId: "procurement/review" },
      }),
      (error: unknown) => (error as { code?: string }).code === "path_exists",
    );
    const forcedVertical = (await runPresetAction({
      rootDir,
      action: { kind: "vertical-init", verticalId: "procurement/review", force: true },
    })) as VerticalScaffoldReport;
    assert.equal(forcedVertical.created.length, 0);
    assert.equal(forcedVertical.overwritten.length, createdVertical.created.length);

    // 4. Scaffold an additional preset inside the newly created vertical.
    const createdPreset = (await runPresetAction({
      rootDir,
      action: {
        kind: "preset-init",
        presetId: "vendor-check",
        verticalId: "procurement/review",
        title: "Vendor Compliance Check",
      },
    })) as PresetScaffoldReport;
    assert.equal(createdPreset.schema, "preset-scaffold-report/v1");
    assert.equal(createdPreset.bundledInLocalVertical, true);
    assert.equal(createdPreset.targetDir, "verticals/procurement-review/presets/vendor-check");
    assert.equal(createdPreset.gateId, "vendor-check-contract");

    // 5. Verify resolveRepoBootstrapDefaults & bundled agents with zero manual edits.
    const defaults = resolveRepoBootstrapDefaults({ rootDir, verticalId: "procurement/review" });
    assert.equal(defaults.verticalId, "procurement/review");
    assert.equal(defaults.presetId, "domain-task");
    assert.equal(defaults.profileId, "verified");
    assert.deepEqual(listBundledAgentDeclarationIds("procurement/review", rootDir), [
      "closeout-reviewer",
      "contributor",
    ]);

    // 6. Validate both default and custom preset via vertical-validate.
    for (const presetId of ["domain-task", "vendor-check", "work-root"]) {
      const validated = (await runPresetAction({
        rootDir,
        action: { kind: "vertical-validate", verticalSource: "procurement/review", presetId },
      })) as { valid: boolean; issues: unknown[] };
      assert.equal(validated.valid, true, `vertical-validate failed for ${presetId}: ${JSON.stringify(validated)}`);
      assert.deepEqual(validated.issues, []);
    }

    // 7. Run zero-side-effect vertical-simulate on both the default preset and the added vendor-check preset.
    for (const [presetId, expectedGateId] of [
      ["domain-task", "deliverable-contract"],
      ["vendor-check", "vendor-check-contract"],
    ] as const) {
      const simulated = (await runPresetAction({
        rootDir,
        action: {
          kind: "vertical-simulate",
          verticalSource: "procurement/review",
          presetId,
          locale: "zh-CN",
        },
      })) as VerticalSimulateReport;
      assert.equal(simulated.schema, "vertical-simulate-report/v1");
      assert.equal(simulated.ok, true, JSON.stringify(simulated, null, 2));
      assert.equal(simulated.zeroLedgerWrites, true);
      assert.equal(simulated.vertical.id, "procurement/review");
      assert.equal(simulated.bootstrap.ok, true);
      assert.equal(simulated.bootstrap.workPresetId, "work-root");
      assert.deepEqual(simulated.agents.ids, ["closeout-reviewer", "contributor"]);
      assert.ok(
        simulated.previews.repository.some(
          (doc) => doc.path === "AGENTS.md" && doc.body.includes("Procurement Review"),
        ),
      );
      assert.ok(simulated.previews.regularTask?.documents.some((doc) => doc.path === "task_plan.md"));
      assert.ok(simulated.previews.regularTask?.documents.some((doc) => doc.path === "artifacts/explainer.html"));
      assert.ok(
        simulated.previews.workTask?.documents.some(
          (doc) => doc.path === "task_plan.md" && doc.body.includes("## Workstreams"),
        ),
      );

      const gate = simulated.gates.find((entry) => entry.gateId === expectedGateId);
      assert.ok(gate, `Expected gate ${expectedGateId} in simulation output`);
      assert.equal(gate.ok, true, JSON.stringify(gate));
      assert.equal(gate.positive.ok, true);
      assert.equal(gate.positive.result, "pass");
      assert.deepEqual(gate.positive.predicateIssues, []);
      assert.equal(gate.negative.ok, true);
      assert.equal(gate.negative.result, "fail");
      assert.equal(gate.negative.blockerCode, "gate_witness_missing");
    }

    // 8. Confirm 0 ledger writes occurred in rootDir.
    assert.equal(existsSync(path.join(rootDir, "harness")), false);
    assert.equal(existsSync(path.join(rootDir, ".harness")), false);
  } finally {
    removeTempRepository(rootDir);
  }
});

test("broken legacy user preset pointers (e.g. unknown field checkerProfile) emit clear uninstall remediation across preset-list, preset-audit, vertical-validate, and vertical-simulate", async () => {
  const rootDir = makeWorkspace("ha-fde-broken-pointer-");
  try {
    const userRoot = presetUserRoot(rootDir),
      digest = "a".repeat(64),
      objectDir = path.join(userRoot, "preset-objects", digest),
      activeDir = path.join(userRoot, "active");
    mkdirSync(objectDir, { recursive: true });
    mkdirSync(activeDir, { recursive: true });
    writeFileSync(
      path.join(objectDir, "preset.json"),
      JSON.stringify({
        schema: "preset-manifest/v3",
        id: "windows-acceptance",
        title: "Windows Acceptance",
        vertical: "software/coding",
        version: "1.0.0",
        kind: "template-content",
        outputShape: "repository-diff",
        checkerProfile: "legacy-profile",
        kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
        capabilityImports: [],
        profiles: [{ id: "baseline", title: "Baseline", completionGates: [], templateSelections: [] }],
        defaultProfile: "baseline",
      }),
      "utf8",
    );
    writeFileSync(
      path.join(objectDir, "PRESET.md"),
      "---\nschema: preset-document/v1\ndescription: Legacy preset.\nwhenToUse: Legacy test.\n---\n# Legacy\n",
      "utf8",
    );
    writeFileSync(
      path.join(activeDir, "windows-acceptance.json"),
      JSON.stringify({
        schema: "preset-active-pointer/v1",
        presetId: "windows-acceptance",
        verticalId: "software/coding",
        digest,
      }),
      "utf8",
    );
    // Also place a corrupt unreadable orphan pointer with unknown verticalId.
    writeFileSync(path.join(activeDir, "corrupt-orphan.json"), "{ not-json", "utf8");

    const listed = (await runPresetAction({
      rootDir,
      settings: INITIAL_SETTINGS_V1,
      action: { kind: "preset-list", verticalId: "software/coding" },
    })) as Array<{ id: string; validity: string; nextAction?: string }>;
    const brokenEntry = listed.find((entry) => entry.id === "windows-acceptance");
    assert.ok(brokenEntry);
    assert.equal(brokenEntry.validity, "blocked");
    assert.match(brokenEntry.nextAction ?? "", /ha preset uninstall windows-acceptance/u);
    assert.match(brokenEntry.nextAction ?? "", /checkerProfile/u);

    const audited = (await runPresetAction({
      rootDir,
      settings: INITIAL_SETTINGS_V1,
      action: { kind: "preset-audit", verticalId: "software/coding" },
    })) as {
      blocked: number;
      issues: Array<{ presetId: string; layer?: string; remediation?: string; message: string }>;
    };
    assert.equal(audited.blocked, 2);
    const winIssue = audited.issues.find((issue) => issue.presetId === "windows-acceptance");
    assert.ok(winIssue);
    assert.equal(winIssue.layer, "user");
    assert.match(winIssue.remediation ?? "", /ha preset uninstall windows-acceptance/u);
    assert.match(winIssue.remediation ?? "", /checkerProfile/u);
    const orphanIssue = audited.issues.find((issue) => issue.presetId === "corrupt-orphan");
    assert.ok(orphanIssue);
    assert.match(orphanIssue.remediation ?? "", /ha preset uninstall corrupt-orphan/u);

    const validated = (await runPresetAction({
      rootDir,
      settings: INITIAL_SETTINGS_V1,
      action: { kind: "vertical-validate", verticalSource: "software/coding" },
    })) as {
      valid: boolean;
      userPointerDiagnostics?: Array<{ presetId: string; remediation: string }>;
    };
    assert.equal(validated.valid, true);
    assert.ok(
      validated.userPointerDiagnostics?.some(
        (item) =>
          item.presetId === "windows-acceptance" && item.remediation.includes("ha preset uninstall windows-acceptance"),
      ),
    );

    const simulated = await simulateVerticalPackage({
      rootDir,
      source: "software/coding",
      userRoot,
    });
    assert.ok(
      simulated.diagnostics.some(
        (item) =>
          item.scope === "user-pointer" &&
          item.message.includes("windows-acceptance") &&
          (item.remediation ?? "").includes("ha preset uninstall windows-acceptance"),
      ),
    );
  } finally {
    removeTempRepository(rootDir);
  }
});
