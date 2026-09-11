// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, type CompletionNext } from "../../kernel/src/index.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { createRealizedTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: "codex" } } as const;
const reviewerBinding = withRoleBinding(
  {
    actor: { principal: { personId: "person-reviewer" }, executor: { kind: "agent" as const, id: "arbiter" } },
    source: "local" as const,
  },
  "arbiter",
);

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Milestone Lineage Test");
  git(rootDir, "config", "user.email", "milestone-lineage@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  writeFileSync(path.join(rootDir, "README.md"), "# Fixture\n");
  git(rootDir, "add", "README.md");
  git(rootDir, "commit", "--quiet", "-m", "fixture base");
}

/** Walks a task to in_review with the approved Review, owner consent, and every completion gate satisfied. */
async function reachGreenInReview(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  rootDir: string,
  taskId: string,
  executionId: string,
  title: string,
  taskClass: "milestone" | "standard" = "standard",
): Promise<void> {
  const binding = { actor, source: "local" as const };
  await createRealizedTaskPlanFixture(
    rootDir,
    async () => {
      const created = await cell.run(
        {
          kind: "task-create",
          taskId,
          title,
          presetId: "docs-task",
          ...(taskClass === "milestone" ? { taskClass } : {}),
        },
        binding,
      );
      await waitForFixturePublication(cell, created.opId, binding);
      return created;
    },
    (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
    title,
  );
  await cell.run(
    {
      kind: "fact-record",
      taskId,
      statement: `${title} has completion evidence.`,
      evidenceSource: "test:milestone-lineage",
      confidence: "high",
      memoryClass: "episodic",
      memoryTags: [],
    },
    binding,
  );
  await cell.run({ kind: "task-start", taskId, executionId }, binding);
  const packagePath = `tasks/${taskId}-${title
      .toLocaleLowerCase("en-US")
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")}`,
    closeoutPath = `${packagePath}/closeout.md`;
  const artifactPath = `${packagePath}/artifacts/verification.md`;
  mkdirSync(path.dirname(path.join(rootDir, "harness", artifactPath)), { recursive: true });
  writeFileSync(path.join(rootDir, "harness", artifactPath), "Verified fixture delivery.\n");
  const artifactSync = await cell.run({ kind: "doc-submit", paths: [artifactPath] }, binding);
  assert.equal(artifactSync.outcome, "applied", JSON.stringify(artifactSync));
  await waitForFixturePublication(cell, artifactSync.opId, binding);
  writeFileSync(
    path.join(rootDir, "harness", closeoutPath),
    "# Closeout\n\n## Summary\n\nDone.\n\n## Verification\n\nVerified.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNot applicable to this fixture.\n",
  );
  assert.equal((await cell.run({ kind: "doc-submit", paths: [closeoutPath] }, binding)).outcome, "applied");
  const submitted = await cell.run({ kind: "task-submit", taskId, executionId }, binding);
  assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
  writeFileSync(
    path.join(rootDir, "review.json"),
    JSON.stringify({ verdict: "approved", reason: "Approved.", evidenceChecked: ["verified"] }),
  );
  const reviewed = (await cell.run(
    { kind: "task-review-execution", taskId, executionId, reviewId: "review-lineage", fromFile: "review.json" },
    reviewerBinding,
  )) as unknown as Record<string, unknown>;
  assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
  await cell.run(
    {
      kind: "task-review-consent",
      taskId,
      executionId,
      reviewId: "review-lineage",
    },
    binding,
  );
}

test("an orphan milestone task stops at completion until the prescribed decision relate edge exists, then completes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-milestone-lineage-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const taskId = "task_m_line",
    executionId = "exe_m_line",
    binding = { actor, source: "local" as const };
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("milestone-lineage"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "milestone-lineage",
    });
    await reachGreenInReview(cell, rootDir, taskId, executionId, "Milestone Lineage", "milestone");
    const reconciled = (await cell.run({ kind: "task-complete", taskId, executionId }, binding)) as unknown as Record<
      string,
      unknown
    >;
    // RED before the rule: this facade call used to land task_completed. After it, the orphan stops with the named edge and the exact command.
    assert.deepEqual(
      { outcome: reconciled.outcome, code: reconciled.code, stoppedAt: reconciled.stoppedAt },
      { outcome: "op_rejected", code: "decision_lineage_missing", stoppedAt: "decision_lineage_missing" },
      JSON.stringify(reconciled),
    );
    const next = reconciled.next as readonly CompletionNext[];
    assert.equal(next.length, 1);
    assert.deepEqual(next[0], {
      action: `Identify the authorizing Decision claim in harness/tasks/${taskId}-milestone-lineage/closeout.md Summary.`,
      reason: "A milestone task completes only with an active decision derives edge; no active edge names this task.",
      authority: "person-owner",
      readCut: { revision: next[0]!.readCut.revision, iteration: 0, executionId },
    });
    assert.ok(Number.isInteger(next[0]!.readCut.revision) && next[0]!.readCut.revision > 0);
    assert.equal(
      makeTaskEventReader({ repoId: "milestone-lineage", rootDir })
        .read()
        .events.some((event) => event.type === "task_completed"),
      false,
      "no completion event may exist while the task is an orphan",
    );
    // Resolve the named authorizing claim, then establish its canonical derives edge.
    const proposed = await cell.run(
      {
        kind: "decision-propose",
        jsonInput: JSON.stringify({
          title: "Authorise the lineage milestone",
          question: "Does this milestone proceed?",
          riskTier: "medium",
          urgency: "medium",
          vertical: "default",
          preset: "default",
          decisionClass: "ordinary",
          appliesTo: { modules: ["daemon"], productLines: [] },
          chosen: [{ id: "CH1", text: "Proceed under the milestone lineage rule" }],
          rejected: [{ id: "RJ1", text: "Skip the edge", whyNot: "The lineage rule requires it" }],
          claims: [],
          fulfillments: [],
        }),
      },
      binding,
    );
    const decisionId = (JSON.parse(String(proposed.evidence)) as { decisionId: string }).decisionId;
    const related = await cell.run(
      {
        kind: "relation-relate",
        sourceRef: `decision/${decisionId}/CH1`,
        relationType: "derives",
        targetRef: `task/${taskId}`,
        rationale: "This decision authorises the milestone task.",
        expectedVersion: 0,
      },
      binding,
    );
    assert.equal(related.outcome, "applied", JSON.stringify(related));
    // With the edge in place the same completion command applies; the with-edge negative control.
    const completed = (await cell.run({ kind: "task-complete", taskId, executionId }, binding)) as unknown as Record<
      string,
      unknown
    >;
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    const store = makeTaskEventReader({ repoId: "milestone-lineage", rootDir }),
      completedEvent = store.read().events.find((event) => event.type === "task_completed");
    assert.notEqual(completedEvent, undefined);
    const shown = (await cell.run({ kind: "task-show", taskId }, binding)) as unknown as Record<string, unknown>;
    assert.match(String(shown.evidence), /"status":"done"/u, String(shown.evidence));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a standard task still completes with no decision relations at all", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-standard-lineage-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const taskId = "task_s_line",
    executionId = "exe_s_line",
    binding = { actor, source: "local" as const };
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("standard-lineage"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "standard-lineage",
    });
    await reachGreenInReview(cell, rootDir, taskId, executionId, "Standard Lineage");
    const completed = (await cell.run({ kind: "task-complete", taskId, executionId }, binding)) as unknown as Record<
      string,
      unknown
    >;
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    assert.equal(
      makeTaskEventReader({ repoId: "standard-lineage", rootDir })
        .read()
        .events.some((event) => event.type === "task_completed"),
      true,
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
