// harness-test-tier: integration
import assert from "node:assert/strict";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  defaultDaemonUserRoot,
  pollUntil,
  runDaemonCommand,
  runRawJsonMaybeFail,
  stopDaemon,
  waitForReceiptCommitted
} from "./helpers/daemon-cli.ts";
import { assertHelpOrder, cliHelp, packetTemplate } from "./helpers/cli-help-fixture.ts";
import {
  createFixture,
  git,
  writeColdCodexSessionLog
} from "./production-authority-canonical-ingress/fixture.ts";
import {
  placeholderCloseout,
  productionCloseout,
  productionPlan,
  publishSeededTaskFixture
} from "./helpers/canonical-task-publication-fixture.ts";
import {
  publishCloseout,
  withReviewedCompletionFixture
} from "./helpers/production-completion-fixture.ts";

test("completion help documents the canonical production sequence", () => {
  const fixture = createFixture();
  try {
    const submitHelp = cliHelp(fixture.repoRoot, ["task", "submit", "--help"]);
    assertHelpOrder(submitHelp, [
      "1. ha task start <task-id>",
      "2. ha task submit <task-id> --from-file submission.json",
      "releases it after the submitted round is published",
      "completion requires the task to remain unheld"
    ]);
    assert.deepEqual(packetTemplate(submitHelp), {
      completionClaim: "<what is complete>",
      deliverables: ["<delivered file, behavior, or result>"],
      outputs: ["<output evidence>"],
      verificationNotes: ["<verification command and result>"],
      knownGaps: [],
      residualRisks: []
    });
    const completeHelp = cliHelp(fixture.repoRoot, ["task", "complete", "--help"]);
    assertHelpOrder(completeHelp, [
      "Required sequence for --approve --from-file (after task submit released the Holder):",
      "1. git rev-parse HEAD",
      "2. ha task code-doc reconcile <task-id> --commit <approval.commit> --path <each-approval.paths-entry>",
      "3. ha task complete <task-id> --approve --from-file approval.json"
    ]);
    assert.deepEqual(packetTemplate(completeHelp), {
      findings: "<review findings>",
      rationale: "<why the evidence supports approval>",
      evidenceChecked: ["ev_cli_1"],
      archiveWarningsAcknowledged: true,
      consentAssertedRationale: "<how owner approval was obtained outside the bound transcript>",
      consentActions: ["approve_execution", "complete_task"],
      ci: "passed",
      commit: "<full 40-character public workspace commit SHA>",
      paths: ["<repo-relative delivered path>"],
      externalCheckpointRefs: []
    });
    const docSyncHelp = cliHelp(fixture.repoRoot, ["doc", "sync", "--help"]);
    assert.match(docSyncHelp, /doc sync --submit --path tasks\/task_01ABC\/task_plan\.md/u);
    const closeoutHelp = cliHelp(fixture.repoRoot, ["task", "closeout", "--help"]);
    assert.match(closeoutHelp, /--dry-run\s+Run the same canonical task-complete planner without writing\./u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("task complete automatically materializes unpublished task prose while dry-run remains read-only", { timeout: 90_000 }, async () => {
  await withReviewedCompletionFixture("complete-unpublished-closeout", {
    exercisePlanPublication: true,
    assertReleasedHolder: true
  }, async ({ fixture, taskId, taskRoot, approvalPath, closeoutPacketPath, env }) => {
    const artifactPath = path.join(taskRoot, "artifacts", "completion-evidence.md");
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, "# Initial evidence\n", "utf8");
    const artifactAdded = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "artifact", "add", taskId, artifactPath
    ], env);
    assert.equal(artifactAdded.status, 0, JSON.stringify(artifactAdded.receipt));
    const artifactSettlement = (((artifactAdded.receipt.details as {
      readonly data?: { readonly report?: { readonly docSync?: { readonly settlement?: unknown } } };
    } | undefined)?.data?.report?.docSync?.settlement) ?? artifactAdded.receipt.settlement) as {
      readonly receiptId?: unknown;
    } | undefined;
    assert.equal(typeof artifactSettlement?.receiptId, "string", JSON.stringify(artifactAdded.receipt));
    await waitForReceiptCommitted(fixture.repoRoot, String(artifactSettlement?.receiptId), env);
    const settledSetup = runRawJsonMaybeFail(fixture.repoRoot, ["materializer", "run"], env);
    assert.equal(settledSetup.status, 0, JSON.stringify(settledSetup.receipt));
    writeFileSync(artifactPath, "# Updated evidence\n\nThe tracked artifact changed before completion.\n", "utf8");
    writeFileSync(path.join(taskRoot, "task_plan.md"), productionPlan("Plan amended immediately before completion."));
    const headBeforeDryRun = git(fixture.authoredRoot, "rev-parse", "HEAD");

    const blockedCompleteDryRun = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "complete", taskId, "--approve", "--from-file", approvalPath, "--dry-run"
    ], env);
    const blockedCloseoutDryRun = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "closeout", taskId, "--from-file", closeoutPacketPath, "--dry-run"
    ], env);
    for (const blocked of [blockedCompleteDryRun, blockedCloseoutDryRun]) {
      assert.equal(blocked.status, 1, JSON.stringify(blocked.receipt));
      assert.match(JSON.stringify(blocked.receipt), /AUTHORITY_TASK_COMPLETE_PREPUBLISH_NOT_MATERIALIZED[\s\S]*closeout\.md/u);
    }
    const blockedErrors = [blockedCompleteDryRun, blockedCloseoutDryRun]
      .map(({ receipt }) => JSON.stringify(receipt).match(/AUTHORITY_TASK_COMPLETE_PREPUBLISH_NOT_MATERIALIZED[\s\S]*?closeout\.md/u)?.[0]);
    assert.deepEqual(
      blockedErrors.map((error) => error?.match(/^AUTHORITY_TASK_COMPLETE_PREPUBLISH_NOT_MATERIALIZED/u)?.[0]),
      [
        "AUTHORITY_TASK_COMPLETE_PREPUBLISH_NOT_MATERIALIZED",
        "AUTHORITY_TASK_COMPLETE_PREPUBLISH_NOT_MATERIALIZED"
      ]
    );
    for (const error of blockedErrors) assert.match(error ?? "", /closeout\.md/u);
    assert.equal(git(fixture.authoredRoot, "rev-parse", "HEAD"), headBeforeDryRun);
    const blockedCompleteReal = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "complete", taskId, "--approve", "--from-file", approvalPath
    ], env);
    assert.equal(blockedCompleteReal.status, 0, JSON.stringify(blockedCompleteReal.receipt));
    assert.equal(blockedCompleteReal.receipt.ok, true, JSON.stringify(blockedCompleteReal.receipt));
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: done$/mu);
    assert.equal(
      git(fixture.authoredRoot, "show", `HEAD:tasks/${taskId}-production-route/closeout.md`),
      readFileSync(path.join(taskRoot, "closeout.md"), "utf8").trim()
    );
    assert.equal(
      git(fixture.authoredRoot, "show", `HEAD:tasks/${taskId}-production-route/task_plan.md`),
      readFileSync(path.join(taskRoot, "task_plan.md"), "utf8").trim()
    );
    assert.equal(
      git(fixture.authoredRoot, "show", `HEAD:tasks/${taskId}-production-route/artifacts/completion-evidence.md`),
      readFileSync(artifactPath, "utf8").trim()
    );
  });
});

test("task complete reports file reason and repair when automatic doc sync rejects a task document", { timeout: 60_000 }, async () => {
  await withReviewedCompletionFixture("complete-auto-materialize-rejected", {
    exercisePlanPublication: true,
    assertReleasedHolder: true
  }, ({ fixture, taskId, taskRoot, approvalPath, env }) => {
    writeFileSync(
      path.join(taskRoot, "task_plan.md"),
      productionPlan("Invalid completion plan edit.").replace("## Goal", "## Objective"),
      "utf8"
    );
    const taskIndexBefore = readFileSync(path.join(taskRoot, "INDEX.md"), "utf8");
    const rejected = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "complete", taskId, "--approve", "--from-file", approvalPath
    ], env);

    assert.equal(rejected.status, 1, JSON.stringify(rejected.receipt));
    assert.match(
      String((rejected.receipt.error as { readonly code?: unknown } | undefined)?.code),
      /^task_complete_auto_materialization_/u
    );
    const diagnostic = JSON.stringify(rejected.receipt);
    assert.match(diagnostic, new RegExp(`file=tasks/${taskId}-production-route/task_plan\\.md`, "u"));
    assert.match(diagnostic, /reason=/u);
    assert.match(diagnostic, /fix=/u);
    assert.match(diagnostic, /ha doc status --json/u);
    assert.match(diagnostic, /ha doc sync --submit/u);
    assert.equal(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), taskIndexBefore);
  });
});

test("published completion dry-runs report checked gates without mutating holders", { timeout: 60_000 }, async () => {
  await withReviewedCompletionFixture("complete-ready-dry-run", {}, ({
    fixture, taskId, approvalPath, closeoutPacketPath, taskHolderRoot, env
  }) => {
    const closeoutDryRun = runRawJsonMaybeFail(fixture.repoRoot, ["doc", "sync", "--dry-run"], env);
    assert.equal(closeoutDryRun.status, 0, JSON.stringify(closeoutDryRun.receipt));
    assert.match(JSON.stringify(closeoutDryRun.receipt), /closeout\.md/u);
    publishCloseout(fixture.repoRoot, taskId, env);

    const holderFilesBeforeDryRun = snapshotDirectory(taskHolderRoot);
    const readyDryRun = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "complete", taskId, "--approve", "--from-file", approvalPath, "--dry-run"
    ], env);
    const readyCloseoutDryRun = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "closeout", taskId, "--from-file", closeoutPacketPath, "--dry-run"
    ], env);
    assert.deepEqual(snapshotDirectory(taskHolderRoot), holderFilesBeforeDryRun, "task complete --dry-run must not create or remove holder files or locks");
    assert.equal(readyDryRun.status, 0, JSON.stringify(readyDryRun.receipt));
    assert.equal(readyCloseoutDryRun.status, 0, JSON.stringify(readyCloseoutDryRun.receipt));
    const readyDryRunData = (readyDryRun.receipt.details as {
      readonly data?: {
        readonly report?: {
          readonly checkedGates?: ReadonlyArray<string>;
          readonly uncheckedGates?: ReadonlyArray<string>;
        };
      };
    } | undefined)?.data;
    assert.deepEqual(readyDryRunData?.report?.checkedGates, ["canonical-authority-planner", "task-completion-evidence"]);
    assert.deepEqual(readyDryRunData?.report?.uncheckedGates, ["durable-transition-write"]);
    const readyCloseoutDryRunData = (readyCloseoutDryRun.receipt.details as {
      readonly data?: {
        readonly report?: {
          readonly completionPlan?: {
            readonly checkedGates?: ReadonlyArray<string>;
            readonly uncheckedGates?: ReadonlyArray<string>;
          };
        };
      };
    } | undefined)?.data;
    assert.deepEqual(readyCloseoutDryRunData?.report?.completionPlan?.checkedGates, ["canonical-authority-planner", "task-completion-evidence"]);
    assert.deepEqual(readyCloseoutDryRunData?.report?.completionPlan?.uncheckedGates, ["durable-transition-write"]);
  });
});

test("task closeout publishes approval and completion through the production daemon", { timeout: 60_000 }, async () => {
  await withReviewedCompletionFixture("complete-final-step-deadzone", {}, ({
    fixture, taskId, executionId, taskRoot, closeoutPacketPath, env
  }) => {
    publishCloseout(fixture.repoRoot, taskId, env);
    const closeoutCommand = ["task", "closeout", taskId, "--from-file", closeoutPacketPath] as const;
    const original = runRawJsonMaybeFail(fixture.repoRoot, closeoutCommand, env);
    const completed = original.status === 0
      ? original
      : runRawJsonMaybeFail(fixture.repoRoot, closeoutCommand, env);

    assert.equal(completed.status, 0, JSON.stringify({ original: original.receipt, completed: completed.receipt }));
    assert.equal(completed.receipt.ok, true, JSON.stringify(completed.receipt));
    assert.equal(completed.receipt.command, "task closeout", JSON.stringify(completed.receipt));
    assert.doesNotMatch(JSON.stringify(completed.receipt), /command_receipt_contract_mismatch/u);
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: done$/mu);
    assert.match(
      readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8"),
      /^  "state": "accepted",$/mu
    );
    const completedData = (completed.receipt.details as {
      readonly data?: {
        readonly taskId?: string;
        readonly status?: string;
        readonly completionGate?: { readonly ok?: boolean };
        readonly report?: {
          readonly completionPlan?: { readonly transitionId?: string };
        };
      };
    } | undefined)?.data;
    assert.equal(completedData?.taskId, taskId);
    assert.equal(completedData?.status, "done");
    assert.equal(completedData?.completionGate?.ok, true);
    const transitionId = completedData?.report?.completionPlan?.transitionId;
    assert.match(transitionId ?? "", /^trn_[0-9a-f]{32}$/u);
    for (const attempt of ["replay-1", "replay-2"] as const) {
      const replayed = runRawJsonMaybeFail(fixture.repoRoot, closeoutCommand, env);
      assert.equal(replayed.status, 0, JSON.stringify({ attempt, original: original.receipt, replayed: replayed.receipt }));
      const replayTransition = ((replayed.receipt.details as {
        readonly data?: { readonly report?: { readonly completionPlan?: { readonly transitionId?: string } } };
      } | undefined)?.data?.report?.completionPlan)?.transitionId;
      assert.equal(replayTransition, transitionId, JSON.stringify({ attempt, replayed: replayed.receipt }));
    }
  });
});

test("placeholder closeout rejection leaves production authority usable for corrected completion", { timeout: 60_000 }, async () => {
  await withReviewedCompletionFixture("completion-placeholder-authority", {}, ({
    fixture, taskId, taskRoot, approvalPath, env
  }) => {
    writeFileSync(path.join(taskRoot, "closeout.md"), placeholderCloseout());
    publishCloseout(fixture.repoRoot, taskId, env);
    const blocked = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "complete", taskId, "--approve", "--from-file", approvalPath
    ], env);
    assert.equal(blocked.status, 1, JSON.stringify(blocked.receipt));
    assert.match(JSON.stringify(blocked.receipt), /AUTHORITY_TASK_COMPLETE_CLOSEOUT_PLACEHOLDER/u);
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: in_review$/mu);

    const holder = runRawJsonMaybeFail(fixture.repoRoot, ["task", "holder", taskId], env);
    assert.equal(holder.status, 0, JSON.stringify(holder.receipt));
    assert.equal((holder.receipt.details as {
      readonly data?: { readonly effectiveHolder?: unknown };
    } | undefined)?.data?.effectiveHolder, null, JSON.stringify(holder.receipt));

    writeFileSync(path.join(taskRoot, "closeout.md"), productionCloseout("Corrected after the placeholder rejection."));
    publishCloseout(fixture.repoRoot, taskId, env);
    const completed = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "complete", taskId, "--approve", "--from-file", approvalPath
    ], env);
    assert.equal(completed.status, 0, JSON.stringify(completed.receipt));
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: done$/mu);
  });
});

function snapshotDirectory(input: string): Readonly<Record<string, unknown>> {
  try {
    const stat = lstatSync(input, { bigint: true });
    return {
      exists: true,
      mtimeNs: stat.mtimeNs,
      entries: readdirSync(input).sort()
    };
  } catch (error) {
    if (isMissingFile(error)) return { exists: false };
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === "ENOENT";
}

test("review immediately after doc sync remains determinate when publication advances trunk", { timeout: 60_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8";
  const executionId = "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG7";
  const sessionId = "complete-missing-materializer-barrier";
  const taskRoot = path.join(fixture.authoredRoot, `tasks/${taskId}-production-route`);
  const env = {
    HARNESS_ACTOR: "agent:codex",
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000",
    HARNESS_DAEMON_MATERIALIZER_POLL_MS: "3600000",
    CODEX_THREAD_ID: sessionId
  };
  try {
    mkdirSync(path.join(fixture.repoRoot, "tools"), { recursive: true });
    copyFileSync(
      path.resolve("tools/write-road-registry.json"),
      path.join(fixture.repoRoot, "tools/write-road-registry.json")
    );
    writeFileSync(path.join(taskRoot, "task_plan.md"), productionPlan("Original barrier control plan."));
    git(fixture.authoredRoot, "add", `tasks/${taskId}-production-route/task_plan.md`);
    git(fixture.authoredRoot, "commit", "-q", "-m", "test: seed barrier control plan");
    const registered = runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "canonical",
      "--canonical-root", fixture.repoRoot, "--user-root", userRoot, "--no-link", "--json"
    ], env);
    assert.equal(registered.ok, true, JSON.stringify(registered));
    try {
      runDaemonCommand(fixture.repoRoot, [
        "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
      ], env);
    } catch {
      // Observe the same detached production service if startup outlives the CLI wait.
    }
    await pollUntil(
      () => runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env),
      (status) => status.reachable === true,
      (status, error) => JSON.stringify({ status, error: error instanceof Error ? error.message : String(error ?? "") }),
      { timeoutMs: 20_000 }
    );
    writeColdCodexSessionLog(fixture.repoRoot, sessionId);
    const exported = runRawJsonMaybeFail(fixture.repoRoot, [
      "session", "export", "--session", sessionId, "--runtime", "codex", "--source", "runtime",
      "--detected-at", "2026-07-31T00:00:00.000Z", "--transcript-file", fixture.transcriptPath
    ], env);
    assert.equal(exported.status, 0, JSON.stringify(exported.receipt));
    const started = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "start", taskId, "--execution-id", executionId
    ], env);
    assert.equal(started.status, 0, JSON.stringify(started.receipt));
    const submissionPath = path.join(fixture.root, "barrier-control-submission.json");
    writeFileSync(submissionPath, JSON.stringify({
      completionClaim: "The barrier control is ready for approval.",
      deliverables: ["Barrier semantic control"],
      outputs: ["Non-linear publication control"],
      verificationNotes: ["Background materialization is disabled for the facade window."],
      knownGaps: [],
      residualRisks: []
    }));
    const submitted = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "submit", taskId, "--from-file", submissionPath
    ], env);
    assert.equal(submitted.status, 0, JSON.stringify(submitted.receipt));

    writeFileSync(path.join(taskRoot, "task_plan.md"), productionPlan("Updated without a materializer barrier."));
    const synced = runRawJsonMaybeFail(fixture.repoRoot, [
      "doc", "sync", "--submit", "--path", `tasks/${taskId}-production-route/task_plan.md`
    ], env);
    assert.equal(synced.status, 0, JSON.stringify(synced.receipt));
    const approvalPath = path.join(fixture.root, "barrier-control-approval.json");
    writeFileSync(approvalPath, JSON.stringify({
      executionId,
      verdict: "approved",
      findings: "The submitted barrier control satisfies the task.",
      evidenceChecked: ["ev_cli_1"],
      rationale: "The control intentionally omits current-session materialization.",
      archiveWarningsAcknowledged: true,
      consentAssertedRationale: "Approval was received through an external channel.",
      consentActions: ["approve_execution", "complete_task"]
    }));
    const reviewed = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "review-execution", taskId, "--from-file", approvalPath
    ], env);

    assert.equal(reviewed.status, 0, JSON.stringify(reviewed.receipt));
    assert.equal(reviewed.receipt.ok, true, JSON.stringify(reviewed.receipt));
    assert.doesNotMatch(
      JSON.stringify(reviewed.receipt),
      /repo_write_outcome_unknown|AUTHORITY_CANONICAL_PUBLICATION_NON_LINEAR/u
    );
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("task complete consumes one explicitly accepted current round and replays the same transition", { timeout: 60_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8";
  const executionId = "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG7";
  const sessionId = "complete-explicit-accepted-replay";
  const taskRoot = path.join(fixture.authoredRoot, `tasks/${taskId}-production-route`);
  const env = {
    HARNESS_ACTOR: "agent:codex",
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000",
    HARNESS_DAEMON_MATERIALIZER_POLL_MS: "3600000",
    CODEX_THREAD_ID: sessionId
  };
  try {
    publishSeededTaskFixture(fixture.authoredRoot, taskRoot, taskId);
    const registered = runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "canonical",
      "--canonical-root", fixture.repoRoot, "--user-root", userRoot, "--no-link", "--json"
    ], env);
    assert.equal(registered.ok, true, JSON.stringify(registered));
    try {
      runDaemonCommand(fixture.repoRoot, [
        "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
      ], env);
    } catch {
      // Observe the same detached production service if startup outlives the CLI wait.
    }
    await pollUntil(
      () => runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env),
      (status) => status.reachable === true,
      (status, error) => JSON.stringify({ status, error: error instanceof Error ? error.message : String(error ?? "") }),
      { timeoutMs: 20_000 }
    );

    writeColdCodexSessionLog(fixture.repoRoot, sessionId);
    const exported = runRawJsonMaybeFail(fixture.repoRoot, [
      "session", "export", "--session", sessionId, "--runtime", "codex", "--source", "runtime",
      "--detected-at", "2026-07-31T00:00:00.000Z", "--transcript-file", fixture.transcriptPath
    ], env);
    assert.equal(exported.status, 0, JSON.stringify(exported.receipt));
    const started = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "start", taskId, "--execution-id", executionId
    ], env);
    assert.equal(started.status, 0, JSON.stringify(started.receipt));

    const submissionPath = path.join(fixture.root, "explicit-replay-submission.json");
    writeFileSync(submissionPath, JSON.stringify({
      completionClaim: "The explicit replay regression is ready for approval.",
      deliverables: ["Explicit accepted replay"],
      outputs: ["Full-chain replay evidence"],
      verificationNotes: ["Production daemon setup completed."],
      knownGaps: [],
      residualRisks: []
    }));
    const submitted = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "submit", taskId, "--from-file", submissionPath
    ], env);
    assert.equal(submitted.status, 0, JSON.stringify(submitted.receipt));

    const reviewPath = path.join(fixture.root, "explicit-replay-review.json");
    writeFileSync(reviewPath, JSON.stringify({
      executionId,
      verdict: "approved",
      findings: "The submitted explicit round satisfies the task.",
      evidenceChecked: ["ev_cli_1"],
      rationale: "The accepted round is the explicit current-round replay fixture.",
      archiveWarningsAcknowledged: true,
      consentAssertedRationale: "Approval was received through an external channel.",
      consentActions: ["approve_execution", "complete_task"]
    }));
    const reviewed = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "review-execution", taskId, "--from-file", reviewPath
    ], env);
    assert.equal(reviewed.status, 0, JSON.stringify(reviewed.receipt));
    assert.match(
      readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8"),
      /^  "state": "accepted",$/mu
    );

    const reconciled = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "code-doc", "reconcile", taskId,
      "--commit", fixture.publicHead, "--path", "README.md", "--force"
    ], env);
    assert.equal(reconciled.status, 0, JSON.stringify(reconciled.receipt));

    const approvalPath = path.join(fixture.root, "explicit-replay-completion.json");
    writeFileSync(approvalPath, JSON.stringify({
      executionId,
      findings: "The accepted current round satisfies the task.",
      evidenceChecked: ["ev_cli_1"],
      rationale: "The server must consume the verified accepted round without selecting a later history entry.",
      archiveWarningsAcknowledged: true,
      consentAssertedRationale: "Approval was received through an external channel.",
      consentActions: ["approve_execution", "complete_task"],
      paths: ["REPLAY.md"],
      commit: "REPLAY_HEAD",
      ci: "passed",
      reviewerId: "person_alice"
    }));
    writeFileSync(path.join(fixture.repoRoot, "REPLAY.md"), "# Explicit replay anchor\n");
    git(fixture.repoRoot, "add", "REPLAY.md");
    git(fixture.repoRoot, "commit", "-q", "-m", "test: add explicit replay anchor");
    const replayHead = git(fixture.repoRoot, "rev-parse", "HEAD");
    writeFileSync(
      approvalPath,
      readFileSync(approvalPath, "utf8").replace("REPLAY_HEAD", replayHead)
    );
    const rereconciled = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "code-doc", "reconcile", taskId,
      "--commit", replayHead, "--path", "REPLAY.md", "--force"
    ], env);
    assert.equal(rereconciled.status, 0, JSON.stringify(rereconciled.receipt));

    const command = ["task", "complete", taskId, "--approve", "--from-file", approvalPath] as const;
    const completed = runRawJsonMaybeFail(fixture.repoRoot, command, env);
    assert.equal(completed.status, 0, JSON.stringify(completed.receipt));
    assert.equal(completed.receipt.ok, true, JSON.stringify(completed.receipt));
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: done$/mu);
    const transitionId = ((completed.receipt.details as {
      readonly data?: { readonly report?: { readonly transitionId?: string } };
    } | undefined)?.data?.report)?.transitionId;
    assert.match(transitionId ?? "", /^trn_[0-9a-f]{32}$/u);
    for (const attempt of ["replay-1", "replay-2"] as const) {
      const replayed = runRawJsonMaybeFail(fixture.repoRoot, command, env);
      assert.equal(replayed.status, 0, JSON.stringify({ attempt, replayed: replayed.receipt }));
      assert.equal(((replayed.receipt.details as {
        readonly data?: { readonly report?: { readonly transitionId?: string } };
      } | undefined)?.data?.report)?.transitionId, transitionId);
    }

  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("task complete closes one legacy submitted current round with no live holder", { timeout: 60_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8";
  const executionId = "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG7";
  const sessionId = "complete-active-submitted-exit";
  const taskRoot = path.join(fixture.authoredRoot, `tasks/${taskId}-production-route`);
  const executionPath = path.join(taskRoot, "executions", `${executionId}.md`);
  const env = {
    HARNESS_ACTOR: "agent:codex",
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000",
    HARNESS_DAEMON_MATERIALIZER_POLL_MS: "3600000",
    CODEX_THREAD_ID: sessionId
  };
  try {
    const activeExecution = JSON.parse(readFileSync(executionPath, "utf8")) as Record<string, unknown>;
    writeFileSync(executionPath, `${JSON.stringify({
      ...activeExecution,
      state: "submitted",
      submitted_at: "2026-07-30T00:01:00.000Z",
      outputs: [{
        evidence_id: "ev_cli_1",
        execution_ref: `execution/${taskId}/${executionId}`,
        locator: { substrate: "inline", text: "Legacy submitted round evidence" }
      }],
      submission: {
        completion_claim: "The legacy submitted round already contains the completed delivery.",
        deliverables: ["Active plus submitted recovery"],
        evidence_refs: ["ev_cli_1"],
        verification_notes: ["The original holder is no longer live."],
        known_gaps: [],
        residual_risks: []
      }
    }, null, 2)}\n`);
    const indexPath = path.join(taskRoot, "INDEX.md");
    writeFileSync(indexPath, readFileSync(indexPath, "utf8").replace(/^(  status:\s*).+$/mu, "$1in_review"));
    git(
      fixture.authoredRoot,
      "add",
      `tasks/${taskId}-production-route/INDEX.md`,
      `tasks/${taskId}-production-route/executions/${executionId}.md`
    );
    git(fixture.authoredRoot, "commit", "-q", "-m", "test: seed submitted current round without a holder");
    publishSeededTaskFixture(fixture.authoredRoot, taskRoot, taskId);

    const registered = runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "canonical",
      "--canonical-root", fixture.repoRoot, "--user-root", userRoot, "--no-link", "--json"
    ], env);
    assert.equal(registered.ok, true, JSON.stringify(registered));
    try {
      runDaemonCommand(fixture.repoRoot, [
        "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
      ], env);
    } catch {
      // Observe the same detached production service if startup outlives the CLI wait.
    }
    await pollUntil(
      () => runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env),
      (status) => status.reachable === true,
      (status, error) => JSON.stringify({ status, error: error instanceof Error ? error.message : String(error ?? "") }),
      { timeoutMs: 20_000 }
    );

    writeColdCodexSessionLog(fixture.repoRoot, sessionId);
    const exported = runRawJsonMaybeFail(fixture.repoRoot, [
      "session", "export", "--session", sessionId, "--runtime", "codex", "--source", "runtime",
      "--detected-at", "2026-07-31T00:00:00.000Z", "--transcript-file", fixture.transcriptPath
    ], env);
    assert.equal(exported.status, 0, JSON.stringify(exported.receipt));
    const reconciled = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "code-doc", "reconcile", taskId,
      "--commit", fixture.publicHead, "--path", "README.md", "--force"
    ], env);
    assert.equal(reconciled.status, 0, JSON.stringify(reconciled.receipt));

    const approvalPath = path.join(fixture.root, "active-submitted-approval.json");
    writeFileSync(approvalPath, JSON.stringify({
      findings: "The legacy submitted delivery satisfies the task.",
      evidenceChecked: ["ev_cli_1"],
      rationale: "Owner approval is lease-independent and can close the preserved submitted round.",
      archiveWarningsAcknowledged: true,
      consentAssertedRationale: "Approval was received through an external channel.",
      consentActions: ["approve_execution", "complete_task"],
      commit: fixture.publicHead,
      paths: ["README.md"],
      ci: "passed",
      reviewerId: "person_alice"
    }));
    const completed = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "complete", taskId, "--approve", "--from-file", approvalPath
    ], env);

    assert.equal(completed.status, 0, JSON.stringify(completed.receipt));
    assert.equal(completed.receipt.ok, true, JSON.stringify(completed.receipt));
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: done$/mu);
    assert.match(readFileSync(executionPath, "utf8"), /^  "state": "accepted",$/mu);
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
