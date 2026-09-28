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
import { fixture, owner, taskId } from "./task-completion-review.fixture.ts";

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

test("a task-bound commander creates a planned child with its authored plan and no lease", async () => {
  const f = await fixture(false, true, false, false, false, undefined, { autoSubmit: false });
  try {
    await f.install();
    const commander = await f.cell().spawnRuntime(
      {
        agentId: "closeout-reviewer",
        role: "worker",
        taskId,
        cwd: { scope: "repo-root" },
        prompt: "Create and plan a child task.",
        idempotencyKey: "task-create-plan-commander",
      },
      owner,
    );
    assert.equal(commander.outcome, "applied", JSON.stringify(commander));
    const commanderExecutor = {
      kind: "agent" as const,
      id: `runtime-session:${String(commander.runtimeSessionId)}`,
    };
    const plan = realizedTaskPlan("Commander-authored child plan");
    mkdirSync(path.join(f.root, "plans"), { recursive: true });
    writeFileSync(path.join(f.root, "plans", "commander-child.md"), plan);

    const created = await f.runPrincipal({
      kind: "task-create",
      taskId: "task-commander-child-plan",
      title: "Commander child plan",
      parentTaskId: taskId,
      planFile: "plans/commander-child.md",
      executor: commanderExecutor,
    });
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    assert.equal(created.status, "accepted_durable", JSON.stringify(created));
    const packagePath = String((created as Record<string, unknown>).packagePath);
    assert.equal(readFileSync(path.join(f.root, "harness", packagePath, "task_plan.md"), "utf8"), plan);

    const shown = await f.runPrincipal({ kind: "task-show", taskId: "task-commander-child-plan" });
    const snapshot = JSON.parse(String(shown.evidence)) as {
      task: { status: string };
      lease: unknown;
    };
    assert.equal(snapshot.task.status, "planned");
    assert.equal(snapshot.lease, null);
  } finally {
    await f.close();
  }
});
