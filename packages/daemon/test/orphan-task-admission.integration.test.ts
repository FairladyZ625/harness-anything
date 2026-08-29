// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { makeTaskEventStore } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { seedSettingsEvent } from "./repo-settings.fixture.ts";
import { actor, initRepo } from "./task-surface.fixtures.ts";

const binding = { actor, source: "local" as const };

test("task start and task-bound runtime dispatch refuse orphans while Decision and Fact lineage admit start", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-orphan-task-admission-")),
    repoId = workspaceId("orphan-task-admission");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    seedSettingsEvent({ repoId, rootDir });
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "orphan-task-admission",
      now: () => "2026-08-29T00:00:00.000Z",
    });
    await cell.read("repo.settings.read");

    await createReadyTask(cell, rootDir, "task_orphan");
    const beforeRefusal = makeTaskEventStore({ repoId, rootDir }).readHead()?.revision,
      refused = await cell.run({ kind: "task-start", taskId: "task_orphan", executionId: "exe_orphan" }, binding);
    assert.equal(refused.outcome, "op_rejected");
    assert.equal(refused.code, "orphan_task");
    assert.match(String(refused.nextAction), /active Decision derives\/relates edge/u);
    assert.match(
      String(refused.nextAction),
      /ha decision relate <decision-id> --anchor CH<n> --type derives --target task\/task_orphan/u,
    );
    assert.match(String(refused.nextAction), /ha task relate task_orphan relates fact\/F-XXXXXXXX/u);
    assert.equal(makeTaskEventStore({ repoId, rootDir }).readHead()?.revision, beforeRefusal);

    await assert.rejects(
      cell.spawnRuntime({ taskId: "task_orphan", idempotencyKey: "orphan-runtime" }, binding),
      (error: unknown) => (error as { readonly code?: unknown }).code === "orphan_task",
    );

    const fact = await cell.run(
      {
        kind: "fact-record",
        statement: "The orphan task is tied to an observed need.",
        evidenceSource: "test:orphan-task-admission",
        confidence: "high",
        memoryClass: "semantic",
        memoryTags: [],
      },
      binding,
    );
    assert.equal(fact.outcome, "applied");
    const factId = String((fact as Record<string, unknown>).factId);
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-relate",
            taskId: "task_orphan",
            target: `fact/${factId}`,
            relationType: "relates",
            rationale: "The observation authorizes investigation.",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task_orphan", executionId: "exe_fact" }, binding)).outcome,
      "applied",
    );

    await createReadyTask(cell, rootDir, "task_decision");
    const proposed = await cell.run(
      {
        kind: "decision-propose",
        jsonInput: JSON.stringify({
          title: "Dispatch traced work",
          question: "Should the traced task start?",
          riskTier: "medium",
          urgency: "medium",
          vertical: "software/coding",
          preset: "standard-task",
          decisionClass: "ordinary",
          appliesTo: { modules: ["daemon"], productLines: ["harness"] },
          chosen: [{ id: "CH1", text: "Dispatch it" }],
          rejected: [{ id: "RJ1", text: "Leave it idle", whyNot: "The observed work is ready." }],
          claims: [],
          fulfillments: [],
          relations: [
            {
              anchor: "CH1",
              type: "derives",
              target: "task/task_decision",
              rationale: "The decision directly authorizes this task.",
            },
          ],
        }),
      },
      binding,
    );
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task_decision", executionId: "exe_decision" }, binding)).outcome,
      "applied",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

async function createReadyTask(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  rootDir: string,
  taskId: string,
): Promise<void> {
  const created = await cell.run({ kind: "task-create", taskId, title: `Fixture ${taskId}` }, binding);
  assert.equal(created.outcome, "applied");
  await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
    cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
  );
}
