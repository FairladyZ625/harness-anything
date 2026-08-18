// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";

const git = (rootDir: string, ...args: readonly string[]): string =>
  execFileSync("git", args, { cwd: rootDir, encoding: "utf8", windowsHide: true }).trim();

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "RepoCell Test");
  git(rootDir, "config", "user.email", "repo-cell@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "config", "maintenance.auto", "false");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
}

// #1541 was filed as "execution review is structurally unreachable on Windows" because one sentence
// covered every refusal. The transport principal is shared on that platform, but independence is
// decided on the executor axis, so the loop does close; the message just never said which axis failed
// or what to do. Each branch below pins one cause to one repair.
test("#1541: each Execution Review refusal names its own cause and its own repair", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-review-independence-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId: workspaceId("review-independence"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" });
    // One shared principal, exactly as a single Windows host mints it: every local identity is uid 0.
    const collapsed = { personId: "0" } as const;
    const agentActor = { principal: collapsed, executor: { kind: "agent" as const, id: "windows-tester" } };
    const humanActor = { principal: collapsed, executor: null };
    const agent = { actor: agentActor, source: "local" as const, roles: ["$arbiter"] };
    const human = { actor: humanActor, source: "local" as const, roles: ["$arbiter"] };
    const taskId = "task-review-axis", executionId = "exec-1";
    assert.equal((await cell.run({ kind: "task-create", taskId, title: "Review axis" }, agent)).outcome, "applied");
    // The packet parses before authorization runs, so the file must exist for the refusal to be the one under test.
    writeFileSync(path.join(rootDir, "review.json"), JSON.stringify({ verdict: "approved", reason: "Reviewed independently.", evidenceChecked: ["tests"], commitSha: git(rootDir, "rev-parse", "HEAD"), iteration: 0 }));

    const beforeSubmission = await cell.run({ kind: "task-review-execution", taskId, executionId, reviewId: "r0", fromFile: "review.json" }, human);
    assert.equal(beforeSubmission.outcome, "op_rejected");
    assert.match(String(beforeSubmission.nextAction), /requires a submitted execution/u);

    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, agent)).outcome, "applied");
    const commitSha = git(rootDir, "rev-parse", "HEAD");
    writeFileSync(path.join(rootDir, "submission.json"), JSON.stringify({ completionClaim: "Ready.", deliverables: ["d"], outputs: ["o"], verificationNotes: ["v"], knownGaps: [], residualRisks: [], commitSha }));
    assert.equal((await cell.run({ kind: "task-submit", taskId, executionId, fromFile: "submission.json" }, agent)).outcome, "applied");
    writeFileSync(path.join(rootDir, "review.json"), JSON.stringify({ verdict: "approved", reason: "Reviewed independently.", evidenceChecked: ["tests"], commitSha, iteration: 0 }));

    // Missing the arbiter command class is a role problem, not an independence problem.
    const withoutRole = await cell.run({ kind: "task-review-execution", taskId, executionId, reviewId: "r1", fromFile: "review.json" }, { ...human, roles: [] });
    assert.equal(withoutRole.code, "actor_unauthorized");
    assert.match(String(withoutRole.nextAction), /arbiter command class/u);

    // The submitting executor reviewing itself is the one genuinely dependent case.
    const selfReview = await cell.run({ kind: "task-review-execution", taskId, executionId, reviewId: "r2", fromFile: "review.json" }, agent);
    assert.equal(selfReview.code, "actor_unauthorized");
    assert.match(String(selfReview.nextAction), /independent of the submitting executor/u);
    assert.doesNotMatch(String(selfReview.nextAction), /declared no executor/u);

    // The repair the issue could not find: a bare human invocation reviews an agent-declared submission
    // on the very same principal. This is the assertion that falsifies "unreachable on Windows".
    const reviewed = await cell.run({ kind: "task-review-execution", taskId, executionId, reviewId: "r3", fromFile: "review.json" }, human);
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// The complementary half: when the submission itself declared no executor, the same principal genuinely
// cannot review it, and the refusal must say so and point at the submitting write rather than the review.
test("#1541: a bare-invocation submission names the submitting write as the repair", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-review-bare-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId: workspaceId("review-bare"), rootDir: canonicalRoot(rootDir), ownerId: "daemon-test" });
    const bare = { actor: { principal: { personId: "0" }, executor: null }, source: "local" as const, roles: ["$arbiter"] };
    const taskId = "task-bare-axis", executionId = "exec-bare";
    assert.equal((await cell.run({ kind: "task-create", taskId, title: "Bare axis" }, bare)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, bare)).outcome, "applied");
    const commitSha = git(rootDir, "rev-parse", "HEAD");
    writeFileSync(path.join(rootDir, "submission.json"), JSON.stringify({ completionClaim: "Ready.", deliverables: ["d"], outputs: ["o"], verificationNotes: ["v"], knownGaps: [], residualRisks: [], commitSha }));
    assert.equal((await cell.run({ kind: "task-submit", taskId, executionId, fromFile: "submission.json" }, bare)).outcome, "applied");
    writeFileSync(path.join(rootDir, "review.json"), JSON.stringify({ verdict: "approved", reason: "Reviewed.", evidenceChecked: ["tests"], commitSha, iteration: 0 }));

    const refused = await cell.run({ kind: "task-review-execution", taskId, executionId, reviewId: "r1", fromFile: "review.json" }, bare);
    assert.equal(refused.code, "actor_unauthorized");
    assert.match(String(refused.nextAction), /declared no executor/u);
    assert.match(String(refused.nextAction), /submitting write/u);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
