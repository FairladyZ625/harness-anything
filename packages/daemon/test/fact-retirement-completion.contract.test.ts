// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore } from "../../kernel/src/index.ts";
import { createRealizedTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: "codex" } } as const,
  binding = { actor, source: "local" as const },
  reviewerBinding = withRoleBinding(
    {
      actor: { principal: { personId: "person-reviewer" }, executor: { kind: "agent" as const, id: "arbiter" } },
      source: "local" as const,
    },
    "arbiter",
  );

test("task complete rejects an undeclared upstream Fact and persists a still-holds disposition", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-fact-retirement-")),
    repoId = workspaceId("fact-retirement"),
    taskId = "task_fact_retirement",
    executionId = "exe_fact_retirement";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "fact-retirement" });
    await reachGreenInReview(cell, rootDir, taskId, executionId);
    const upstream = (await cell.run(
        {
          kind: "fact-record",
          statement: "The completion loop leaves motivating Facts standing without a disposition.",
          evidenceSource: "test:fact-retirement",
          confidence: "high",
          memoryClass: "semantic",
          memoryTags: [],
        },
        binding,
      )) as unknown as Record<string, unknown>,
      factRef = `fact/${String(upstream.factId)}`,
      proposed = await cell.run(
        {
          kind: "decision-propose",
          jsonInput: JSON.stringify({
            title: "Require Fact retirement disposition",
            question: "How should completion close the motivating Fact loop?",
            riskTier: "high",
            urgency: "high",
            vertical: "software/coding",
            preset: "standard-task",
            decisionClass: "ordinary",
            appliesTo: { modules: ["daemon"], productLines: ["harness-anything"] },
            chosen: [{ id: "CH1", text: "Gate completion on explicit disposition" }],
            rejected: [{ id: "RJ1", text: "Leave it manual", whyNot: "That leaves the loop open" }],
            claims: [{ id: "C1", text: "The loop is currently open", loadBearing: true }],
            fulfillments: [{ claimId: "C1", mode: "evidenced" }],
            relations: [
              {
                anchor: "C1",
                type: "evidenced-by",
                target: factRef,
                rationale: "The observed open loop motivates the gate.",
              },
            ],
          }),
        },
        binding,
      ),
      decisionId = (JSON.parse(String(proposed.evidence)) as { readonly decisionId: string }).decisionId;
    assert.equal(
      (
        await cell.run(
          {
            kind: "decision-relate",
            decisionId,
            anchor: "CH1",
            relationType: "derives",
            target: `task/${taskId}`,
            rationale: "The chosen gate is implemented by this task.",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    const relationReceipt = await cell.run({ kind: "relation-list" }, binding);
    assert.match(String(relationReceipt.evidence), new RegExp(`decision/${decisionId}/CH1.*task/${taskId}`, "u"));
    assert.match(String(relationReceipt.evidence), new RegExp(`decision/${decisionId}/C1.*${factRef}`, "u"));

    const blocked = (await cell.run(
      { kind: "task-complete", taskId, executionId, ci: "passed", paths: ["README.md"] },
      binding,
    )) as unknown as Record<string, unknown>;
    assert.deepEqual(
      { outcome: blocked.outcome, code: blocked.code, stoppedAt: blocked.stoppedAt },
      {
        outcome: "op_rejected",
        code: "fact_retirement_undeclared",
        stoppedAt: "fact_retirement_undeclared",
      },
      JSON.stringify(blocked),
    );
    assert.match(
      String((blocked.next as readonly { readonly reason: string }[])[0]?.reason),
      new RegExp(`${factRef} via decision/${decisionId}/C1`, "u"),
    );
    assert.equal(
      makeTaskEventStore({ repoId, rootDir })
        .read()
        .events.some((event) => event.type === "task_completed"),
      false,
    );

    const rationale = "The code now enforces the gate, so the original observation still describes the pre-fix state.",
      completed = (await cell.run(
        {
          kind: "task-complete",
          taskId,
          executionId,
          factHolds: [{ factRef, rationale }],
        },
        binding,
      )) as unknown as Record<string, unknown>;
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    const event = makeTaskEventStore({ repoId, rootDir }).readEvent(String(completed.opId));
    assert.equal(event?.type, "task_completed");
    if (event?.type === "task_completed")
      assert.deepEqual(event.payload.factRetirementAttestations, [{ factRef, rationale }]);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function reachGreenInReview(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  rootDir: string,
  taskId: string,
  executionId: string,
): Promise<void> {
  const title = "Fact Retirement Contract";
  await createRealizedTaskPlanFixture(
    rootDir,
    () => cell.run({ kind: "task-create", taskId, title }, binding),
    (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
    title,
  );
  await cell.run(
    {
      kind: "fact-record",
      taskId,
      statement: "The task has completion evidence.",
      evidenceSource: "test:fact-retirement",
      confidence: "high",
      memoryClass: "episodic",
      memoryTags: [],
    },
    binding,
  );
  await cell.run({ kind: "task-start", taskId, executionId }, binding);
  const packagePath = "tasks/task_fact_retirement-fact-retirement-contract",
    closeoutPath = `${packagePath}/closeout.md`;
  writeFileSync(
    path.join(rootDir, "harness", closeoutPath),
    "# Closeout\n\n## Summary\n\nDone.\n\n## Verification\n\nVerified.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNo sibling mechanism in this fixture.\n",
  );
  assert.equal((await cell.run({ kind: "doc-submit", paths: [closeoutPath] }, binding)).outcome, "applied");
  writeFileSync(
    path.join(rootDir, "submission.json"),
    JSON.stringify({
      completionClaim: "Implemented.",
      deliverables: ["README.md"],
      outputs: [closeoutPath],
      verificationNotes: ["verified"],
      knownGaps: [],
      residualRisks: [],
      commitSha: git(rootDir, "rev-parse", "HEAD"),
    }),
  );
  await cell.run({ kind: "task-submit", taskId, executionId, fromFile: "submission.json" }, binding);
  writeFileSync(
    path.join(rootDir, "review.json"),
    JSON.stringify({ verdict: "approved", reason: "Approved.", evidenceChecked: ["verified"] }),
  );
  const reviewed = (await cell.run(
    { kind: "task-review-execution", taskId, executionId, reviewId: "review-retirement", fromFile: "review.json" },
    reviewerBinding,
  )) as unknown as Record<string, unknown>;
  writeFileSync(
    path.join(rootDir, "consent.json"),
    JSON.stringify({ reviewDigest: reviewed.reviewDigest, contentDigest: reviewed.contentDigest }),
  );
  await cell.run(
    {
      kind: "task-review-consent",
      taskId,
      executionId,
      reviewId: "review-retirement",
      consentId: "consent-retirement",
      fromFile: "consent.json",
    },
    binding,
  );
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Fact Retirement Test");
  git(rootDir, "config", "user.email", "fact-retirement@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  writeFileSync(path.join(rootDir, "README.md"), "# Fixture\n");
  git(rootDir, "add", "README.md");
  git(rootDir, "commit", "--quiet", "-m", "fixture base");
}
