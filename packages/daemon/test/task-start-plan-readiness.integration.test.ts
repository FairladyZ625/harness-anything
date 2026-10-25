// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { transitionDocumentContract } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { actor, initRepo } from "./doc-sync-slice-a.fixtures.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";

test("task start reports every incomplete plan section, empty and scaffold alike, in one diagnostic", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-start-plan-readiness-")),
    template = readFileSync(
      new URL("../../preset/assets/software-coding/templates/task.plan.v2/en-US.md", import.meta.url),
      "utf8",
    ),
    contract = transitionDocumentContract(template),
    scaffoldSentence = (heading: string) => {
      const entry = Object.entries(contract.scaffoldBySection).find(([section]) => section === heading);
      assert.ok(entry, `template scaffold for ${heading}`);
      return entry[1][0];
    },
    mixed = realizedTaskPlan("Mixed readiness plan")
      // Missing headings entirely: the section never appears in the document.
      .replace(/\n## Goal\n\n[^\n]+/u, "")
      .replace(/\n## Deliverable Contract\n\n[^\n]+/u, "")
      .replace(/\n## Evidence Protocol\n\n[^\n]+/u, "")
      // Placeholder text left verbatim from the scaffold in present sections.
      .replace(
        "Exercise the fixture's task lifecycle through canonical repository commands.",
        scaffoldSentence("Brief"),
      )
      .replace(
        "Read the fixture assertions that define the expected lifecycle behavior.",
        scaffoldSentence("Required Reading"),
      );
  initRepo(rootDir);
  const cell = await openBootstrappedRepoCell({
    repoId: workspaceId("start-plan-readiness"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "start-plan-readiness",
  });
  const binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
  try {
    const created = await cell.run(
      { kind: "task-create", taskId: "task-start-plan-readiness", title: "Start plan readiness" },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const packagePath = String((created as { readonly packagePath?: unknown }).packagePath),
      planPath = `${packagePath}/task_plan.md`;
    writeFileSync(path.join(rootDir, "harness", planPath), mixed);
    const rejected = await cell.run(
      { kind: "task-start", taskId: "task-start-plan-readiness", executionId: "execution-plan-readiness" },
      binding,
    );
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "plan_placeholder");
    assert.equal(rejected.diagnostic?.kind, "missing-sections");
    assert.deepEqual(rejected.diagnostic?.missingSections, [
      { section: "Brief", reason: "scaffold", retainedScaffold: scaffoldSentence("Brief").slice(0, 60) },
      { section: "Goal", reason: "empty" },
      {
        section: "Required Reading",
        reason: "scaffold",
        retainedScaffold: scaffoldSentence("Required Reading").slice(0, 60),
      },
      { section: "Deliverable Contract", reason: "empty" },
      { section: "Evidence Protocol", reason: "empty" },
    ]);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
