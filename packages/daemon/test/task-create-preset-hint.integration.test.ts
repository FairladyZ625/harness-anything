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

function writePresetPackage(sourceRoot: string, id: string, extra: Readonly<Record<string, unknown>> = {}): string {
  const packageRoot = path.join(sourceRoot, id);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    path.join(packageRoot, "preset.json"),
    JSON.stringify({
      schema: "preset-manifest/v3",
      id,
      title: id,
      vertical: "software/coding",
      version: "3.0.0",
      kind: "template-content",
      outputShape: "repository-diff",
      kernelVersionRange: { min: "1.0.0" },
      capabilityImports: [],
      profiles: [{ id: "baseline", title: "Baseline", completionGates: [], templateSelections: [] }],
      defaultProfile: "baseline",
      ...extra,
    }),
  );
  writeFileSync(
    path.join(packageRoot, "PRESET.md"),
    `---\nschema: preset-document/v1\ndescription: ${id}\nwhenToUse: Test fixture.\n---\n# ${id}\n`,
  );
  return packageRoot;
}

// Two decodable presets that cannot resolve: one imports an absent required provider itself, the
// other inherits that requirement through `extends`. `ha preset list` must downgrade both, so the
// missing-preset hint must not offer either as a choice.
function installUnavailablePresets(rootDir: string): readonly string[] {
  const sourceRoot = mkdtempSync(path.join(tmpdir(), "ha-create-preset-source-")),
    absentProvider = [{ id: "provider:absent/v1", kind: "checker", version: "1", required: true }],
    ids = ["needs-provider", "inherits-needed-provider"];
  try {
    installPresetPackage({
      source: writePresetPackage(sourceRoot, "needs-provider", { capabilityImports: absentProvider }),
      userRoot: presetUserRoot(rootDir),
    });
    installPresetPackage({
      source: writePresetPackage(sourceRoot, "inherits-needed-provider", { extends: "needs-provider" }),
      userRoot: presetUserRoot(rootDir),
    });
    return ids;
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
  }
}

test("a mistyped task-create preset names every selectable preset from the same catalog", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-create-preset-hint-"));
  initRepo(rootDir);
  const unavailable = installUnavailablePresets(rootDir);
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
    for (const id of unavailable) assert.equal(entries.find((row) => row.id === id)?.validity, "unavailable", id);
    const listed = entries.filter(({ validity }) => validity === "valid").map(({ id }) => id);
    assert.ok(listed.includes("standard-task"), JSON.stringify(listed));

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
    for (const id of unavailable) assert.doesNotMatch(explanation, new RegExp(id, "u"), explanation);

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
