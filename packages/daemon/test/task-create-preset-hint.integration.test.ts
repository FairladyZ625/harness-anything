// harness-test-tier: integration
import assert from "node:assert/strict";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { installPresetPackage } from "@harness-anything/preset/internal/preset-resolver";
import { presetUserRoot } from "@harness-anything/preset/internal/preset-system";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { actor, initRepo } from "./doc-sync-slice-a.fixtures.ts";

// A decodable preset whose required capability has no provider: `ha preset list` renders it as
// `unavailable`, so the missing-preset hint must not offer it as a choice.
function installUnavailablePreset(rootDir: string): void {
  const sourceRoot = mkdtempSync(path.join(tmpdir(), "ha-create-preset-source-"));
  try {
    const packageRoot = path.join(sourceRoot, "needs-provider");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      path.join(packageRoot, "preset.json"),
      JSON.stringify({
        schema: "preset-manifest/v3",
        id: "needs-provider",
        title: "Needs provider",
        vertical: "software/coding",
        version: "3.0.0",
        kind: "template-content",
        outputShape: "repository-diff",
        kernelVersionRange: { min: "1.0.0" },
        capabilityImports: [{ id: "provider:absent/v1", kind: "checker", version: "1", required: true }],
        profiles: [{ id: "baseline", title: "Baseline", completionGates: [], templateSelections: [] }],
        defaultProfile: "baseline",
      }),
    );
    writeFileSync(
      path.join(packageRoot, "PRESET.md"),
      "---\nschema: preset-document/v1\ndescription: Needs an absent provider\nwhenToUse: Test fixture.\n---\n# Needs provider\n",
    );
    installPresetPackage({ source: packageRoot, userRoot: presetUserRoot(rootDir) });
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
  }
}

test("a mistyped task-create preset names every selectable preset from the same catalog", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-create-preset-hint-"));
  initRepo(rootDir);
  installUnavailablePreset(rootDir);
  const cell = await openBootstrappedRepoCell({
    repoId: workspaceId("create-preset-hint"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "create-preset-hint",
  });
  const binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
  try {
    const entries = JSON.parse(String((await cell.run({ kind: "preset-list" }, binding)).evidence)) as readonly {
      readonly id: string;
      readonly validity: string;
    }[];
    assert.equal(entries.find(({ id }) => id === "needs-provider")?.validity, "unavailable");
    const listed = entries.filter(({ validity }) => validity === "valid").map(({ id }) => id);
    assert.ok(listed.includes("standard-task"), JSON.stringify(listed));
    assert.ok(!listed.includes("needs-provider"), JSON.stringify(listed));

    const rejected = await cell.run(
      { kind: "task-create", taskId: "task-hint", title: "Mistyped preset", presetId: "standard-taks" },
      binding,
    );
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "preset_not_found");
    const explanation = String(rejected.rejectionExplanation);
    assert.match(explanation, /Preset standard-taks is unavailable in software\/coding\./u);
    assert.ok(
      explanation.includes(`Available presets: ${listed.join(", ")}.`),
      `hint must list the catalog's selectable presets: ${explanation}`,
    );
    assert.doesNotMatch(explanation, /needs-provider/u, explanation);

    // The same preset id under a different vertical stays a missing-vertical rejection, not a
    // "here are the presets" suggestion: the list is scoped to the requested vertical.
    const wrongVertical = await cell.run(
      { kind: "task-create", taskId: "task-hint", title: "Mistyped vertical", verticalId: "ops/other" },
      binding,
    );
    assert.equal(wrongVertical.outcome, "op_rejected", JSON.stringify(wrongVertical));
    assert.equal(wrongVertical.code, "missing_vertical");
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
