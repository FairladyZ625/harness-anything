// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";
import { initializeGitRepo, runGit, runJson, withTempRoot, writeCloseout } from "./helpers/task-document-gates-fixtures.ts";

const workerEnv = {
  HARNESS_ACTOR: "agent:facade-worker",
  HARNESS_DAEMON_MODE: "direct",
  HARNESS_DIRECT_WRITE_REASON: "recovery"
};
process.env.HARNESS_DAEMON_MODE = "direct";
process.env.HARNESS_DIRECT_WRITE_REASON = "recovery";
const sourceRepoRoot = path.resolve(import.meta.dirname, "../../..");

test("task start returns the reusable execution lease and stops at active", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["task", "create", "--title", "Facade Start", "--vertical", "software/coding", "--preset", "standard-task"]);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);
    const prepared = prepareSession(rootDir, "codex-facade-start");
    const started = runJson(rootDir, ["task", "start", created.taskId], true, prepared);
    assert.equal(started.command, "task-start");
    assert.equal(started.status, "active");
    assert.match(started.executionId, /^exe_/u);
    assert.equal(started.report.executionId, started.executionId);
    assert.equal(started.report.schema, "task-start-result/v1");
    assert.match(started.report.leaseToken, /^[0-9a-f]{64}$/u);
    assert.match(started.report.leaseExpiresAt, /^20/u);
    assert.equal(started.report.steps, undefined);
    assert.match(readFileSync(path.join(rootDir, created.packagePath, "INDEX.md"), "utf8"), /^  status: active$/mu);
  });
});

test("direct recovery mode refuses to recreate the deleted task-complete facade", () => {
  withTempRoot((rootDir) => {
    const fixture = prepareActiveTask(rootDir, "Two Command Boundary");
    const submissionPacket = writeSubmissionPacket(rootDir);
    const approvalPacket = writeApprovalPacket(rootDir);
    const closeoutCommands = [
      ["task", "submit", fixture.taskId, "--from-file", submissionPacket],
      ["--actor", "human:person_test", "task", "complete", fixture.taskId, "--approve", "--from-file", approvalPacket]
    ] as const;

    const submitted = runJson(rootDir, closeoutCommands[0], true, {
      ...fixture.env,
      HARNESS_DAEMON_MODE: "fixture"
    });
    const taskRoot = path.join(rootDir, fixture.packagePath);
    const submittedExecution = JSON.parse(readFileSync(path.join(taskRoot, "executions", `${fixture.executionId}.md`), "utf8"));
    assert.equal(closeoutCommands.length, 2);
    assert.equal(submitted.command, "task-submit");
    assert.equal(submitted.executionId, fixture.executionId);
    assert.equal(submitted.status, "in_review");
    assert.equal(submitted.report.schema, "execution-submit-result/v1");
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: in_review$/mu);
    assert.equal(submittedExecution.state, "submitted");
    assert.equal(submittedExecution.session_bindings[0].archive_status, "complete");
    assert.equal(existsSync(path.join(rootDir, "harness/sessions", `${fixture.sessionId}.md`)), true);
    const rejected = runJson(rootDir, closeoutCommands[1], false, fixture.env);
    assert.equal(rejected.error.code, "write_rejected");
    assert.match(rejected.error.hint, /daemon-planned canonical transition.+direct recovery cannot recreate/iu);
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: in_review$/mu);
    const reviewsRoot = path.join(taskRoot, "reviews");
    assert.equal(existsSync(reviewsRoot) ? readdirSync(reviewsRoot).length : 0, 0);
    assert.equal(existsSync(path.join(taskRoot, "code-doc-anchors.json")), false);
  });
});

test("direct recovery never derives owner approval outside the daemon planner", () => {
  withTempRoot((rootDir) => {
    const fixture = prepareActiveTask(rootDir, "Owner Boundary Negative");
    runJson(rootDir, ["task", "submit", fixture.taskId, "--from-file", writeSubmissionPacket(rootDir)], true, {
      ...fixture.env,
      HARNESS_DAEMON_MODE: "fixture"
    });

    const rejected = runJson(rootDir, ["task", "complete", fixture.taskId, "--ci", "passed"], false, fixture.env);

    assert.equal(rejected.error.code, "write_rejected");
    assert.doesNotMatch(rejected.error.code, /execution_review_required/iu);
    assert.match(rejected.error.hint, /daemon-planned canonical transition.+direct recovery cannot recreate/iu);
    assert.match(readFileSync(path.join(rootDir, fixture.packagePath, "INDEX.md"), "utf8"), /^  status: in_review$/mu);
    const reviewsRoot = path.join(rootDir, fixture.packagePath, "reviews");
    assert.equal(existsSync(reviewsRoot) ? readdirSync(reviewsRoot).length : 0, 0);
  });
});

test("approved closeout without consent is rejected before any lifecycle write", () => {
  withTempRoot((rootDir) => {
    const fixture = prepareActiveTask(rootDir, "Missing Consent");
    const packet = writeCloseoutPacket(rootDir, { omitConsent: true });
    const taskRoot = path.join(rootDir, fixture.packagePath);
    const indexBefore = readFileSync(path.join(taskRoot, "INDEX.md"), "utf8");
    const executionPath = path.join(taskRoot, "executions", `${fixture.executionId}.md`);
    const executionBefore = readFileSync(executionPath, "utf8");
    const holderPath = path.join(rootDir, ".harness/task-holders", `${fixture.taskId}.json`);
    const holderBefore = readFileSync(holderPath, "utf8");

    const rejected = runJson(rootDir, ["task", "closeout", fixture.taskId, "--from-file", packet], false, fixture.env);

    assert.equal(rejected.error.code, "invalid_task_metadata");
    assert.match(rejected.error.hint, /approved closeout requires exactly one consent source/iu);
    assert.equal(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), indexBefore);
    assert.equal(readFileSync(executionPath, "utf8"), executionBefore);
    assert.equal(readFileSync(holderPath, "utf8"), holderBefore);
    const reviewsRoot = path.join(taskRoot, "reviews");
    assert.equal(existsSync(reviewsRoot) ? readdirSync(reviewsRoot).length : 0, 0);
  });
});

test("changes_requested closeout packet cannot complete the submitted task", () => {
  withTempRoot((rootDir) => {
    const fixture = prepareActiveTask(rootDir, "Changes Requested Is Not Approval");
    runJson(rootDir, ["task", "submit", fixture.taskId, "--from-file", writeSubmissionPacket(rootDir)], true, {
      ...fixture.env,
      HARNESS_DAEMON_MODE: "fixture"
    });
    const packet = writeCloseoutPacket(rootDir, { verdict: "changes_requested" });
    const taskRoot = path.join(rootDir, fixture.packagePath);
    const indexBefore = readFileSync(path.join(taskRoot, "INDEX.md"), "utf8");

    const rejected = runJson(rootDir, ["task", "closeout", fixture.taskId, "--from-file", packet], false, fixture.env);

    assert.equal(rejected.error.code, "invalid_task_metadata");
    assert.match(rejected.error.hint, /only accepts verdict approved.+review-execution.+changes_requested/iu);
    assert.equal(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), indexBefore);
    assert.match(indexBefore, /^  status: in_review$/mu);
    const reviewsRoot = path.join(taskRoot, "reviews");
    assert.equal(existsSync(reviewsRoot) ? readdirSync(reviewsRoot).length : 0, 0);
  });
});

test("closeout dry-run satisfies its receipt contract without inventing execution state", () => {
  withTempRoot((rootDir) => {
    const fixture = prepareActiveTask(rootDir, "Dry Run Contract");
    const packet = writeCloseoutPacket(rootDir);
    const taskRoot = path.join(rootDir, fixture.packagePath);
    const indexBefore = readFileSync(path.join(taskRoot, "INDEX.md"), "utf8");

    const previewed = runJson(rootDir, ["task", "closeout", fixture.taskId, "--from-file", packet, "--dry-run"], true, fixture.env);

    assert.equal(previewed.ok, true);
    assert.equal(previewed.command, "task-closeout");
    assert.equal(previewed.taskId, fixture.taskId);
    assert.equal(previewed.executionId, undefined);
    assert.equal(previewed.status, undefined);
    assert.equal(previewed.report.schema, "task-closeout-dry-run/v1");
    assert.equal(previewed.report.dryRun, true);
    assert.equal(previewed.report.preview.schema, "command-dry-run-preview/v1");
    assert.deepEqual(previewed.report.steps, ["task-complete"]);
    assert.equal(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), indexBefore);
  });
});

test("task submit held by another worker recommends waiting or contacting the holder, never claim", () => {
  withTempRoot((leaseRoot) => {
    const fixture = prepareActiveTask(leaseRoot, "Lost Lease");
    const packet = writeSubmissionPacket(leaseRoot);
    const rejected = runJson(leaseRoot, [
      "task", "submit", fixture.taskId, "--from-file", packet,
      "--execution-id", fixture.executionId, "--lease-token", fixture.leaseToken
    ], false, { HARNESS_ACTOR: "agent:different-worker", HARNESS_DAEMON_MODE: "fixture" });
    assert.equal(rejected.error.code, "write_rejected");
    assert.match(rejected.error.hint, /not held by the caller|requires an active lease/iu);
    assert.match(rejected.error.hint, /lease status active.+otherwise wait or contact the current holder/iu);
    assert.doesNotMatch(rejected.error.hint, /Next: run .+ha task claim/iu);
    assert.match(rejected.error.hint, new RegExp(`ha task start ${fixture.taskId}`, "u"));
  });
});

test("task retire-execution retires the caller-owned live round, rejects submitted rounds, and records an audit", () => {
  withTempRoot((liveRoot) => {
    const fixture = prepareActiveTask(liveRoot, "Retirement Live Lease");
    const taskRoot = path.join(liveRoot, fixture.packagePath);
    writeFileSync(
      path.join(taskRoot, "INDEX.md"),
      readFileSync(path.join(taskRoot, "INDEX.md"), "utf8").replace(/^(  status:\s*)active$/mu, "$1in_review"),
      "utf8"
    );
    const retired = runJson(liveRoot, [
      "task", "retire-execution", fixture.taskId,
      "--execution-id", fixture.executionId,
      "--reason", "abandoned worker claim"
    ], true, fixture.env);
    assert.equal(retired.executionId, fixture.executionId);
    assert.equal(retired.report.auditMarker, "STALE_EXECUTION_RETIRED_AUDIT");
    assert.equal(JSON.parse(readFileSync(path.join(taskRoot, "executions", `${fixture.executionId}.md`), "utf8")).state, "abandoned");
    const progress = readFileSync(path.join(taskRoot, "progress.md"), "utf8");
    assert.match(progress, new RegExp(`STALE_EXECUTION_RETIRED_AUDIT: execution=${fixture.executionId}`, "u"));
    assert.match(progress, /retiredBy=person:/u);
    assert.match(progress, /retiredAt=/u);
    assert.match(progress, /reason=abandoned worker claim/u);

    const claimed = runJson(liveRoot, ["task", "claim", fixture.taskId, "--execution"], true, fixture.env);
    assert.notEqual(claimed.executionId, fixture.executionId);
    runJson(liveRoot, [
      "task", "submit", fixture.taskId, "--from-file", writeSubmissionPacket(liveRoot)
    ], true, { ...fixture.env, HARNESS_DAEMON_MODE: "fixture" });
    runJson(liveRoot, [
      "task", "review-execution", fixture.taskId, "--execution-id", claimed.executionId,
      "--verdict", "approved", "--findings", "Replacement round passes.",
      "--rationale", "The replacement evidence satisfies the task.",
      "--consent-asserted", "The human approved through an external channel.",
      "--consent-action", "approve_execution", "--consent-action", "complete_task"
    ], true, fixture.env);
    assert.equal(
      JSON.parse(readFileSync(path.join(taskRoot, "executions", `${claimed.executionId}.md`), "utf8")).state,
      "accepted"
    );
  });

  withTempRoot((submittedRoot) => {
    const fixture = prepareActiveTask(submittedRoot, "Retirement Submitted");
    runJson(submittedRoot, [
      "task", "submit", fixture.taskId, "--from-file", writeSubmissionPacket(submittedRoot)
    ], true, { ...fixture.env, HARNESS_DAEMON_MODE: "fixture" });
    const rejected = runJson(submittedRoot, [
      "task", "retire-execution", fixture.taskId,
      "--execution-id", fixture.executionId,
      "--reason", "must not retire submitted"
    ], false, fixture.env);
    assert.equal(rejected.error.code, "write_rejected");
    assert.match(rejected.error.hint, /is submitted; only an active Execution/iu);
  });
});

test("in-review cancellation retires an unsubmitted Execution before audited terminal closure", () => {
  withTempRoot((rootDir) => {
    const fixture = prepareActiveTask(rootDir, "In Review Cancellation");
    const taskRoot = path.join(rootDir, fixture.packagePath);
    const indexPath = path.join(taskRoot, "INDEX.md");
    writeFileSync(
      indexPath,
      readFileSync(indexPath, "utf8").replace(/^(  status:\s*)active$/mu, "$1in_review"),
      "utf8"
    );
    runJson(rootDir, ["task", "release", fixture.taskId], true, fixture.env);

    const retired = runJson(rootDir, [
      "task", "retire-execution", fixture.taskId,
      "--execution-id", fixture.executionId,
      "--reason", "abandon unsubmitted review round"
    ], true, fixture.env);
    const cancelled = runJson(rootDir, [
      "task", "transition", fixture.taskId, "cancelled",
      "--force", "--reason", "review work was abandoned"
    ], true, { ...fixture.env, HARNESS_TASK_LEASE_ENFORCEMENT: "1" });

    assert.equal(retired.report.auditMarker, "STALE_EXECUTION_RETIRED_AUDIT");
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.forceAudit.marker, "FORCE_STATUS_SET_AUDIT");
    assert.equal(
      JSON.parse(readFileSync(path.join(taskRoot, "executions", `${fixture.executionId}.md`), "utf8")).state,
      "abandoned"
    );
    assert.match(readFileSync(indexPath, "utf8"), /^  status: cancelled$/mu);
    const progress = readFileSync(path.join(taskRoot, "progress.md"), "utf8");
    assert.match(progress, /STALE_EXECUTION_RETIRED_AUDIT/u);
    assert.match(progress, /FORCE_STATUS_SET_AUDIT: forced terminal status=cancelled; reason=review work was abandoned/u);
    assert.equal(runJson(rootDir, ["task", "holder", fixture.taskId]).report.effectiveHolder, null);
  });
});

test("return to planned requires explicit lease release and active Execution retirement", () => {
  withTempRoot((rootDir) => {
    const fixture = prepareActiveTask(rootDir, "Return To Idea Guard");
    const leaseEnv = { ...fixture.env, HARNESS_TASK_LEASE_ENFORCEMENT: "1" };

    const leased = runJson(rootDir, [
      "task", "transition", fixture.taskId, "planned"
    ], false, leaseEnv);
    assert.equal(leased.error.code, "task_return_to_idea_blocked");
    assert.match(leased.error.hint, new RegExp(`Execution ${fixture.executionId}`, "u"));
    assert.match(leased.error.hint, /person:.+\/agent:facade-worker/u);
    assert.match(leased.error.hint, new RegExp(`ha task release ${fixture.taskId}`, "u"));

    runJson(rootDir, ["task", "release", fixture.taskId], true, leaseEnv);
    const blockedWithoutLease = runJson(rootDir, [
      "task", "transition", fixture.taskId, "blocked"
    ], false, leaseEnv);
    assert.equal(blockedWithoutLease.error.code, "task_lease_required");
    assert.match(blockedWithoutLease.error.hint, /requires an active lease/iu);
    assert.match(readFileSync(path.join(rootDir, fixture.packagePath, "INDEX.md"), "utf8"), /^  status: active$/mu);

    const executing = runJson(rootDir, [
      "task", "transition", fixture.taskId, "planned"
    ], false, leaseEnv);
    assert.equal(executing.error.code, "task_return_to_idea_blocked");
    assert.match(executing.error.hint, new RegExp(
      `ha task retire-execution ${fixture.taskId} --execution-id ${fixture.executionId} --reason`,
      "u"
    ));

    runJson(rootDir, [
      "task", "retire-execution", fixture.taskId,
      "--execution-id", fixture.executionId,
      "--reason", "returning task to the idea inbox"
    ], true, leaseEnv);
    const planned = runJson(rootDir, [
      "task", "transition", fixture.taskId, "planned"
    ], true, leaseEnv);
    assert.equal(planned.status, "planned");

    const reacquireRequired = runJson(rootDir, [
      "task", "transition", fixture.taskId, "active"
    ], false, leaseEnv);
    assert.equal(reacquireRequired.ok, false);
    assert.match(reacquireRequired.error.hint, /requires an active lease/iu);
    assert.match(reacquireRequired.error.hint, new RegExp(`ha task start ${fixture.taskId}`, "u"));
    assert.match(readFileSync(path.join(rootDir, fixture.packagePath, "INDEX.md"), "utf8"), /^  status: planned$/mu);
  });
});

test("blocked task returns to planned without reacquiring a lease after cleanup", () => {
  withTempRoot((rootDir) => {
    const fixture = prepareActiveTask(rootDir, "Blocked Return To Idea");
    const leaseEnv = { ...fixture.env, HARNESS_TASK_LEASE_ENFORCEMENT: "1" };
    runJson(rootDir, ["task", "transition", fixture.taskId, "blocked"], true, leaseEnv);
    runJson(rootDir, ["task", "release", fixture.taskId], true, leaseEnv);
    runJson(rootDir, [
      "task", "retire-execution", fixture.taskId,
      "--execution-id", fixture.executionId,
      "--reason", "returning blocked task to the idea inbox"
    ], true, leaseEnv);

    const planned = runJson(rootDir, [
      "task", "transition", fixture.taskId, "planned"
    ], true, leaseEnv);

    assert.equal(planned.status, "planned");
    assert.match(readFileSync(path.join(rootDir, fixture.packagePath, "INDEX.md"), "utf8"), /^  status: planned$/mu);
  });
});

function prepareActiveTask(rootDir: string, title: string, preset = "standard-task"): {
  readonly taskId: string; readonly packagePath: string; readonly executionId: string; readonly leaseToken: string;
  readonly sha: string; readonly sessionId: string; readonly env: Record<string, string>;
} {
  mkdirSync(path.join(rootDir, "tools"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "tools/write-road-registry.json"),
    readFileSync(path.join(sourceRepoRoot, "tools/write-road-registry.json"), "utf8"),
    "utf8"
  );
  const created = runJson(rootDir, ["task", "create", "--title", title, "--vertical", "software/coding", "--preset", preset]);
  writeSubstantiveTaskPlan(rootDir, created.packagePath);
  const sessionId = `codex-${title.toLowerCase().replaceAll(" ", "-")}`;
  const env = prepareSession(rootDir, sessionId);
  const started = runJson(rootDir, ["task", "start", created.taskId], true, env);
  writeCloseout(rootDir, path.basename(created.packagePath), [
    "## Summary", "", "Implemented the task lifecycle facade.", "",
    "## Verification", "", "Targeted integration tests passed.", "",
    "## Residual Risk", "", "No residual risk observed."
  ]);
  initializeGitRepo(rootDir);
  mkdirSync(path.join(rootDir, "evidence"), { recursive: true });
  writeFileSync(path.join(rootDir, "evidence/facade.txt"), "facade evidence\n", "utf8");
  runGit(rootDir, "add", "evidence/facade.txt");
  runGit(rootDir, "commit", "-m", "seed facade evidence");
  return {
    taskId: created.taskId,
    packagePath: created.packagePath,
    executionId: String(started.executionId),
    leaseToken: String(started.report.leaseToken),
    sha: runGit(rootDir, "rev-parse", "HEAD"),
    sessionId,
    env
  };
}

function prepareSession(rootDir: string, sessionId: string): Record<string, string> {
  const homeDir = path.join(rootDir, "home");
  mkdirSync(path.join(homeDir, ".codex/sessions"), { recursive: true });
  writeFileSync(path.join(homeDir, ".codex/sessions", `${sessionId}.jsonl`), [
    JSON.stringify({ timestamp: "2026-07-20T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "work the task" } }),
    JSON.stringify({ timestamp: "2026-07-20T00:00:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ready" }] } })
  ].join("\n"), "utf8");
  return { ...workerEnv, HOME: homeDir, CODEX_THREAD_ID: sessionId, CODEX_SESSION_ID: sessionId };
}

function writeCloseoutPacket(rootDir: string, overrides: {
  readonly ci?: "passed" | "failed" | "not-applicable";
  readonly omitConsent?: boolean;
  readonly verdict?: "approved" | "changes_requested";
} = {}): string {
  const packet = path.join(rootDir, `closeout-${overrides.ci ?? "passed"}.json`);
  writeFileSync(packet, JSON.stringify({
    completionClaim: "The implementation is ready for review.",
    deliverables: ["lifecycle facade"], outputs: ["integration evidence"],
    verificationNotes: ["targeted tests passed"], knownGaps: [], residualRisks: ["none observed"],
    verdict: overrides.verdict ?? "approved", findings: "Acceptance checks passed.",
    rationale: "The evidence satisfies the task intent.", evidenceChecked: ["ev_cli_1"],
    ...(overrides.omitConsent ? {} : {
      consentAssertedRationale: "The human approved through an external channel.",
      consentActions: ["approve_execution", "complete_task"]
    }),
    ci: overrides.ci ?? "passed", paths: ["evidence/facade.txt"], reviewerId: "person_reviewer"
  }), "utf8");
  return packet;
}

function writeSubmissionPacket(rootDir: string): string {
  const packet = path.join(rootDir, "submission.json");
  writeFileSync(packet, JSON.stringify({
    completionClaim: "The implementation is ready for review.",
    deliverables: ["lifecycle facade"], outputs: ["integration evidence"],
    verificationNotes: ["targeted tests passed"], knownGaps: [], residualRisks: ["none observed"]
  }), "utf8");
  return packet;
}

function writeApprovalPacket(rootDir: string, ci: "passed" | "failed" | "not-applicable" = "passed"): string {
  const packet = path.join(rootDir, `approval-${ci}.json`);
  writeFileSync(packet, JSON.stringify({
    findings: "Acceptance checks passed.",
    rationale: "The evidence satisfies the task intent.", evidenceChecked: ["ev_cli_1"],
    consentAssertedRationale: "The owner approved through an external channel.",
    consentActions: ["approve_execution", "complete_task"],
    ci, paths: ["evidence/facade.txt"], reviewerId: "person_reviewer"
  }), "utf8");
  return packet;
}
