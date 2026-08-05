// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";
import { initializeGitRepo, runGit, runJson, withTempRoot, writeCloseout } from "./helpers/task-document-gates-fixtures.ts";

test("coldstart lifecycle submits and completes with visible unavailable provenance when default runtime capture is absent", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["task", "create", "--title", "Structured Submit", "--vertical", "software/coding", "--preset", "standard-task"]);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);
    const sessionId = "codex-structured-submit";
    const homeDir = path.join(rootDir, "home");
    mkdirSync(homeDir, { recursive: true });
    const env = { HOME: homeDir, CODEX_THREAD_ID: sessionId, CODEX_SESSION_ID: sessionId, HARNESS_ACTOR: "agent:worker" };
    const claimed = runJson(rootDir, ["task", "claim", created.taskId], true, env);
    runJson(rootDir, ["task", "transition", created.taskId, "active"], true, env);
    writeCloseout(rootDir, path.basename(created.packagePath), [
      "## Summary", "", "Implemented the structured completion facade.", "",
      "## Verification", "", "node --test completion-facade-cli.test.ts passed.", "",
      "## Residual Risk", "", "Review remains an independent human judgment."
    ]);
    initializeGitRepo(rootDir);
    mkdirSync(path.join(rootDir, "evidence"), { recursive: true });
    writeFileSync(path.join(rootDir, "evidence/facade.txt"), "completion facade evidence\n", "utf8");
    runGit(rootDir, "add", "evidence/facade.txt");
    runGit(rootDir, "commit", "-m", "seed completion facade evidence");
    const evidenceSha = runGit(rootDir, "rev-parse", "HEAD");
    const packetPath = path.join(rootDir, "submission.json");
    writeFileSync(packetPath, JSON.stringify({
      completionClaim: "The structured facade preserves execution submission semantics.",
      deliverables: ["task submit facade"],
      outputs: ["integration passed"],
      verificationNotes: ["node --test completion-facade-cli.test.ts"],
      knownGaps: [],
      residualRisks: ["review remains independent"]
    }), "utf8");

    const submitted = runJson(rootDir, ["task", "submit", created.taskId, "--from-file", packetPath], true, env);
    assert.equal(submitted.command, "task-submit");
    assert.equal(submitted.executionId, claimed.executionId);
    assert.equal(submitted.status, "in_review");
    assert.equal(submitted.report.schema, "execution-submit-result/v1");
    assert.deepEqual(submitted.report.unavailableBindings, [{
      bindingId: `primary:${sessionId}`,
      sessionRef: `session/${sessionId}`,
      archiveStatus: "unavailable"
    }]);
    assert.equal(existsSync(path.join(rootDir, created.packagePath, "code-doc-anchors.json")), false);
    const execution = JSON.parse(readFileSync(path.join(rootDir, created.packagePath, "executions", `${claimed.executionId}.md`), "utf8"));
    assert.deepEqual(execution.submission, {
      completion_claim: "The structured facade preserves execution submission semantics.",
      deliverables: ["task submit facade"],
      evidence_refs: ["ev_cli_1"],
      verification_notes: ["node --test completion-facade-cli.test.ts"],
      known_gaps: [],
      residual_risks: ["review remains independent"]
    });
    assert.equal(execution.outputs[0].locator.text, "integration passed");
    assert.equal(execution.session_bindings[0].archive_status, "unavailable");
    assert.equal(existsSync(path.join(rootDir, "harness/sessions", `${sessionId}.md`)), false);

    const reviewPacketPath = path.join(rootDir, "approval.json");
    writeFileSync(reviewPacketPath, JSON.stringify({
      findings: "The structured submission satisfies the acceptance checks.",
      rationale: "The evidence and verification note cover the Task intent.",
      evidenceChecked: ["ev_cli_1"],
      archiveWarningsAcknowledged: true,
      consentAssertedRationale: "Approval was received through an external channel.",
      consentActions: ["approve_execution", "complete_task"],
      ci: "passed", paths: ["evidence/facade.txt"], reviewerId: "person_reviewer"
    }), "utf8");
    const rejected = runJson(rootDir, [
      "--actor", "human:person_test", "task", "complete", created.taskId, "--approve", "--from-file", reviewPacketPath
    ], false, env);
    assert.match(rejected.error.hint, /daemon-planned canonical transition/iu);
    assert.equal(existsSync(path.join(rootDir, created.packagePath, "code-doc-anchors.json")), false);
    assert.equal(evidenceSha.length, 40);
    assert.match(readFileSync(path.join(rootDir, created.packagePath, "INDEX.md"), "utf8"), /^  status: in_review$/mu);
  });
});

test("owner coldstart approves after the submitted execution lease is released", () => {
  withTempRoot((rootDir) => {
    const chain = prepareSubmitted(rootDir, "Cold Owner Approval", "facade");
    const holder = runJson(rootDir, ["task", "holder", chain.taskId]);
    assert.equal(holder.report.effectiveHolder, null);

    const ownerHome = path.join(rootDir, "owner-home");
    mkdirSync(ownerHome, { recursive: true });
    const rejected = runJson(rootDir, [
      "--actor", "human:person_test", "task", "complete", chain.taskId,
      "--approve", "--from-file", writeRetryApprovalPacket(rootDir)
    ], false, { HOME: ownerHome, HARNESS_TASK_LEASE_ENFORCEMENT: "1" });

    assert.match(rejected.error.hint, /daemon-planned canonical transition/iu);
    assert.match(readFileSync(path.join(rootDir, chain.packagePath, "INDEX.md"), "utf8"), /^  status: in_review$/mu);
  });
});

test("task complete dry-run blocks when the canonical authority planner is unavailable", () => {
  withTempRoot((rootDir) => {
    const chain = prepareSubmitted(rootDir, "Review Evidence Preflight", "facade");
    const packetPath = path.join(rootDir, "invalid-review-evidence-approval.json");
    writeFileSync(packetPath, JSON.stringify({
      executionId: chain.executionId,
      findings: "The submitted evidence was inspected.",
      evidenceChecked: ["F-NOT-AN-EXECUTION-OUTPUT"],
      rationale: "The approval packet must be validated before Review writes.",
      consentAssertedRationale: "Approval was received through an external channel.",
      consentActions: ["approve_execution", "complete_task"],
      ci: "passed",
      paths: ["evidence/equivalence.txt"],
      reviewerId: "person_reviewer"
    }), "utf8");

    const preview = runJson(rootDir, [
      "--actor", "human:person_test", "task", "complete", chain.taskId,
      "--approve", "--from-file", packetPath, "--dry-run"
    ], false, chain.env);

    assert.equal(preview.ok, false, JSON.stringify(preview));
    assert.equal(preview.error.code, "write_rejected");
    assert.match(preview.error.hint, /canonical authority planner is unavailable/iu);
    assert.equal(existsSync(path.join(rootDir, chain.packagePath, "reviews")), false);
    assert.match(readFileSync(path.join(rootDir, chain.packagePath, "INDEX.md"), "utf8"), /^  status: in_review$/mu);
  });
});

test("direct recovery does not consume an accepted Review outside the daemon planner", () => {
  withTempRoot((rootDir) => {
    const chain = prepareSubmitted(rootDir, "Accepted Review Convergence", "facade");
    runJson(rootDir, [
      "--actor", "human:person_test", "task", "review-execution", chain.taskId,
      "--execution-id", chain.executionId, "--verdict", "approved",
      "--findings", "The independently reviewed delivery satisfies the task.",
      "--evidence-checked", "ev_cli_1",
      "--rationale", "The existing Review is already sufficient for completion.",
      "--consent-asserted", "Approval was received through an external channel.",
      "--consent-action", "approve_execution", "--consent-action", "complete_task"
    ], true, chain.env);

    const rejected = runJson(rootDir, [
      "--actor", "human:person_test", "task", "complete", chain.taskId,
      "--approve", "--from-file", writeRetryApprovalPacket(rootDir)
    ], false, chain.env);

    assert.match(rejected.error.hint, /daemon-planned canonical transition/iu);
    assert.match(readFileSync(path.join(rootDir, chain.packagePath, "INDEX.md"), "utf8"), /^  status: in_review$/mu);
  });
});

test("direct recovery cannot resume completion from former facade boundaries", () => {
  for (const breakpoint of ["review", "reconcile", "complete"] as const) {
    withTempRoot((rootDir) => {
      const chain = prepareSubmitted(rootDir, `Retry After ${breakpoint}`, "facade");
      const packetPath = writeRetryApprovalPacket(rootDir);
      const approvalCommand = [
        "--actor", "human:person_test", "task", "complete", chain.taskId,
        "--approve", "--from-file", packetPath
      ] as const;

      if (breakpoint === "review" || breakpoint === "reconcile") {
        runEquivalentApprovalReview(rootDir, chain);
      }
      if (breakpoint === "reconcile") {
        runJson(rootDir, [
          "--actor", "human:person_test", "task", "code-doc", "reconcile", chain.taskId,
          "--commit", chain.sha, "--path", "evidence/equivalence.txt", "--force"
        ], true, chain.env);
      }
      if (breakpoint === "complete") {
        const first = runJson(rootDir, approvalCommand, false, chain.env);
        assert.match(first.error.hint, /daemon-planned canonical transition/iu);
      }

      const retried = runJson(rootDir, approvalCommand, false, chain.env);
      const taskRoot = path.join(rootDir, chain.packagePath);
      assert.match(retried.error.hint, /daemon-planned canonical transition/iu);
      assert.equal(readdirSync(path.join(taskRoot, "executions")).length, 1, breakpoint);
      assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: in_review$/mu, breakpoint);
    });
  }
});

test("task submit does not gate a milestone on decision lineage", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, [
      "task", "create", "--title", "Lineage Before Submit",
      "--vertical", "software/coding", "--preset", "create-milestone"
    ]);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);
    runJson(rootDir, ["task", "transition", created.taskId, "active"]);
    const claimed = runJson(rootDir, [
      "task", "claim", created.taskId, "--execution"
    ], true, { HARNESS_ACTOR: "agent:worker" });
    const packetPath = path.join(rootDir, "submission-missing-lineage.json");
    writeFileSync(packetPath, JSON.stringify({
      completionClaim: "The milestone implementation is ready for review.",
      deliverables: ["milestone implementation"],
      outputs: ["integration tests passed"],
      verificationNotes: ["node --test completion-facade-cli.test.ts"],
      knownGaps: [],
      residualRisks: []
    }), "utf8");

    const rejected = runJson(rootDir, [
      "task", "submit", created.taskId, "--from-file", packetPath
    ], false, { HARNESS_ACTOR: "agent:worker" });

    assert.doesNotMatch(rejected.error?.hint ?? "", /decision.*derives|lineage/u);
    assert.match(String(claimed.executionId), /^exe_/u);
  });
});

test("task submit dry-run lists its single internal submit transaction", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["task", "create", "--title", "Submit Stop Point", "--vertical", "software/coding", "--preset", "standard-task"]);
    writeSubstantiveTaskPlan(rootDir, created.packagePath);
    const sessionId = "codex-submit-stop-point";
    const homeDir = path.join(rootDir, "home");
    mkdirSync(path.join(homeDir, ".codex/sessions"), { recursive: true });
    writeFileSync(path.join(homeDir, ".codex/sessions", `${sessionId}.jsonl`), JSON.stringify({
      timestamp: "2026-07-18T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "submit task" }
    }), "utf8");
    const env = { HOME: homeDir, CODEX_THREAD_ID: sessionId, CODEX_SESSION_ID: sessionId, HARNESS_ACTOR: "agent:worker" };
    const claimed = runJson(rootDir, ["task", "claim", created.taskId], true, env);
    runJson(rootDir, ["task", "transition", created.taskId, "active"], true, env);
    const packetPath = path.join(rootDir, "submission-invalid-anchor.json");
    writeFileSync(packetPath, JSON.stringify({
      completionClaim: "Ready for review.",
      deliverables: ["facade"], outputs: ["evidence"], verificationNotes: ["tests"], knownGaps: [], residualRisks: []
    }), "utf8");

    const dryRun = runJson(rootDir, ["task", "submit", created.taskId, "--from-file", packetPath, "--dry-run"], true, env);
    assert.equal(dryRun.command, "task-submit");
    assert.equal(dryRun.status, "in_review");
    assert.equal(dryRun.report.schema, "task-submit-transition-preview/v1");
    assert.equal(dryRun.report.disposition, "server-planner-validation-required");
    assert.equal(dryRun.report.preview.schema, "command-dry-run-preview/v1");
    assert.equal(dryRun.report.preview.operation, "task-submit");

    const submitted = runJson(rootDir, ["task", "submit", created.taskId, "--from-file", packetPath], true, env);
    assert.equal(submitted.executionId, claimed.executionId);
    assert.equal(submitted.status, "in_review");
    assert.equal(submitted.report.schema, "execution-submit-result/v1");
    const execution = JSON.parse(readFileSync(path.join(rootDir, created.packagePath, "executions", `${claimed.executionId}.md`), "utf8"));
    assert.equal(execution.state, "submitted");
    assert.equal(execution.submission.completion_claim, "Ready for review.");
  });
});

test("structured and legacy direct completion inputs share the daemon-only boundary", () => {
  withTempRoot((manualRoot) => withTempRoot((facadeRoot) => {
    const manual = prepareSubmitted(manualRoot, "Direct Boundary Manual", "flags");
    const facade = prepareSubmitted(facadeRoot, "Direct Boundary Structured", "facade");
    const manualRejected = runJson(manualRoot, [
      "task", "complete", manual.taskId, "--reviewer", "person_reviewer"
    ], false, manual.env);
    const facadeRejected = runJson(facadeRoot, [
      "task", "complete", facade.taskId, "--approve", "--from-file", writeRetryApprovalPacket(facadeRoot)
    ], false, facade.env);
    assert.equal(manualRejected.error.code, facadeRejected.error.code);
    assert.match(manualRejected.error.hint, /daemon-planned canonical transition/iu);
    assert.match(facadeRejected.error.hint, /daemon-planned canonical transition/iu);
  }));
});

test("review facade preserves the approved-consent rejection code and logical stop point", () => {
  withTempRoot((manualRoot) => withTempRoot((facadeRoot) => {
    const manual = prepareSubmitted(manualRoot, "Consent Negative Manual", "flags");
    const facade = prepareSubmitted(facadeRoot, "Consent Negative Facade", "facade");
    const manualNotReviewed = runJson(manualRoot, [
      "task", "complete", manual.taskId, "--ci", "passed", "--reviewer", "person_reviewer"
    ], false, { HARNESS_ACTOR: "agent:commander" });
    runJson(facadeRoot, [
      "task", "code-doc", "reconcile", facade.taskId,
      "--commit", facade.sha, "--path", "evidence/equivalence.txt"
    ], true, facade.env);
    const facadeNotReviewed = runJson(facadeRoot, [
      "task", "complete", facade.taskId, "--ci", "passed", "--reviewer", "person_reviewer"
    ], false, { HARNESS_ACTOR: "agent:commander" });
    assert.equal(facadeNotReviewed.ok, false);
    assert.equal(manualNotReviewed.ok, false);
    assert.equal(facadeNotReviewed.error.code, manualNotReviewed.error.code);
    assert.notEqual(facadeNotReviewed.error.code, "execution_review_required");
    assert.notEqual(manualNotReviewed.error.code, "execution_review_required");
    assert.match(facadeNotReviewed.error.hint, /daemon-planned canonical transition/iu);
    const manualRejected = runJson(manualRoot, [
      "task", "review-execution", manual.taskId, "--execution-id", manual.executionId,
      "--verdict", "approved", "--findings", "Evidence is valid.",
      "--rationale", "Approval still requires explicit human consent."
    ], false, { HARNESS_ACTOR: "agent:reviewer" });
    const packetPath = path.join(facadeRoot, "review-no-consent.json");
    writeFileSync(packetPath, JSON.stringify({
      verdict: "approved", findings: "Evidence is valid.",
      rationale: "Approval still requires explicit human consent.", evidenceChecked: [],
      archiveWarningsAcknowledged: false
    }), "utf8");
    const facadeRejected = runJson(facadeRoot, [
      "task", "review-execution", facade.taskId, "--from-file", packetPath
    ], false, { HARNESS_ACTOR: "agent:reviewer" });
    assert.equal(facadeRejected.command, manualRejected.command);
    assert.equal(facadeRejected.error.code, manualRejected.error.code);
    assert.equal(normalizeDynamicText(facadeRejected.error.hint), normalizeDynamicText(manualRejected.error.hint));
    const reviewsRoot = path.join(facadeRoot, facade.packagePath, "reviews");
    assert.equal(existsSync(reviewsRoot) ? readdirSync(reviewsRoot).length : 0, 0);
  }));
});

test("typed task submit preserves the missing-holder rejection and next action", () => {
  withTempRoot((rootDir) => {
    const task = prepareActiveWithoutClaim(rootDir);
    const packetPath = path.join(rootDir, "submit-no-holder.json");
    writeFileSync(packetPath, JSON.stringify({
      completionClaim: "ready", deliverables: [], outputs: [], verificationNotes: [], knownGaps: [], residualRisks: []
    }), "utf8");
    const rejected = runJson(rootDir, [
      "task", "submit", task.taskId, "--from-file", packetPath
    ], false, { HARNESS_ACTOR: "agent:worker" });
    assert.equal(rejected.command, "task-submit");
    assert.equal(rejected.error.code, "write_rejected");
    assert.match(rejected.error.hint, /task start/u);
    assert.equal(existsSync(path.join(rootDir, task.packagePath, "code-doc-anchors.json")), false);
  });
});

type ChainMode = "flags" | "facade";

function prepareActiveWithoutClaim(rootDir: string): {
  readonly taskId: string; readonly packagePath: string; readonly evidenceSha: string;
} {
  const created = runJson(rootDir, ["task", "create", "--title", "Missing Holder", "--vertical", "software/coding", "--preset", "standard-task"]);
  writeSubstantiveTaskPlan(rootDir, created.packagePath);
  runJson(rootDir, ["task", "transition", created.taskId, "active"], true, { HARNESS_ACTOR: "agent:worker" });
  writeCloseout(rootDir, path.basename(created.packagePath), [
    "## Summary", "", "Prepared a partial-failure receipt probe.", "",
    "## Verification", "", "The code-doc step commits before the lease rejection.", "",
    "## Residual Risk", "", "The submission must remain rejected without a Holder."
  ]);
  initializeGitRepo(rootDir);
  mkdirSync(path.join(rootDir, "evidence"), { recursive: true });
  writeFileSync(path.join(rootDir, "evidence/missing-holder.txt"), "partial failure evidence\n", "utf8");
  runGit(rootDir, "add", "evidence/missing-holder.txt");
  runGit(rootDir, "commit", "-m", "seed partial failure evidence");
  return { taskId: created.taskId, packagePath: created.packagePath, evidenceSha: runGit(rootDir, "rev-parse", "HEAD") };
}

function prepareSubmitted(rootDir: string, title: string, mode: ChainMode): {
  readonly taskId: string; readonly packagePath: string; readonly executionId: string; readonly env: Record<string, string>;
  readonly submitSteps: ReadonlyArray<Record<string, unknown>>; readonly sha: string;
} {
  const created = runJson(rootDir, ["task", "create", "--title", title, "--vertical", "software/coding", "--preset", "standard-task"]);
  writeSubstantiveTaskPlan(rootDir, created.packagePath);
  const sessionId = "codex-completion-equivalence";
  const homeDir = path.join(rootDir, "home");
  mkdirSync(path.join(homeDir, ".codex/sessions"), { recursive: true });
  writeFileSync(path.join(homeDir, ".codex/sessions", `${sessionId}.jsonl`), JSON.stringify({
    timestamp: "2026-07-18T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "complete task" }
  }), "utf8");
  const env = { HOME: homeDir, CODEX_THREAD_ID: sessionId, CODEX_SESSION_ID: sessionId, HARNESS_ACTOR: "agent:worker" };
  const claimed = runJson(rootDir, ["task", "claim", created.taskId], true, env);
  const executionId = String(claimed.executionId);
  runJson(rootDir, ["task", "transition", created.taskId, "active"], true, env);
  writeCloseout(rootDir, path.basename(created.packagePath), [
    "## Summary", "", "Implemented the completion facade.", "",
    "## Verification", "", "Integration passed.", "",
    "## Residual Risk", "", "Human approval remains required."
  ]);
  initializeGitRepo(rootDir);
  mkdirSync(path.join(rootDir, "evidence"), { recursive: true });
  writeFileSync(path.join(rootDir, "evidence/equivalence.txt"), "equivalent evidence\n", "utf8");
  runGit(rootDir, "add", "evidence/equivalence.txt");
  runGit(rootDir, "commit", "-m", "seed equivalent evidence");
  const sha = runGit(rootDir, "rev-parse", "HEAD");
  const submission = {
    completionClaim: "The completion chain is ready for independent review.",
    deliverables: ["structured completion facade"], outputs: ["integration evidence"],
    verificationNotes: ["completion facade integration passed"], knownGaps: ["none observed"],
    residualRisks: ["human approval remains required"]
  };
  let submitSteps: ReadonlyArray<Record<string, unknown>>;
  if (mode === "flags") {
    const codeDocReceipt = runJson(rootDir, [
      "task", "code-doc", "reconcile", created.taskId, "--commit", sha, "--path", "evidence/equivalence.txt"
    ], true, env);
    const submitReceipt = runJson(rootDir, [
      "task", "submit", created.taskId, "--from-file", writeSubmissionPacket(rootDir, submission),
      "--execution-id", executionId
    ], true, env);
    submitSteps = [codeDocReceipt, submitReceipt];
  } else {
    const packetPath = path.join(rootDir, "equivalent-submission.json");
    writeFileSync(packetPath, JSON.stringify(submission), "utf8");
    const submitReceipt = runJson(rootDir, ["task", "submit", created.taskId, "--from-file", packetPath], true, env);
    submitSteps = [submitReceipt];
  }
  return { taskId: created.taskId, packagePath: created.packagePath, executionId, env, submitSteps, sha };
}

function writeSubmissionPacket(rootDir: string, submission: Record<string, unknown>): string {
  const packetPath = path.join(rootDir, "equivalent-flags-submission.json");
  writeFileSync(packetPath, JSON.stringify(submission), "utf8");
  return packetPath;
}

function writeRetryApprovalPacket(rootDir: string): string {
  const packetPath = path.join(rootDir, "retry-approval.json");
  writeFileSync(packetPath, JSON.stringify({
    findings: "All acceptance checks passed.",
    evidenceChecked: ["ev_cli_1"],
    rationale: "The submitted evidence satisfies the Task intent.",
    archiveWarningsAcknowledged: false,
    consentAssertedRationale: "Approval was received through an external channel.",
    consentActions: ["approve_execution", "complete_task"],
    ci: "passed",
    paths: ["evidence/equivalence.txt"],
    reviewerId: "person_reviewer"
  }), "utf8");
  return packetPath;
}

function runEquivalentApprovalReview(
  rootDir: string,
  chain: ReturnType<typeof prepareSubmitted>
): void {
  runJson(rootDir, [
    "--actor", "human:person_test", "task", "review-execution", chain.taskId,
    "--execution-id", chain.executionId, "--verdict", "approved",
    "--findings", "All acceptance checks passed.", "--evidence-checked", "ev_cli_1",
    "--rationale", "The submitted evidence satisfies the Task intent.",
    "--consent-asserted", "Approval was received through an external channel.",
    "--consent-action", "approve_execution", "--consent-action", "complete_task"
  ], true, chain.env);
}

function normalizeDynamicText(value: string): string {
  return value
    .replace(/(?:task|exe|rev|cns|cons)_[0-9A-HJKMNP-TV-Z]+/gu, "<DYNAMIC_ID>")
    .replace(/human-cli-\d+/gu, "<HUMAN_SESSION>")
    .replace(/distill_\d+_[0-9a-f]+/gu, "<DISTILL_ID>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/gu, "<TIMESTAMP>")
    .replace(/sha256:[0-9a-f]{64}/gu, "sha256:<DIGEST>")
    .replace(/[0-9a-f]{64}/gu, "<DIGEST>")
    .replace(/[0-9a-f]{40}/gu, "<COMMIT_SHA>")
    .replace(/\d{13}-[0-9a-f-]+/gu, "<WATERMARK>");
}
