// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveRelationId, makeTaskEventReader, makeTaskProjectionReader } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { actor, initRepo } from "./doc-sync-slice-a.fixtures.ts";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";

const guidance =
  "如果这个 task 落实一项方向性裁决（改方案、定预算、定模型、定入口），先立 decision 再关联；评审意见拆出的后续任务可以不关联。";
const realizedWorkPlan = (title: string) =>
  realizedTaskPlan(
    title,
    [
      "Mission",
      "Usage Questions",
      "Wave Decomposition",
      "Exit Criteria",
      "Entry Conditions",
      "Dependencies",
      "Decision-Derived Authorization",
      "PR/merge Operations",
      "Constraints",
      "Checkpoint",
      "Implementation Plan",
      "Deliverable Contract",
      "Evidence Protocol",
      "Verification",
    ]
      .map(
        (heading) =>
          `## ${heading}\n\nThe ${heading.toLowerCase()} section defines this accepted work scope and its observable completion evidence.`,
      )
      .join("\n\n"),
  );

test("work create requires an effective Decision and writes implements with task creation", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-work-decision-create-")),
    repoId = workspaceId("work-decision-create");
  initRepo(rootDir);
  const cell = await openBootstrappedRepoCell({
      rootDir: canonicalRoot(rootDir),
      repoId,
      ownerId: "work-decision-create",
    }),
    events = makeTaskEventReader({ repoId, rootDir }),
    projection = makeTaskProjectionReader({ rootDir }),
    proposer = withPolicyGroup({ actor, source: "local" as const }, "contributor"),
    arbiter = withPolicyGroup(
      { actor: { principal: { personId: "person-arbiter" }, executor: null } as const, source: "local" as const },
      "maintainer",
    );
  try {
    const workAction = (taskId: string, decisionRef?: string) => ({
      kind: "task-create",
      taskId,
      title: taskId,
      presetId: "create-work",
      taskClass: "work",
      requirePlan: true,
      plan: realizedWorkPlan(taskId),
      ...(decisionRef === undefined ? {} : { decisionRef }),
    });
    const headBeforeMissing = events.readHead()?.revision ?? 0,
      missing = await cell.run(workAction("task_work_missing"), proposer);
    assert.equal(missing.outcome, "op_rejected", JSON.stringify(missing));
    assert.equal(missing.code, "decision_required");
    assert.match(String(missing.rejectionExplanation), /ha decision list/u);
    assert.match(String(missing.rejectionExplanation), /ha decision propose/u);
    assert.match(String(missing.rejectionExplanation), /ha decision accept/u);
    assert.match(String(missing.rejectionExplanation), /ha work create .*--decision/u);
    assert.equal(events.readHead()?.revision ?? 0, headBeforeMissing, "a rejected create leaves no task event");

    const workClassWithoutPreset = await cell.run(
      { kind: "task-create", taskId: "task_work_class_missing", title: "Work task class", taskClass: "work" },
      proposer,
    );
    assert.equal(workClassWithoutPreset.outcome, "op_rejected", JSON.stringify(workClassWithoutPreset));
    assert.equal(workClassWithoutPreset.code, "decision_required");
    assert.equal(events.readHead()?.revision ?? 0, headBeforeMissing);

    const unknown = await cell.run(workAction("task_work_unknown", "dec_missing"), proposer);
    assert.equal(unknown.outcome, "op_rejected", JSON.stringify(unknown));
    assert.equal(unknown.code, "decision_not_found");
    assert.equal(events.readHead()?.revision ?? 0, headBeforeMissing);

    const proposed = await cell.run(
        {
          kind: "decision-propose",
          body: "# Decision\n\n## 背景\n\nKnown facts.\n\n## 权衡\n\nCompared options.\n\n## 结论\n\nAdopt it.\n",
          jsonInput: JSON.stringify({
            title: "Create work from a decision",
            question: "Should a work root track the direction it implements?",
            riskTier: "medium",
            urgency: "high",
            vertical: "software/coding",
            preset: "standard-task",
            decisionClass: "ordinary",
            appliesTo: { modules: ["daemon"], productLines: [] },
            chosen: [{ id: "CH1", text: "Track the source Decision" }],
            rejected: [{ id: "RJ1", text: "Leave work unanchored", whyNot: "The goal loses its source" }],
            claims: [{ id: "C1", text: "Work follows an accepted direction.", loadBearing: true }],
            fulfillments: [],
          }),
        },
        proposer,
      ),
      decisionId = String((JSON.parse(String(proposed.evidence)) as { decisionId: string }).decisionId);
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));

    const headBeforeProposedDecisionWork = events.readHead()?.revision ?? 0,
      proposedDecision = await cell.run(workAction("task_work_proposed", decisionId), proposer);
    assert.equal(proposedDecision.outcome, "op_rejected", JSON.stringify(proposedDecision));
    assert.equal(proposedDecision.code, "decision_not_in_effect");
    assert.equal(events.readHead()?.revision ?? 0, headBeforeProposedDecisionWork);

    const accepted = await cell.run(
      {
        kind: "decision-accept",
        decisionId,
        rationale: "The owner accepted this direction.",
        judgmentOnlyRationale: "The owner accepted this direction.",
      },
      arbiter,
    );
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    await cell.settlePendingMaterialization("accept Decision before work create");

    const beforeWork = events.readHead()?.revision ?? 0,
      created = await cell.run(workAction("task_work_accepted", decisionId), proposer);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    assert.equal((events.readHead()?.revision ?? 0) - beforeWork, 2, "task and relation share one append cut");
    const relationId = deriveRelationId({
        source: "task/task_work_accepted",
        target: `decision/${decisionId}/CH1`,
        type: "implements",
        direction: "directed",
      }),
      relation = projection.withSession((read) => read.readRelationEdge(relationId));
    assert.equal(relation?.state, "active");
    assert.equal(relation?.sourceRef, "task/task_work_accepted");
    assert.equal(relation?.targetRef, `decision/${decisionId}/CH1`);

    const administrator = withPolicyGroup({ actor, source: "local" as const }, "admin"),
      superseded = await cell.run(
        {
          kind: "task-supersede",
          oldTaskId: "task_work_accepted",
          title: "Replacement work root",
          reason: "Retain the work's accepted direction during replacement.",
        },
        administrator,
      ),
      replacementTaskId = String(superseded.replacementTaskId);
    assert.equal(superseded.outcome, "applied", JSON.stringify(superseded));
    assert.equal(
      (events.readHead()?.revision ?? 0) - beforeWork,
      5,
      "work creation and replacement append their task/relation events",
    );
    assert.equal(
      projection.withSession((read) =>
        read.readRelationEdge(
          deriveRelationId({
            source: `task/${replacementTaskId}`,
            target: `decision/${decisionId}/CH1`,
            type: "implements",
            direction: "directed",
          }),
        ),
      )?.state,
      "active",
      "replacement keeps the Decision edge in the same append as the task replacement",
    );
    const invalidClause = await cell.run(workAction("task_work_invalid_clause", `${decisionId}/CH9`), proposer);
    assert.equal(invalidClause.outcome, "op_rejected", JSON.stringify(invalidClause));
    assert.equal(invalidClause.code, "decision_clause_not_found");

    const taskWithoutDecision = await cell.run(
        { kind: "task-create", taskId: "task_optional_decision", title: "Optional decision task" },
        proposer,
      ),
      taskWithDecision = await cell.run(
        { kind: "task-create", taskId: "task_linked_decision", title: "Linked decision task", decisionRef: decisionId },
        proposer,
      );
    assert.equal(taskWithoutDecision.outcome, "applied", JSON.stringify(taskWithoutDecision));
    assert.deepEqual(taskWithoutDecision.next, [{ command: guidance }]);
    assert.equal(taskWithDecision.outcome, "applied", JSON.stringify(taskWithDecision));
    assert.equal(taskWithDecision.next, undefined);
    assert.equal(
      projection.withSession((read) =>
        read.readRelationEdge(
          deriveRelationId({
            source: "task/task_linked_decision",
            target: `decision/${decisionId}/CH1`,
            type: "implements",
            direction: "directed",
          }),
        ),
      )?.state,
      "active",
    );

    const replacementRelationId = deriveRelationId({
        source: `task/${replacementTaskId}`,
        target: `decision/${decisionId}/CH1`,
        type: "implements",
        direction: "directed",
      }),
      replacementRelation = projection.withSession((read) => read.readRelationEdge(replacementRelationId)),
      unlinked = await cell.run(
        {
          kind: "relation-unrelate",
          relationId: replacementRelationId,
          reason: "Model an existing work that predates decision linkage.",
          expectedVersion: replacementRelation!.workspaceRevision,
        },
        administrator,
      );
    assert.equal(unlinked.outcome, "applied", JSON.stringify(unlinked));
    const agenda = await cell.read("repo.agenda.read");
    assert.match(agenda.summary, /无 decision 来源的 work \(1\)/u);
    assert.match(agenda.summary, new RegExp(`${replacementTaskId} Replacement work root`, "u"));
    assert.doesNotMatch(agenda.summary, /task_work_accepted/u);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
