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

test("task complete dry-run preflight reports every current prerequisite without writing", () => {
  withTempRoot((rootDir) => {
    const taskId = "task_01KX7H00000000000000000002";
    const submittedExecutionId = "exe_01KX7H00000000000000000003";
    initializeNestedHarnessRepo(rootDir);
    writeIndex(rootDir, taskId, "Completion Preflight Matrix", "in_review");
    writeSubstantiveTaskPlan(rootDir, `harness/tasks/${taskId}`);
    writeFileSync(path.join(rootDir, `harness/tasks/${taskId}/closeout.md`), [
      "# Closeout",
      "",
      "## Summary",
      "",
      "Summarize the completed behavior change.",
      ""
    ].join("\n"), "utf8");
    writeSubmittedExecution(rootDir, taskId, submittedExecutionId);
    const taskRoot = path.join(rootDir, `harness/tasks/${taskId}`);
    const before = {
      index: readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"),
      harnessStatus: execFileSync("git", ["-C", path.join(rootDir, "harness"), "status", "--short"], { encoding: "utf8" })
    };

    const preview = runJson(rootDir, ["task", "complete", taskId, "--dry-run"], true, executionActorEnv);

    assert.equal(preview.status, "in_review");
    assert.equal(typeof preview.completionGate, "object");
    assert.equal(preview.report.schema, "task-complete-dry-run/v1");
    assert.equal(preview.report.preflight.schema, "task-complete-preflight/v1");
    assert.equal(preview.report.preflight.status, "blocked");
    const issues = preview.report.preflight.issues as ReadonlyArray<Record<string, string>>;
    assert.deepEqual(new Set(issues.map((issue) => issue.code)), new Set([
      "commit_completion_git_ref_missing",
      "closeout_placeholder",
      "code_doc_anchors_missing",
      "execution_review_required"
    ]));
    assert.equal(issues.every((issue) => typeof issue.nextCommand === "string" && issue.nextCommand.length > 0), true);
    assert.match(issues.find((issue) => issue.code === "execution_review_required")?.message ?? "", /human consent/iu);
    assert.equal(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), before.index);
    assert.equal(execFileSync("git", ["-C", path.join(rootDir, "harness"), "status", "--short"], { encoding: "utf8" }), before.harnessStatus);
    assert.equal(existsSync(path.join(taskRoot, "code-doc-anchors.json")), false);
    assert.equal(existsSync(path.join(taskRoot, "reviews")), false);
    assert.equal(existsSync(path.join(taskRoot, "consents")), false);
  });
});

test("task complete dry-run projects the canonical planned status for an open task", () => {
  withTempRoot((rootDir) => {
    const taskId = "task-open-completion-preview";
    initializeNestedHarnessRepo(rootDir);
    writeIndex(rootDir, taskId, "Open Completion Preview", "planned");
    writeSubstantiveTaskPlan(rootDir, `harness/tasks/${taskId}`);

    const preview = runJson(rootDir, ["task", "complete", taskId, "--dry-run"], true, executionActorEnv);

    assert.equal(preview.status, "planned");
    assert.equal(preview.completionGate.axes.canonicalStatus, "planned");
    assert.equal(preview.completionGate.axes.coordinationStatus, "open");
  });
});

test("task complete dry-run projects the canonical done status for a terminal task", () => {
  withTempRoot((rootDir) => {
    const taskId = "task-terminal-completion-preview";
    initializeNestedHarnessRepo(rootDir);
    writeIndex(rootDir, taskId, "Terminal Completion Preview", "done");
    writeSubstantiveTaskPlan(rootDir, `harness/tasks/${taskId}`);

    const preview = runJson(rootDir, ["task", "complete", taskId, "--dry-run"], true, executionActorEnv);

    assert.equal(preview.status, "done");
    assert.equal(preview.completionGate.axes.canonicalStatus, "done");
    assert.equal(preview.completionGate.axes.coordinationStatus, "terminal");
  });
});

test("task complete preflight blocks approval and reconciliation writes when closeout is incomplete", () => {
  withTempRoot((rootDir) => {
    const taskId = "task_01KX7H00000000000000000004";
    const submittedExecutionId = "exe_01KX7H00000000000000000005";
    initializeNestedHarnessRepo(rootDir);
    writeIndex(rootDir, taskId, "Blocking Completion Preflight", "in_review");
    writeSubstantiveTaskPlan(rootDir, `harness/tasks/${taskId}`);
    writeFileSync(path.join(rootDir, `harness/tasks/${taskId}/closeout.md`), "# Closeout\n\n## Summary\n\nSummarize the completed behavior change.\n", "utf8");
    writeSubmittedExecution(rootDir, taskId, submittedExecutionId);
    mkdirSync(path.join(rootDir, "evidence"), { recursive: true });
    writeFileSync(path.join(rootDir, "evidence/preflight-anchor.txt"), "completion preflight anchor\n", "utf8");
    execFileSync("git", ["-C", rootDir, "init", "-q"]);
    execFileSync("git", ["-C", rootDir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", rootDir, "config", "user.name", "Test User"]);
    execFileSync("git", ["-C", rootDir, "add", "evidence/preflight-anchor.txt"]);
    execFileSync("git", ["-C", rootDir, "commit", "-m", "seed preflight anchor"]);
    const approvalPath = path.join(rootDir, "approval.json");
    writeFileSync(approvalPath, JSON.stringify({
      executionId: submittedExecutionId,
      findings: "The submitted evidence was inspected.",
      rationale: "The delivery satisfies its acceptance checks.",
      consentAssertedRationale: "Approval was received through an external channel.",
      consentActions: ["approve_execution", "complete_task"],
      commit: "HEAD",
      paths: ["evidence/preflight-anchor.txt"],
      ci: "passed"
    }), "utf8");
    const taskRoot = path.join(rootDir, `harness/tasks/${taskId}`);

    const rejected = runJson(rootDir, [
      "task", "complete", taskId, "--approve", "--from-file", approvalPath
    ], false, executionActorEnv);

    assert.equal(rejected.error?.code, "closeout_placeholder");
    assert.equal(rejected.report.preflight.status, "blocked");
    assert.equal(rejected.issues.find((issue: Record<string, string>) => issue.code === "execution_review_required")?.disposition, "planned");
    assert.equal(rejected.issues.find((issue: Record<string, string>) => issue.code === "code_doc_anchors_missing")?.disposition, "planned");
    assert.equal(existsSync(path.join(taskRoot, "code-doc-anchors.json")), false);
    assert.equal(existsSync(path.join(taskRoot, "reviews")), false);
    assert.equal(existsSync(path.join(taskRoot, "consents")), false);
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /status: in_review/u);
  });
});

test("task complete successful dry-run exposes completion fields without completing the task", () => {
  withTempRoot((rootDir) => {
    const taskId = "task_01KX7H00000000000000000006";
    const submittedExecutionId = "exe_01KX7H00000000000000000007";
    prepareCommitCompletionTask(rootDir, taskId, false);
    seedApprovedExecution(rootDir, taskId, submittedExecutionId);
    const taskRoot = path.join(rootDir, `harness/tasks/${taskId}`);
    const before = {
      index: readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"),
      anchors: readFileSync(path.join(taskRoot, "code-doc-anchors.json"), "utf8"),
      harnessStatus: execFileSync("git", ["-C", path.join(rootDir, "harness"), "status", "--short"], { encoding: "utf8" })
    };

    const preview = runJson(rootDir, ["task", "complete", taskId, "--dry-run"], true, executionActorEnv);

    assert.equal(preview.status, "in_review");
    assert.equal(preview.completionGate.ok, true);
    assert.equal(preview.report.preflight.status, "ready");
    assert.deepEqual(preview.report.preflight.issues, []);
    assert.equal(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), before.index);
    assert.equal(readFileSync(path.join(taskRoot, "code-doc-anchors.json"), "utf8"), before.anchors);
    assert.equal(execFileSync("git", ["-C", path.join(rootDir, "harness"), "status", "--short"], { encoding: "utf8" }), before.harnessStatus);
    assert.equal(existsSync(path.join(taskRoot, "completion-evidence.json")), false);
  });
});

test("task complete resolves workspace Git from the canonical root when invoked through the authored repository", () => {
  withTempRoot((rootDir) => {
    const taskId = "task-canonical-completion-git-root";
    const anchoredSha = prepareCommitCompletionTask(rootDir, taskId, false);

    const completed = runJson(path.join(rootDir, "harness"), [
      "task", "complete", taskId,
      "--commit-anchor", anchoredSha,
      "--judgment", "The canonical workspace commit completes this task.",
      "--ci", "passed"
    ], true, executionActorEnv);

    assert.equal(completed.status, "done");
    assert.equal(completed.completionEvidence.sha, anchoredSha);
  });
});

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
  const acceptedCiCase = (
    taskId: string,
    ci: "failed" | "missing"
  ) => withTempRoot((rootDir) => {
    const anchoredSha = prepareCommitCompletionTask(rootDir, taskId, false);
    const args = ["task", "complete", taskId, "--commit-anchor", anchoredSha, "--judgment", "The commit completes this task."];
    if (ci !== "missing") args.push("--ci", ci);
    const completed = runJson(rootDir, args, true, executionActorEnv);

    assert.equal(completed.status, "done");
    assert.equal(existsSync(path.join(rootDir, `harness/tasks/${taskId}/completion-evidence.json`)), true);
  });

  rejectedCase("task-unknown-commit", () => "a".repeat(40), "commit_completion_git_ref_missing");
  rejectedCase("task-blob-anchor", (rootDir) => execFileSync(
    "git", ["-C", rootDir, "hash-object", "-w", "--stdin"], { input: "not a commit\n", encoding: "utf8" }
  ).trim(), "commit_completion_non_commit_object");
  rejectedCase("task-private-anchor", (rootDir) => execFileSync(
    "git", ["-C", path.join(rootDir, "harness"), "rev-parse", "HEAD"], { encoding: "utf8" }
  ).trim(), "commit_completion_git_ref_missing");
  acceptedCiCase("task-ci-failed-anchor", "failed");
  acceptedCiCase("task-ci-missing-anchor", "missing");
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

function writeSubmittedExecution(rootDir: string, taskId: string, submittedExecutionId: string): void {
  mkdirSync(path.join(rootDir, `harness/tasks/${taskId}/executions`), { recursive: true });
  writeFileSync(path.join(rootDir, `harness/tasks/${taskId}/executions/${submittedExecutionId}.md`), `${JSON.stringify({
    schema: "execution/v1",
    execution_id: submittedExecutionId,
    task_ref: `task/${taskId}`,
    state: "submitted",
    primary_actor: {
      principal: { personId: "worker" },
      executor: { kind: "agent", id: "worker-agent" },
      responsibleHuman: "worker"
    },
    claimed_at: "2026-07-31T00:00:00.000Z",
    submitted_at: "2026-07-31T00:01:00.000Z",
    closed_at: null,
    session_bindings: [{ role: "primary", archive_status: "complete" }],
    outputs: [],
    submission: { summary: "submitted", verification: ["tests passed"], residual_risks: [] }
  }, null, 2)}\n`, "utf8");
}
