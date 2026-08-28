// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

const submission = {
  completionClaim: "Ready.",
  deliverables: ["actionable rejection"],
  outputs: ["receipt"],
  verificationNotes: ["integration"],
  knownGaps: [],
  residualRisks: [],
  commitSha: "a".repeat(40),
} as const;

test("submit lease refusals name the state-specific command that advances the execution", async () => {
  const rootDir = workspace("submit-exit"),
    taskId = "task-submit-exit",
    executionId = "exec-submit-exit",
    holder = binding("holder"),
    reviewer = withRoleBinding(binding("reviewer"), "arbiter");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId: workspaceId("submit-exit"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "submit-exit",
    });
    writeFileSync(path.join(rootDir, "submission.json"), JSON.stringify(submission));
    assert.equal((await cell.run({ kind: "task-create", taskId, title: "Submit exit" }, holder)).outcome, "applied");
    const withoutLease = await cell.run(
      { kind: "task-submit", taskId, executionId, fromFile: "submission.json" },
      holder,
    );
    assert.equal(withoutLease.code, "lease_required", JSON.stringify(withoutLease));
    assert.equal(
      withoutLease.nextAction,
      `Submit requires the active execution lease; run ha task start ${taskId} --execution-id ${executionId}, then retry ha task submit ${taskId} --json-input '<submission-json>'.`,
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, holder)).outcome, "applied");
    assert.equal(
      (await cell.run({ kind: "task-submit", taskId, executionId, fromFile: "submission.json" }, holder)).outcome,
      "applied",
    );

    const alreadySubmitted = await cell.run(
      { kind: "task-submit", taskId, executionId, fromFile: "submission.json" },
      holder,
    );
    assert.equal(alreadySubmitted.code, "lease_required", JSON.stringify(alreadySubmitted));
    assert.equal(
      alreadySubmitted.nextAction,
      `Execution ${executionId} is already submitted; run ha task review-execution ${taskId} --execution-id ${executionId} --review-id <review-id> --from-file <review.json>.`,
    );
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Independent review.", evidenceChecked: ["integration"] }),
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-review-execution",
            taskId,
            executionId,
            reviewId: "review-submit-exit",
            fromFile: "review.json",
          },
          reviewer,
        )
      ).outcome,
      "applied",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("progress lease mismatch names the holder and a release plus re-entry route that terminates", async () => {
  const rootDir = workspace("progress-exit"),
    taskId = "task-progress-exit",
    executionId = "exec-progress-exit",
    holder = binding("holder"),
    next = binding("next");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId: workspaceId("progress-exit"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "progress-exit",
    });
    assert.equal((await cell.run({ kind: "task-create", taskId, title: "Progress exit" }, holder)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, holder)).outcome, "applied");
    const rejected = await cell.run({ kind: "task-progress-append", taskId, text: "Wrong holder." }, next);
    assert.equal(rejected.code, "progress_lease_mismatch", JSON.stringify(rejected));
    assert.equal(
      rejected.nextAction,
      `Progress append requires the active lease holder (personId=person-owner, executor=agent:holder) for execution ${executionId}; that holder must run ha task progress append ${taskId} --text <text>, or run ha task release ${taskId}, then this caller can run ha task start ${taskId} --execution-id ${executionId} before retrying progress append.`,
    );
    assert.equal((await cell.run({ kind: "task-release", taskId }, holder)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, next)).outcome, "applied");
    assert.equal(
      (await cell.run({ kind: "task-progress-append", taskId, text: "Recovered holder." }, next)).outcome,
      "applied",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("executor declaration and completion context refusals name projection rebuild and the exact retry", async () => {
  const rootDir = workspace("projection-exits"),
    repoId = workspaceId("projection-exits"),
    taskId = "task-projection-exits",
    executionId = "exec-projection-exits",
    owner = { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" as const },
    declarer = binding("declared-executor"),
    cache = path.join(rootDir, ".harness/cache/task.sqlite");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "projection-exits-one" });
    assert.equal(
      (await cell.run({ kind: "task-create", taskId, title: "Projection exits" }, owner)).outcome,
      "applied",
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, owner)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-submit", taskId, executionId, submission }, owner)).outcome, "applied");
    await cell.close();
    cell = undefined;

    mutate(cache, "DELETE FROM task_snapshot WHERE task_id = ?", taskId);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "projection-exits-two" });
    const declaration = await cell.run(
      { kind: "task-declare-executor", taskId, executionId, reason: "Recover omitted executor" },
      declarer,
    );
    assert.equal(declaration.code, "content_not_ready", JSON.stringify(declaration));
    assert.equal(
      declaration.nextAction,
      `Task ${taskId} is not ready for executor declaration; run ha daemon projection rebuild, then retry ha task declare-executor ${taskId} --execution-id ${executionId} --reason <reason>.`,
    );
    assert.equal((await cell.run({ kind: "projection-rebuild" }, declarer)).outcome, "applied");
    assert.equal(
      (
        await cell.run(
          { kind: "task-declare-executor", taskId, executionId, reason: "Recover omitted executor" },
          declarer,
        )
      ).outcome,
      "applied",
    );
    await cell.close();
    cell = undefined;

    mutate(cache, "DELETE FROM task_package WHERE task_id = ?", taskId);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "projection-exits-three" });
    const metadata = await cell.run({ kind: "task-complete", taskId, executionId }, owner);
    assert.equal(metadata.code, "content_not_ready", JSON.stringify(metadata));
    assert.equal(
      metadata.nextAction,
      `Task ${taskId} package metadata is not ready; run ha daemon projection rebuild, then retry ha task complete ${taskId} --execution-id ${executionId}.`,
    );
    assert.equal((await cell.run({ kind: "projection-rebuild" }, owner)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-complete", taskId, executionId }, owner)).code, "review_missing");
    await cell.close();
    cell = undefined;

    mutate(cache, "DELETE FROM preset_snapshot");
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "projection-exits-four" });
    const closeout = await cell.run({ kind: "task-complete", taskId, executionId }, owner);
    assert.equal(closeout.code, "content_not_ready", JSON.stringify(closeout));
    assert.equal(
      closeout.nextAction,
      `Task ${taskId} closeout preset projection is not ready; run ha daemon projection rebuild, then retry ha task complete ${taskId} --execution-id ${executionId}.`,
    );
    assert.equal((await cell.run({ kind: "projection-rebuild" }, owner)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-complete", taskId, executionId }, owner)).code, "review_missing");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function binding(executorId: string) {
  return {
    actor: { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: executorId } },
    source: "local" as const,
  };
}
function mutate(cache: string, sql: string, ...values: readonly string[]): void {
  const database = new DatabaseSync(cache);
  try {
    database.prepare(sql).run(...values);
  } finally {
    database.close();
  }
}
function workspace(name: string): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), `ha-rejection-${name}-`));
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Rejection Test");
  git(rootDir, "config", "user.email", "rejection@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
  return rootDir;
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", args, { cwd: rootDir, encoding: "utf8", windowsHide: true }).trim();
}
