// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { actor, initRepo } from "./doc-sync-slice-a.fixtures.ts";

test("create with a plan file lands the authored plan in the same write and stays startable", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-create-plan-"));
  initRepo(rootDir);
  const plan = realizedTaskPlan("Plan authored at create");
  mkdirSync(path.join(rootDir, "plans"), { recursive: true });
  writeFileSync(path.join(rootDir, "plans", "authored.md"), plan);
  const cell = await openBootstrappedRepoCell({
    repoId: workspaceId("create-plan"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "create-plan",
  });
  const binding = { actor, source: "local" as const };
  try {
    const created = await cell.run(
      { kind: "task-create", taskId: "task-create-plan", title: "Create Plan", planFile: "plans/authored.md" },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    assert.equal(created.proof?.durable, true);
    const packagePath = (created as typeof created & { packagePath: string }).packagePath;
    assert.equal(
      readFileSync(path.join(rootDir, "harness", packagePath, "task_plan.md"), "utf8"),
      plan,
      "the authored plan is materialized, not the scaffold",
    );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task-create-plan", executionId: "exec-create-plan" }, binding))
        .outcome,
      "applied",
      "readiness still judges against the scaffold contract, so the authored plan is startable",
    );
    const shown = await cell.run({ kind: "doc-show", path: `${packagePath}/task_plan.md` }, binding);
    assert.match(String(shown.evidence ?? ""), /Plan authored at create/u);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a plan file missing a template section keeps the task unstartable", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-create-plan-gap-"));
  initRepo(rootDir);
  const incomplete = realizedTaskPlan("Incomplete at create").replace(
    "## Verification\n\nRun the owning test file and require every assertion to pass.",
    "",
  );
  mkdirSync(path.join(rootDir, "plans"), { recursive: true });
  writeFileSync(path.join(rootDir, "plans", "incomplete.md"), incomplete);
  const cell = await openBootstrappedRepoCell({
    repoId: workspaceId("create-plan-gap"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "create-plan-gap",
  });
  const binding = { actor, source: "local" as const };
  try {
    const created = await cell.run(
      { kind: "task-create", taskId: "task-plan-gap", title: "Plan Gap", planFile: "plans/incomplete.md" },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const started = await cell.run(
      { kind: "task-start", taskId: "task-plan-gap", executionId: "exec-plan-gap" },
      binding,
    );
    assert.equal(started.outcome, "op_rejected", JSON.stringify(started));
    assert.equal(started.code, "plan_placeholder");
    assert.equal(started.diagnostic?.kind, "missing-sections");
    assert.match(JSON.stringify(started.diagnostic ?? {}), /Verification/u);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
