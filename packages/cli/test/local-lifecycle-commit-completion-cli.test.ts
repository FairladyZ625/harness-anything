// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { initializeNestedHarnessRepo, withTestHarnessRoot as withTempRoot } from "./helpers/git-fixtures.ts";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";
import { runJson, seedApprovedExecution, writeCodeDocAnchors, writeIndex } from "./helpers/local-lifecycle-fixtures.ts";

const executionTaskId = "task_01KX7H00000000000000000000";
const executionId = "exe_01KX7H00000000000000000001";
const executionActorEnv = { HARNESS_ACTOR: "agent:test" } as const;

test("CLI task-complete rejects invalid commit-anchor packets without partial completion", () => {
  const rejectedCase = (
    taskId: string,
    mutate: (rootDir: string, anchoredSha: string) => string,
    expectedCode: string,
    options: { readonly judgment?: string; readonly ci?: "passed" | "failed" | "missing"; readonly placeholderCloseout?: boolean } = {}
  ) => withTempRoot((rootDir) => {
    const anchoredSha = prepareCommitCompletionTask(rootDir, taskId, options.placeholderCloseout ?? false);
    const requestedRef = mutate(rootDir, anchoredSha);
    const args = ["task", "complete", taskId, "--commit-anchor", requestedRef, "--judgment", options.judgment ?? "The commit completes this task."];
    if (options.ci !== "missing") args.push("--ci", options.ci ?? "passed");
    const rejected = runJson(rootDir, args, false, executionActorEnv);

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, expectedCode);
    assert.equal(existsSync(path.join(rootDir, `harness/tasks/${taskId}/completion-evidence.json`)), false);
    assert.match(readFileSync(path.join(rootDir, `harness/tasks/${taskId}/INDEX.md`), "utf8"), /status: in_review/u);
  });

  rejectedCase("task-unknown-commit", () => "a".repeat(40), "commit_completion_git_ref_missing");
  rejectedCase("task-blob-anchor", (rootDir) => execFileSync(
    "git", ["-C", rootDir, "hash-object", "-w", "--stdin"], { input: "not a commit\n", encoding: "utf8" }
  ).trim(), "commit_completion_non_commit_object");
  rejectedCase("task-private-anchor", (rootDir) => execFileSync(
    "git", ["-C", path.join(rootDir, "harness"), "rev-parse", "HEAD"], { encoding: "utf8" }
  ).trim(), "commit_completion_git_ref_missing");
  rejectedCase("task-ci-failed-anchor", (_rootDir, sha) => sha, "ci_not_passed", { ci: "failed" });
  rejectedCase("task-ci-missing-anchor", (_rootDir, sha) => sha, "missing_ci_gate", { ci: "missing" });
  rejectedCase("task-closeout-placeholder-anchor", (_rootDir, sha) => sha, "closeout_placeholder", { placeholderCloseout: true });
});

test("commit-anchor completion accepts existing Execution history, evidence, and a blank judgment", () => {
  withTempRoot((rootDir) => {
    const anchoredSha = prepareCommitCompletionTask(rootDir, executionTaskId, false);
    seedApprovedExecution(rootDir, executionTaskId, executionId);
    writeFileSync(
      path.join(rootDir, `harness/tasks/${executionTaskId}/completion-evidence.json`),
      "{\"stale\":true}\n",
      "utf8"
    );

    const completed = runJson(rootDir, [
      "task", "complete", executionTaskId, "--commit-anchor", anchoredSha,
      "--judgment", "   ", "--ci", "passed"
    ], true, executionActorEnv);

    assert.equal(completed.status, "done");
    const evidence = JSON.parse(readFileSync(
      path.join(rootDir, `harness/tasks/${executionTaskId}/completion-evidence.json`),
      "utf8"
    ));
    assert.equal(evidence.judgment.rationale, "");
  });
});

test("commit-anchor completion internally replaces a stale anchor and softens unavailable doc sync", () => {
  withTempRoot((rootDir) => {
    const taskId = "task-anchor-reconciled-internally";
    const originalSha = prepareCommitCompletionTask(rootDir, taskId, false);
    mkdirSync(path.join(rootDir, "tools"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "tools/write-road-registry.json"),
      readFileSync(path.resolve("tools/write-road-registry.json"), "utf8"),
      "utf8"
    );
    writeFileSync(path.join(rootDir, "second-public-change.txt"), "second commit\n", "utf8");
    execFileSync("git", ["-C", rootDir, "add", "second-public-change.txt"]);
    execFileSync("git", ["-C", rootDir, "commit", "-m", "second public change"]);
    const requestedSha = execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const completed = runJson(rootDir, [
      "task", "complete", taskId, "--commit-anchor", requestedSha,
      "--judgment", "The current workspace commit completes this task.", "--ci", "passed"
    ], true, executionActorEnv);

    assert.notEqual(requestedSha, originalSha);
    assert.equal(completed.status, "done");
    assert.equal(completed.completionEvidence.sha, requestedSha);
    assert.equal(completed.warnings.some((warning: { readonly code?: string }) => warning.code === "doc_sync_dirty"), true);
    const anchors = JSON.parse(readFileSync(path.join(rootDir, `harness/tasks/${taskId}/code-doc-anchors.json`), "utf8"));
    assert.equal(anchors.records.every((record: { readonly anchors: ReadonlyArray<{ readonly sha: string }> }) =>
      record.anchors.every((anchor) => anchor.sha === requestedSha)
    ), true);
  });
});

test("CLI task-complete requires paired commit-anchor flags and forbids reviewer self-report", () => {
  withTempRoot((rootDir) => {
    const missingJudgment = runJson(rootDir, ["task", "complete", "task-packet", "--commit-anchor", "HEAD"], false);
    const missingAnchor = runJson(rootDir, ["task", "complete", "task-packet", "--judgment", "done"], false);
    const reviewer = runJson(rootDir, [
      "task", "complete", "task-packet", "--commit-anchor", "HEAD", "--judgment", "done", "--reviewer", "self"
    ], false);
    const approvalPacket = path.join(rootDir, "approval.json");
    writeFileSync(approvalPacket, "{}\n", "utf8");
    const conflictingModes = runJson(rootDir, [
      "task", "complete", "task-packet", "--approve", "--from-file", approvalPacket,
      "--commit-anchor", "HEAD", "--judgment", "done"
    ], false);

    assert.equal(missingJudgment.error?.code, "invalid_task_metadata");
    assert.equal(missingAnchor.error?.code, "invalid_task_metadata");
    assert.equal(reviewer.error?.code, "invalid_task_metadata");
    assert.equal(conflictingModes.error?.code, "invalid_task_metadata");
    assert.match(conflictingModes.error?.hint ?? "", /one owner approval mode.+not both/iu);
  });
});

test("CLI owner reconciliation and completion do not require an Execution lease", () => {
  withTempRoot((rootDir) => {
    const legacyTaskId = "task_01KX7H00000000000000000002";
    initializeNestedHarnessRepo(rootDir);
    writeIndex(rootDir, legacyTaskId, "Legacy Anchor", "active");
    writeSubstantiveTaskPlan(rootDir, `harness/tasks/${legacyTaskId}`);
    writeFileSync(path.join(rootDir, `harness/tasks/${legacyTaskId}/closeout.md`), "# Closeout\n\nImplemented externally.\n", "utf8");
    mkdirSync(path.join(rootDir, "evidence"), { recursive: true });
    writeFileSync(path.join(rootDir, "evidence/lease-anchor.txt"), "public evidence\n", "utf8");
    execFileSync("git", ["-C", rootDir, "init", "-q"]);
    execFileSync("git", ["-C", rootDir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", rootDir, "config", "user.name", "Test User"]);
    execFileSync("git", ["-C", rootDir, "add", "evidence/lease-anchor.txt"]);
    execFileSync("git", ["-C", rootDir, "commit", "-m", "lease anchor"]);
    const sha = execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const leaseEnv = { HARNESS_TASK_LEASE_ENFORCEMENT: "1", ...executionActorEnv };

    const legacy = runJson(rootDir, [
      "task", "code-doc", "reconcile", legacyTaskId, "--commit", sha, "--path", "evidence/lease-anchor.txt"
    ], true, leaseEnv);
    assert.equal(legacy.ok, true);
    const legacyCompletion = runJson(rootDir, [
      "task", "complete", legacyTaskId, "--commit-anchor", sha,
      "--judgment", "The public workspace commit completes the legacy task.", "--ci", "passed"
    ], true, leaseEnv);
    assert.equal(legacyCompletion.completionGate.evidenceMode, "commit-anchor");

    writeIndex(rootDir, executionTaskId, "Strict Anchor", "in_review");
    writeFileSync(path.join(rootDir, `harness/tasks/${executionTaskId}/closeout.md`), "# Closeout\n\nStrict flow.\n", "utf8");
    seedApprovedExecution(rootDir, executionTaskId, executionId);
    const strict = runJson(rootDir, [
      "task", "code-doc", "reconcile", executionTaskId, "--commit", sha, "--path", "evidence/lease-anchor.txt"
    ], true, leaseEnv);
    assert.equal(strict.ok, true);
    const strictCompletion = runJson(rootDir, ["task", "complete", executionTaskId, "--ci", "passed"], true, leaseEnv);
    assert.equal(strictCompletion.status, "done");
  });
});

function prepareCommitCompletionTask(rootDir: string, taskId: string, placeholderCloseout: boolean): string {
  initializeNestedHarnessRepo(rootDir);
  writeIndex(rootDir, taskId, "Commit Completion Matrix", "in_review");
  writeSubstantiveTaskPlan(rootDir, `harness/tasks/${taskId}`);
  writeFileSync(path.join(rootDir, `harness/tasks/${taskId}/closeout.md`), placeholderCloseout
    ? "# Closeout\n\n## Summary\n\nSummarize the completed behavior change.\n"
    : "# Closeout\n\n## Summary\n\nImplemented the anchored task.\n\n## Verification\n\nVerified the workspace commit.\n\n## Residual Risk\n\nNone known.\n", "utf8");
  writeCodeDocAnchors(rootDir, taskId);
  return execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
