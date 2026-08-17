// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore } from "../../kernel/src/index.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: "codex" } } as const;
const reviewerBinding = { actor: { principal: { personId: "person-reviewer" }, executor: { kind: "agent" as const, id: "arbiter" } }, source: "local" as const, roles: ["$arbiter"] } as const;

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Milestone Lineage Test");
  git(rootDir, "config", "user.email", "milestone-lineage@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
}

/** Walks a task to in_review with the approved Review, owner consent, and every completion gate satisfied. */
async function reachGreenInReview(cell: Awaited<ReturnType<typeof openRepoCell>>, rootDir: string, taskId: string, executionId: string, title: string, taskClass: "milestone" | "standard" = "standard"): Promise<string> {
  const binding = { actor, source: "local" as const };
  await cell.run({ kind: "task-create", taskId, title, ...(taskClass === "milestone" ? { taskClass } : {}) }, binding);
  await cell.run({ kind: "task-start", taskId, executionId }, binding);
  const packagePath = `tasks/${taskId}-${title.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "")}`, closeoutPath = `${packagePath}/closeout.md`;
  writeFileSync(path.join(rootDir, "harness", closeoutPath), "# Closeout\n\n## Summary\n\nDone.\n\n## Verification\n\nVerified.\n\n## Residual Risk\n\nNone.\n");
  assert.equal((await cell.run({ kind: "doc-submit", paths: [closeoutPath] }, binding)).outcome, "applied");
  const commitSha = git(rootDir, "rev-parse", "HEAD");
  writeFileSync(path.join(rootDir, "submission.json"), JSON.stringify({ completionClaim: "Implemented.", deliverables: ["lineage"], outputs: [closeoutPath], verificationNotes: ["verified"], knownGaps: [], residualRisks: [], commitSha }));
  await cell.run({ kind: "task-submit", taskId, executionId, fromFile: "submission.json" }, binding);
  writeFileSync(path.join(rootDir, "review.json"), JSON.stringify({ verdict: "approved", reason: "Approved.", evidenceChecked: ["verified"], commitSha, iteration: 0 }));
  const reviewed = await cell.run({ kind: "task-review-execution", taskId, executionId, reviewId: "review-lineage", fromFile: "review.json" }, reviewerBinding) as unknown as Record<string, unknown>;
  writeFileSync(path.join(rootDir, "consent.json"), JSON.stringify({ reviewDigest: reviewed.reviewDigest, contentDigest: reviewed.contentDigest }));
  await cell.run({ kind: "task-review-consent", taskId, executionId, reviewId: "review-lineage", consentId: "consent-lineage", fromFile: "consent.json" }, binding);
  return commitSha;
}

test("an orphan milestone task stops at completion until the prescribed decision relate edge exists, then completes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-milestone-lineage-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const taskId = "task_m_line", executionId = "exe_m_line", binding = { actor, source: "local" as const };
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("milestone-lineage"), rootDir: canonicalRoot(rootDir), ownerId: "milestone-lineage" });
    const commitSha = await reachGreenInReview(cell, rootDir, taskId, executionId, "Milestone Lineage", "milestone");
    // Satisfy the mechanical gates first (CI witness, code-doc witness); the lineage gap must be what remains.
    const ci = await cell.run({ kind: "task-complete", taskId, executionId, ci: "passed" }, binding) as unknown as Record<string, unknown>;
    assert.equal(ci.code, "code_doc_missing", JSON.stringify(ci));
    const reconciled = await cell.run({ kind: "task-complete", taskId, executionId, ci: "passed", commitSha, iteration: 0, paths: ["packages/kernel/src/domain/task.ts"] }, binding) as unknown as Record<string, unknown>;
    // RED before the rule: this facade call used to land task_completed. After it, the orphan stops with the named edge and the exact command.
    assert.deepEqual({ outcome: reconciled.outcome, code: reconciled.code, stoppedAt: reconciled.stoppedAt }, { outcome: "rejected", code: "decision_lineage_missing", stoppedAt: "decision_lineage_missing" }, JSON.stringify(reconciled));
    const nextAction = String((reconciled.next as { readonly command: string }[])[0]?.command);
    assert.match(nextAction, new RegExp(`^ha decision relate <decision-id> --anchor <claim-id> --type derives --target task/${taskId} --rationale `, "u"), nextAction);
    assert.equal(makeTaskEventStore({ repoId: "milestone-lineage", rootDir }).read().events.some((event) => event.type === "task_completed"), false, "no completion event may exist while the task is an orphan");
    // Walk the prescription: propose the authorising decision with a CH1 claim, then run the exact related command shape.
    const proposed = await cell.run({ kind: "decision-propose", jsonInput: JSON.stringify({ title: "Authorise the lineage milestone", question: "Does this milestone proceed?", riskTier: "medium", urgency: "medium", vertical: "default", preset: "default", decisionClass: "ordinary", appliesTo: { modules: ["daemon"], productLines: [] }, chosen: [{ id: "CH1", text: "Proceed under the milestone lineage rule" }], rejected: [{ id: "RJ1", text: "Skip the edge", whyNot: "The lineage rule requires it" }], claims: [], fulfillments: [], relations: [] }) }, binding);
    const decisionId = (JSON.parse(String(proposed.evidence)) as { decisionId: string }).decisionId;
    const related = await cell.run({ kind: "decision-relate", decisionId, anchor: "CH1", relationType: "derives", target: `task/${taskId}`, rationale: "This decision authorises the milestone task." }, binding);
    assert.equal(related.outcome, "applied", JSON.stringify(related));
    // With the edge in place the same completion command applies; the with-edge negative control.
    const completed = await cell.run({ kind: "task-complete", taskId, executionId }, binding) as unknown as Record<string, unknown>;
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    const store = makeTaskEventStore({ repoId: "milestone-lineage", rootDir }), completedEvent = store.read().events.find((event) => event.type === "task_completed");
    assert.notEqual(completedEvent, undefined);
    const shown = await cell.run({ kind: "task-show", taskId }, binding) as unknown as Record<string, unknown>;
    assert.match(String(shown.evidence), /"status":"done"/u, String(shown.evidence));
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("a standard task still completes with no decision relations at all", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-standard-lineage-")); let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const taskId = "task_s_line", executionId = "exe_s_line", binding = { actor, source: "local" as const };
  try {
    initRepo(rootDir); cell = await openRepoCell({ repoId: workspaceId("standard-lineage"), rootDir: canonicalRoot(rootDir), ownerId: "standard-lineage" });
    const commitSha = await reachGreenInReview(cell, rootDir, taskId, executionId, "Standard Lineage");
    const completed = await cell.run({ kind: "task-complete", taskId, executionId, ci: "passed", commitSha, iteration: 0, paths: ["packages/kernel/src/domain/task.ts"] }, binding) as unknown as Record<string, unknown>;
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    assert.equal(makeTaskEventStore({ repoId: "standard-lineage", rootDir }).read().events.some((event) => event.type === "task_completed"), true);
  } finally { await cell?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});
