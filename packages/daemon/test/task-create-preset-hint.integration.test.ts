// harness-test-tier: integration
import assert from "node:assert/strict";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { actor, initRepo } from "./doc-sync-slice-a.fixtures.ts";

test("a mistyped task-create preset names every selectable preset from the same catalog", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-create-preset-hint-"));
  initRepo(rootDir);
  const cell = await openBootstrappedRepoCell({
    repoId: workspaceId("create-preset-hint"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "create-preset-hint",
  });
  const binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
  try {
    const listed = (
      JSON.parse(String((await cell.run({ kind: "preset-list" }, binding)).evidence)) as readonly {
        readonly id: string;
        readonly validity: string;
      }[]
    )
      .filter(({ validity }) => validity === "valid")
      .map(({ id }) => id);
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
