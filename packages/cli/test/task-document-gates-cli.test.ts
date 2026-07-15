// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";
import {
  initializeGitRepo,
  runGit,
  runJson,
  seedApprovedExecution,
  withTempRoot,
  writeCloseout,
  writeCodeDocAnchors,
  writeCodeDocAnchorsRaw,
  writeExecution,
  writeFact,
  writeIndex,
  writeRealCloseout,
  writeReview
} from "./helpers/task-document-gates-fixtures.ts";

const executionTaskId = "task_01KX7H00000000000000000000";
const executionId = "exe_01KX7H00000000000000000001";
const milestoneTaskId = "task_01KX7H00000000000000000002";
const milestoneExecutionId = "exe_01KX7H00000000000000000002";
const milestoneChildTaskId = "task_01KX7H00000000000000000003";
const milestoneChildExecutionId = "exe_01KX7H00000000000000000003";
// Execution role checks compare the CLI actor's executor against the execution's
// executor; pin the actor instead of inheriting whatever the invoking shell has.
const testActorEnv = { HARNESS_ACTOR: "agent:test" };

test("CLI active transition rejects an untouched standard-task scaffold plan", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["task", "create", "--title", "Scaffold Plan", "--vertical", "software/coding", "--preset", "standard-task", "--locale", "zh-CN"]);
    assert.match(readFileSync(path.join(rootDir, created.packagePath, "task_plan.md"), "utf8"), /一句话说明任务目标与范围。/u);
    const blocked = runJson(rootDir, ["task", "transition", created.taskId, "active"], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "task_plan_placeholder");
    assert.match(blocked.error?.hint ?? "", /task_plan\.md/u);
    assert.match(blocked.error?.hint ?? "", /substantive implementation plan/u);
    assert.doesNotMatch(readFileSync(path.join(rootDir, created.packagePath, "INDEX.md"), "utf8"), /^  status: active$/mu);
  });
});

test("CLI active transition accepts a substantive task plan", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["task", "create", "--title", "Substantive Plan", "--vertical", "software/coding", "--preset", "standard-task"]);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);

    const transitioned = runJson(rootDir, ["task", "transition", created.taskId, "active"]);

    assert.equal(transitioned.ok, true);
    assert.equal(transitioned.status, "active");
  });
});

test("CLI active transition fails closed when task_plan.md is missing", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["task", "create", "--title", "Missing Plan", "--vertical", "software/coding", "--preset", "standard-task"]);
    rmSync(path.join(rootDir, created.packagePath, "task_plan.md"));

    const checked = runJson(rootDir, ["check", "--profile", "source-package", "--strict"], false);
    const transitioned = runJson(rootDir, ["task", "transition", created.taskId, "active"], false);

    assert.equal(checked.warnings.some((warning: Record<string, unknown>) => warning.code === "task_plan_missing"), true);
    assert.equal(transitioned.error?.code, "task_plan_placeholder");
    assert.match(transitioned.error?.hint ?? "", /Restore task_plan\.md/u);
  });
});

test("CLI in_review requires an Execution submission even after a valid active transition", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["task", "create", "--title", "Existing Active", "--vertical", "software/coding", "--preset", "standard-task"]);
    const taskPlanPath = path.join(rootDir, created.packagePath, "task_plan.md");
    const scaffold = readFileSync(taskPlanPath, "utf8");
    writeSubstantiveTaskPlan(rootDir, created.packagePath);
    runJson(rootDir, ["task", "transition", created.taskId, "active"]);
    writeFileSync(taskPlanPath, scaffold, "utf8");

    const transitioned = runJson(rootDir, ["task", "transition", created.taskId, "in_review"], false);

    assert.equal(transitioned.ok, false);
    assert.equal(transitioned.error?.code, "execution_submission_required");
    assert.match(readFileSync(path.join(rootDir, created.packagePath, "INDEX.md"), "utf8"), /^  status: active$/mu);
  });
});

test("CLI check and active transition agree on scaffold and substantive task plans", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["task", "create", "--title", "Two-sided Plan Gate", "--vertical", "software/coding", "--preset", "standard-task"]);
    const scaffoldCheck = runJson(rootDir, ["check", "--profile", "source-package", "--strict"], false);
    const scaffoldTransition = runJson(rootDir, ["task", "transition", created.taskId, "active"], false);

    assert.equal(scaffoldCheck.warnings.some((warning: Record<string, unknown>) => warning.code === "task_plan_placeholder"), true);
    assert.equal(scaffoldTransition.error?.code, "task_plan_placeholder");

    writeSubstantiveTaskPlan(rootDir, created.packagePath);
    const substantiveCheck = runJson(rootDir, ["check", "--profile", "source-package", "--strict"]);
    const substantiveTransition = runJson(rootDir, ["task", "transition", created.taskId, "active"]);

    assert.equal(substantiveCheck.warnings.some((warning: Record<string, unknown>) => warning.code === "task_plan_placeholder"), false);
    assert.equal(substantiveTransition.ok, true);
  });
});

test("CLI task-complete without Execution fails closed and leaves INDEX byte-exact", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-1", "Complete Task", "in_review");
    writeReview(rootDir, "task-1");
    writeFact(rootDir, "task-1");
    writeCloseout(rootDir, "task-1", [
      "## Summary",
      "",
      "Summarize the completed behavior change.",
      "",
      "## Verification",
      "",
      "List passing checks and CI.",
      "",
      "## Residual Risk",
      "",
      "Record accepted non-blocking risks."
    ]);

    const blocked = runJson(rootDir, ["task-complete", "task-1", "--reviewer", "reviewer-a", "--ci", "passed"], false);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "closeout_placeholder");
    assert.match(blocked.error?.hint ?? "", new RegExp(path.join(rootDir, "harness/tasks/task-1").replaceAll("\\", "\\\\"), "u"));

    writeRealCloseout(rootDir, "task-1");
    const indexPath = path.join(rootDir, "harness/tasks/task-1/INDEX.md");
    const before = readFileSync(indexPath, "utf8");

    const blockedWithoutExecution = runJson(rootDir, ["task-complete", "task-1", "--reviewer", "reviewer-a", "--ci", "passed"], false);
    assert.equal(blockedWithoutExecution.ok, false);
    assert.equal(blockedWithoutExecution.error?.code, "execution_completion_required");
    assert.equal(JSON.stringify(blockedWithoutExecution).includes("executionId"), false);
    assert.equal(readFileSync(indexPath, "utf8"), before);
  });
});

test("CLI task-complete reports every currently unmet completion requirement", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, executionTaskId, "Aggregate Completion Gates", "in_review");
    writeCloseout(rootDir, executionTaskId, [
      "## Summary", "", "Summarize the completed behavior change.", "",
      "## Verification", "", "List passing checks and CI.", "",
      "## Residual Risk", "", "Record accepted non-blocking risks."
    ]);
    writeExecution(rootDir, executionTaskId, executionId, "test");

    const blocked = runJson(rootDir, [
      "task", "complete", executionTaskId, "--reviewer", "reviewer-a"
    ], false, testActorEnv);
    const issueCodes = blocked.issues.map((issue: Record<string, unknown>) => issue.code);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "closeout_placeholder");
    assert.deepEqual(issueCodes, [
      "closeout_placeholder",
      "code_doc_anchors_missing",
      "missing_ci_gate",
      "execution_actor_cannot_complete",
      "execution_review_required"
    ]);
    assert.match(blocked.error?.hint ?? "", /5 unmet requirements/u);
    assert.match(blocked.error?.hint ?? "", /ha task code-doc reconcile/u);
    assert.match(blocked.error?.hint ?? "", /--ci passed/u);
    assert.match(blocked.error?.hint ?? "", /different authenticated executor/u);
    assert.match(blocked.error?.hint ?? "", /ha task review-execution/u);
  });
});

test("CLI typed completion does not require filling the legacy review placeholder", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, executionTaskId, "Complete Task", "in_review");
    writeFact(rootDir, executionTaskId);
    writeFileSync(path.join(rootDir, `harness/tasks/${executionTaskId}/review.md`), [
      "# Review",
      "",
      "Status: not-started",
      "",
      "## Reviewer",
      "",
      "- Agent: pending",
      "- Mode: read-only review before merge",
      "",
      "## Findings",
      "",
      "| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ""
    ].join("\n"), "utf8");
    writeRealCloseout(rootDir, executionTaskId);
    seedApprovedExecution(rootDir, executionTaskId, executionId);

    const completed = runJson(rootDir, ["task-complete", executionTaskId, "--reviewer", "reviewer-a", "--ci", "passed"]);
    assert.equal(completed.ok, true);
    assert.equal(completed.executionId, executionId);
    assert.equal(completed.status, "done");

    const checked = runJson(rootDir, ["check", "--post-merge"]);
    assert.equal(checked.warnings.some((warning: Record<string, unknown>) => warning.code === "review_placeholder"), false);
  });
});

test("CLI typed completion remains blocked by a substantive open legacy release finding", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, executionTaskId, "Complete Task", "in_review");
    writeFileSync(path.join(rootDir, `harness/tasks/${executionTaskId}/review.md`), [
      "# Review",
      "",
      "| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      "| F-001 | P1 | Release invariant is unverified. | typed execution | Verify it. | yes | open | yes | none |",
      ""
    ].join("\n"), "utf8");
    writeRealCloseout(rootDir, executionTaskId);
    seedApprovedExecution(rootDir, executionTaskId, executionId);

    const blocked = runJson(rootDir, ["task-complete", executionTaskId, "--reviewer", "reviewer-a", "--ci", "passed"], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "release_blocking_findings");
    assert.match(readFileSync(path.join(rootDir, `harness/tasks/${executionTaskId}/INDEX.md`), "utf8"), /^  status: in_review$/mu);
    assert.equal(JSON.parse(readFileSync(path.join(rootDir, `harness/tasks/${executionTaskId}/executions/${executionId}.md`), "utf8")).state, "submitted");
  });
});

test("CLI task-complete rejects missing code-doc anchors", () => {
  withTempRoot((rootDir) => {
    initializeGitRepo(rootDir);
    writeIndex(rootDir, "task-1", "Complete Task", "in_review");
    writeReview(rootDir, "task-1");
    writeFact(rootDir, "task-1");
    writeCloseout(rootDir, "task-1", [
      "## Summary",
      "",
      "Implemented the task document gate.",
      "",
      "## Verification",
      "",
      "npm run check passed.",
      "",
      "## Residual Risk",
      "",
      "No residual risk accepted."
    ]);
    writeIndex(rootDir, executionTaskId, "Complete Task", "in_review");
    writeCloseout(rootDir, executionTaskId, [
      "## Summary", "", "Implemented the task document gate.", "",
      "## Verification", "", "npm run check passed.", "",
      "## Residual Risk", "", "No residual risk accepted."
    ]);
    seedApprovedExecution(rootDir, executionTaskId, executionId);

    const blocked = runJson(rootDir, ["task-complete", executionTaskId, "--reviewer", "reviewer-a", "--ci", "passed"], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "code_doc_reconciliation_failed");
    assert.equal(blocked.issues?.[0]?.code, "code_doc_anchors_missing");
  });
});

test("CLI task-complete rejects fabricated code-doc shas", () => {
  withTempRoot((rootDir) => {
    initializeGitRepo(rootDir);
    writeIndex(rootDir, executionTaskId, "Complete Task", "in_review");
    writeReview(rootDir, executionTaskId);
    writeFact(rootDir, executionTaskId);
    writeRealCloseout(rootDir, executionTaskId);
    writeCodeDocAnchorsRaw(rootDir, executionTaskId, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    seedApprovedExecution(rootDir, executionTaskId, executionId);

    const blocked = runJson(rootDir, ["task-complete", executionTaskId, "--reviewer", "reviewer-a", "--ci", "passed"], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "code_doc_reconciliation_failed");
    assert.equal(blocked.issues?.[0]?.code, "code_doc_git_ref_missing");
  });
});

test("CLI task-complete reports the underlying completion write failure", () => {
  withTempRoot((rootDir) => {
    initializeGitRepo(rootDir);
    writeIndex(rootDir, executionTaskId, "Complete Task", "in_review");
    writeReview(rootDir, executionTaskId);
    writeFact(rootDir, executionTaskId);
    writeRealCloseout(rootDir, executionTaskId, { coordinatedAnchors: false });
    seedApprovedExecution(rootDir, executionTaskId, executionId);
    writeIndex(rootDir, executionTaskId, "Complete Task", "in_review", { provenance: false });

    const blocked = runJson(rootDir, ["task-complete", executionTaskId, "--reviewer", "reviewer-a", "--ci", "passed"], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "malformed_snapshot");
    assert.match(blocked.error?.hint, /Completion task-tree staging failed\./);
    assert.match(blocked.error?.hint, /minItems\(1\)|Expected a refinement/);
  });
});

test("CLI task-review accepts a task without facts under dec_mrg3z1we/CH4", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-1", "Review Task", "in_review");
    writeReview(rootDir, "task-1");

    // dec_mrg3z1we/CH4: Fact is an explicit 0..N promotion, never a review quantity gate.
    const reviewed = runJson(rootDir, ["task-review", "task-1", "--reviewer", "reviewer-a"]);

    assert.equal(reviewed.ok, true);
    assert.equal(reviewed.command, "task-review");
    assert.equal(reviewed.data?.reviewContract?.schema ?? reviewed.reviewContract?.schema, "verifier-backed-review/v1");
  });
});

test("CLI task-review invalid severity error enumerates valid severity values", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-1", "Review Task", "in_review");
    writeFact(rootDir, "task-1");
    writeFileSync(path.join(rootDir, "harness/tasks/task-1/review.md"), [
      "# Review",
      "",
      "| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      "| F-001 | P9 | Bad severity. | test | Fix severity. | yes | open | yes | none |",
      ""
    ].join("\n"), "utf8");

    const blocked = runJson(rootDir, ["task", "review", "task-1", "--reviewer", "reviewer-a"], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "review_schema_invalid");
    assert.match(blocked.error?.hint ?? "", /Valid severity values: P0, P1, P2, P3/u);
  });
});

test("CLI task-review accepts a task with a real fact", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-1", "Review Task", "in_review");
    writeReview(rootDir, "task-1");
    writeFact(rootDir, "task-1");

    const passed = runJson(rootDir, ["task-review", "task-1", "--reviewer", "reviewer-a"]);

    assert.equal(passed.ok, true);
    assert.equal(passed.command, "task-review");
    assert.equal(passed.data?.reviewContract?.schema ?? passed.reviewContract?.schema, "verifier-backed-review/v1");
  });
});

test("CLI task-review stages legacy artifacts while task-complete without Execution fails closed", () => {
  withTempRoot((rootDir) => {
    const harnessRepo = path.join(rootDir, "harness");
    initializeGitRepo(rootDir);
    writeFileSync(path.join(rootDir, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
    writeIndex(rootDir, "task-1", "Review Task", "in_review");
    writeFact(rootDir, "task-1");
    runGit(rootDir, "add", ".gitignore");
    runGit(rootDir, "commit", "-m", "seed task");
    runGit(harnessRepo, "add", "tasks/task-1/INDEX.md", "tasks/task-1/facts.md");
    runGit(harnessRepo, "commit", "-m", "seed task");

    writeReview(rootDir, "task-1");
    assert.match(runGit(harnessRepo, "status", "--short"), /review\.md/);

    const reviewed = runJson(rootDir, ["task-review", "task-1", "--reviewer", "reviewer-a"]);
    assert.equal(reviewed.ok, true);
    assert.equal(runGit(harnessRepo, "status", "--short"), "");
    assert.match(runGit(harnessRepo, "log", "--oneline", "--all"), /task\(task-tree-stage\): task-1 task package/);

    writeRealCloseout(rootDir, "task-1");
    assert.match(runGit(harnessRepo, "status", "--short"), /closeout\.md/);

    const completed = runJson(rootDir, ["task-complete", "task-1", "--reviewer", "reviewer-a", "--ci", "passed"], false);
    assert.equal(completed.ok, false);
    assert.equal(completed.error?.code, "execution_completion_required");
    assert.match(readFileSync(path.join(rootDir, "harness/tasks/task-1/INDEX.md"), "utf8"), /^  status: in_review$/mu);
    assert.equal(runGit(harnessRepo, "status", "--short"), "");
    assert.match(runGit(harnessRepo, "log", "--oneline", "--all"), /task\(task-tree-stage\): task-1 task package/);
  });
});

test("CLI task-review ignores facts.md quantity under dec_mrg3z1we/CH4", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-1", "Review Task", "in_review");
    writeReview(rootDir, "task-1");
    writeFileSync(path.join(rootDir, "harness/tasks/task-1/facts.md"), "# Facts\n\n- TODO: record a fact before closeout.\n", "utf8");

    // dec_mrg3z1we/CH4: zero parsed F- records is a valid review input.
    const reviewed = runJson(rootDir, ["task-review", "task-1", "--reviewer", "reviewer-a"]);

    assert.equal(reviewed.ok, true);
    assert.equal(reviewed.data?.reviewContract?.schema ?? reviewed.reviewContract?.schema, "verifier-backed-review/v1");
  });
});

test("CLI task-complete without Execution fails even when no Fact quantity gate applies", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-1", "Complete Task", "in_review");
    writeReview(rootDir, "task-1");
    writeRealCloseout(rootDir, "task-1");

    // dec_mrg3z1we/CH4 removes only the Fact quantity gate; review, closeout,
    // code-doc reconciliation, and completion gates still run on this path.
    const completed = runJson(rootDir, ["task-complete", "task-1", "--reviewer", "reviewer-a", "--ci", "passed"], false);

    assert.equal(completed.ok, false);
    assert.equal(completed.error?.code, "execution_completion_required");
  });
});

test("CLI Review verdict rejects unknown values before writing", () => {
  withTempRoot((rootDir) => {
    const blocked = runJson(rootDir, [
      "task", "review-execution", executionTaskId,
      "--execution-id", executionId,
      "--verdict", "direction_changed",
      "--findings", "Change direction."
    ], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "invalid_task_metadata");
    assert.match(blocked.error?.hint ?? "", /approved, changes_requested, dismissed/u);
  });
});

test("CLI complete accepts an approved Execution Review without facts under dec_mrg3z1we/CH4", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, executionTaskId, "Execution Complete", "in_review");
    writeRealCloseout(rootDir, executionTaskId);
    writeExecution(rootDir, executionTaskId, executionId, "worker-agent");

    const missingReview = runJson(rootDir, ["task", "complete", executionTaskId, "--reviewer", "reviewer-a", "--ci", "passed"], false, testActorEnv);
    assert.equal(missingReview.ok, false);
    assert.match(missingReview.error?.hint ?? "", /approved Review/u);

    const reviewed = runJson(rootDir, [
      "task", "review-execution", executionTaskId,
      "--execution-id", executionId,
      "--verdict", "approved",
      "--findings", "All acceptance checks passed.",
      "--rationale", "The submission satisfies the Task intent."
    ], true, testActorEnv);
    assert.equal(reviewed.ok, true);
    assert.equal(reviewed.executionId, executionId);
    assert.match(String(reviewed.reviewId), /^rev_/u);

    writeExecution(rootDir, executionTaskId, executionId, "test");
    const selfComplete = runJson(rootDir, ["task", "complete", executionTaskId, "--reviewer", "reviewer-a", "--ci", "passed"], false, testActorEnv);
    assert.match(selfComplete.error?.hint ?? "", /executor cannot complete/u);
    writeExecution(rootDir, executionTaskId, executionId, "worker-agent");

    // dec_mrg3z1we/CH4: approved Review and completion gates do not imply a Fact quantity gate.
    const completed = runJson(rootDir, ["task", "complete", executionTaskId, "--reviewer", "reviewer-a", "--ci", "passed"], true, testActorEnv);
    assert.equal(completed.ok, true);
    assert.equal(completed.executionId, executionId);
    assert.equal(completed.status, "done");
    const taskRoot = path.join(rootDir, "harness/tasks", executionTaskId);
    assert.equal(JSON.parse(readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8")).state, "accepted");
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: done$/mu);
  });
});

test("CLI default claim carries one person's task through submit, review, and complete", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["task", "create", "--title", "Single Person Closeout", "--vertical", "software/coding", "--preset", "standard-task"]);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);
    const sessionId = "codex-single-person-closeout";
    const homeDir = path.join(rootDir, "home");
    const sessionDir = path.join(homeDir, ".codex/sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path.join(sessionDir, `${sessionId}.jsonl`), [
      JSON.stringify({ timestamp: "2026-07-12T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "close task" } }),
      JSON.stringify({ timestamp: "2026-07-12T00:00:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ready" }] } })
    ].join("\n"), "utf8");
    const sessionEnv = { HOME: homeDir, CODEX_THREAD_ID: sessionId, CODEX_SESSION_ID: sessionId };

    const claimed = runJson(rootDir, ["task", "claim", created.taskId], true, { ...sessionEnv, HARNESS_ACTOR: "agent:worker" });
    assert.match(String(claimed.executionId), /^exe_/u);
    writeCloseout(rootDir, path.basename(created.packagePath), [
      "## Summary", "", "Implemented the single-person closeout flow.", "",
      "## Verification", "", "node --test passed.", "",
      "## Residual Risk", "", "No residual risk accepted."
    ]);
    writeCodeDocAnchors(rootDir, created.taskId);

    const submitted = runJson(rootDir, [
      "task", "transition", created.taskId, "in_review",
      "--lease-token", String(claimed.report.leaseToken),
      "--summary", "implementation complete", "--verification", "node --test"
    ], true, { ...sessionEnv, HARNESS_ACTOR: "agent:worker" });
    assert.equal(submitted.executionId, claimed.executionId);

    runJson(rootDir, [
      "task", "review-execution", created.taskId, "--execution-id", String(claimed.executionId),
      "--verdict", "approved", "--findings", "Acceptance checks passed",
      "--rationale", "The submitted work satisfies the task intent"
    ], true, { HARNESS_ACTOR: "agent:reviewer" });
    const completed = runJson(rootDir, [
      "task", "complete", created.taskId, "--reviewer", "reviewer", "--ci", "passed"
    ], true, { HARNESS_ACTOR: "agent:commander" });
    assert.equal(completed.status, "done");
    assert.equal(completed.executionId, claimed.executionId);
  });
});

test("CLI milestone completion requires active decision derives lineage while a leaf task does not", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, milestoneTaskId, "Milestone", "in_review", { preset: "create-milestone", taskClass: "milestone" });
    writeReview(rootDir, milestoneTaskId);
    writeRealCloseout(rootDir, milestoneTaskId);
    const anchorSha = runGit(rootDir, "rev-parse", "HEAD");

    const blocked = runJson(rootDir, ["task", "complete", milestoneTaskId, "--reviewer", "reviewer-a", "--ci", "passed"], false);
    assert.equal(blocked.error?.code, "closeout_not_ready");
    assert.match(blocked.error?.hint ?? "", new RegExp(`decision.*derives.*${milestoneTaskId}`, "u"));

    runJson(rootDir, [
      "decision", "propose", "--id", "dec_MILESTONE_LINEAGE", "--title", "Milestone lineage",
      "--question", "Should this milestone exist?", "--chosen", "Create the milestone",
      "--rejected", "Do nothing", "--why-not", "The work requires coordination",
      "--claim", "The milestone is required."
    ]);
    runJson(rootDir, [
      "decision", "relate", "dec_MILESTONE_LINEAGE", "--anchor", "CH1", "--type", "derives",
      "--target", `task/${milestoneTaskId}`, "--rationale", "The charter decision creates the milestone"
    ]);
    writeIndex(rootDir, milestoneChildTaskId, "Long Running Child", "in_review", { preset: "long-running-task", parent: milestoneTaskId });
    writeReview(rootDir, milestoneChildTaskId);
    writeRealCloseout(rootDir, milestoneChildTaskId, { sha: anchorSha });
    seedApprovedExecution(rootDir, milestoneChildTaskId, milestoneChildExecutionId);
    const childCompleted = runJson(rootDir, ["task", "complete", milestoneChildTaskId, "--reviewer", "reviewer-a", "--ci", "passed"]);
    assert.equal(childCompleted.status, "done");
    seedApprovedExecution(rootDir, milestoneTaskId, milestoneExecutionId);
    const completed = runJson(rootDir, ["task", "complete", milestoneTaskId, "--reviewer", "reviewer-a", "--ci", "passed"]);
    assert.equal(completed.status, "done");
  });
});

test("CLI rejects executor self-review and changes_requested opens a fresh claim round", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, executionTaskId, "Execution Rework", "in_review");
    writeExecution(rootDir, executionTaskId, executionId, "test");
    const selfReview = runJson(rootDir, [
      "task", "review-execution", executionTaskId,
      "--execution-id", executionId,
      "--verdict", "approved",
      "--findings", "Self approved.",
      "--rationale", "Self review must still be rejected."
    ], false, testActorEnv);
    assert.match(selfReview.error?.hint ?? "", /executor cannot review/u);

    writeExecution(rootDir, executionTaskId, executionId, "worker-agent");
    const requested = runJson(rootDir, [
      "task", "review-execution", executionTaskId,
      "--execution-id", executionId,
      "--verdict", "changes_requested",
      "--findings", "Add the missing regression test.",
      "--rationale", "The current delivery is semantically insufficient."
    ], true, testActorEnv);
    assert.equal(requested.ok, true);
    const taskRoot = path.join(rootDir, "harness/tasks", executionTaskId);
    assert.equal(JSON.parse(readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8")).state, "changes_requested");
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: active$/mu);

    const claimed = runJson(rootDir, ["task", "claim", executionTaskId, "--execution"], true, testActorEnv);
    assert.notEqual(claimed.executionId, executionId);
    assert.equal(existsSync(path.join(taskRoot, "executions", `${claimed.executionId}.md`)), true);
  });
});
