// harness-test-tier: integration
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  defaultDaemonUserRoot,
  pollUntil,
  runDaemonCommand,
  runRawJsonMaybeFail,
  stopDaemon
} from "./helpers/daemon-cli.ts";
import {
  createFixture,
  git,
  writeColdCodexSessionLog
} from "./production-authority-canonical-ingress/fixture.ts";

test("task complete facade publishes approval, non-empty reconciliation, and completion through the production daemon", { timeout: 60_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8";
  const executionId = "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG7";
  const sessionId = "complete-final-step-deadzone";
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
    writeFileSync(path.join(taskRoot, "task_plan.md"), productionPlan("Original facade completion plan."));
    git(fixture.authoredRoot, "add", `tasks/${taskId}-production-route/task_plan.md`);
    git(fixture.authoredRoot, "commit", "-q", "-m", "test: seed facade completion plan");
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

    const submissionPath = path.join(fixture.root, "deadzone-submission.json");
    writeFileSync(submissionPath, JSON.stringify({
      completionClaim: "The production facade deadzone regression is ready for approval.",
      deliverables: ["Facade completion regression"],
      outputs: ["Full-chain production daemon evidence"],
      verificationNotes: ["Production daemon setup completed."],
      knownGaps: [],
      residualRisks: []
    }));
    const submitted = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "submit", taskId, "--execution-id", executionId, "--from-file", submissionPath
    ], env);
    assert.equal(submitted.status, 0, JSON.stringify(submitted.receipt));

    writeFileSync(path.join(taskRoot, "task_plan.md"), productionPlan("Updated by the final facade chain."));

    const approvalPath = path.join(fixture.root, "deadzone-approval.json");
    writeFileSync(approvalPath, JSON.stringify({
      executionId,
      findings: "The submitted evidence and public code anchor satisfy the task.",
      evidenceChecked: ["ev_cli_1"],
      rationale: "The production daemon path proves the requested full-chain behavior.",
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
    assert.match(
      readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8"),
      /^  "state": "accepted",$/mu
    );
    const details = completed.receipt.details as {
      readonly data?: {
        readonly report?: { readonly steps?: ReadonlyArray<Record<string, unknown>> };
      };
    } | undefined;
    const steps = details?.data?.report?.steps ?? [];
    assert.deepEqual(steps.map((step) => step.command), [
      "doc sync submit", "materializer run", "task review execution", "task code doc reconcile", "task complete"
    ]);
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("review immediately after doc sync reproduces non-linear publication without the facade barrier", { timeout: 60_000 }, async () => {
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
      "task", "submit", taskId, "--execution-id", executionId, "--from-file", submissionPath
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

    assert.equal(reviewed.status, 1, JSON.stringify(reviewed.receipt));
    assert.match(JSON.stringify(reviewed.receipt), /AUTHORITY_CANONICAL_PUBLICATION_NON_LINEAR/u);
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("task complete retries the same explicit execution approval after a later reconcile failure", { timeout: 60_000 }, async () => {
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
      "task", "submit", taskId, "--execution-id", executionId, "--from-file", submissionPath
    ], env);
    assert.equal(submitted.status, 0, JSON.stringify(submitted.receipt));

    const approvalPath = path.join(fixture.root, "explicit-replay-approval.json");
    writeFileSync(approvalPath, JSON.stringify({
      executionId,
      findings: "The submitted explicit round satisfies the task.",
      evidenceChecked: ["ev_cli_1"],
      rationale: "The same owner approval must remain replayable after a later step fails.",
      archiveWarningsAcknowledged: true,
      consentAssertedRationale: "Approval was received through an external channel.",
      consentActions: ["approve_execution", "complete_task"],
      paths: ["REPLAY.md"],
      ci: "passed",
      reviewerId: "person_alice"
    }));
    const command = ["task", "complete", taskId, "--approve", "--from-file", approvalPath] as const;
    const first = runRawJsonMaybeFail(fixture.repoRoot, command, env);
    assert.equal(first.status, 1, JSON.stringify(first.receipt));
    assert.match(JSON.stringify(first.receipt), /REPLAY\.md/u);
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: in_review$/mu);
    assert.match(
      readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8"),
      /^  "state": "accepted",$/mu
    );

    writeFileSync(path.join(fixture.repoRoot, "REPLAY.md"), "# Explicit replay anchor\n");
    git(fixture.repoRoot, "add", "REPLAY.md");
    git(fixture.repoRoot, "commit", "-q", "-m", "test: add explicit replay anchor");

    const retried = runRawJsonMaybeFail(fixture.repoRoot, command, env);
    assert.equal(retried.status, 0, JSON.stringify(retried.receipt));
    assert.equal(retried.receipt.ok, true, JSON.stringify(retried.receipt));
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: done$/mu);

  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("task complete explicitly selects a non-latest round among content-distinct accepted rounds", { timeout: 60_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8";
  const firstExecutionId = "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG7";
  const sessionId = "complete-multiple-accepted-replay";
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
      "task", "start", taskId, "--execution-id", firstExecutionId
    ], env);
    assert.equal(started.status, 0, JSON.stringify(started.receipt));

    const submissionPath = path.join(fixture.root, "multiple-accepted-submission.json");
    writeFileSync(submissionPath, JSON.stringify({
      completionClaim: "The multiple accepted replay regression is ready for approval.",
      deliverables: ["Multiple accepted replay"],
      outputs: ["Full-chain ambiguity evidence"],
      verificationNotes: ["Production daemon setup completed."],
      knownGaps: [],
      residualRisks: []
    }));
    const firstSubmitted = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "submit", taskId, "--execution-id", firstExecutionId, "--from-file", submissionPath
    ], env);
    assert.equal(firstSubmitted.status, 0, JSON.stringify(firstSubmitted.receipt));

    const approvalPath = path.join(fixture.root, "multiple-accepted-approval.json");
    writeFileSync(approvalPath, JSON.stringify({
      findings: "The submitted round satisfies the task.",
      evidenceChecked: ["ev_cli_1"],
      rationale: "The latest equivalent approval must remain replayable after a later step fails.",
      archiveWarningsAcknowledged: true,
      consentAssertedRationale: "Approval was received through an external channel.",
      consentActions: ["approve_execution", "complete_task"],
      paths: ["MULTI.md"],
      ci: "passed",
      reviewerId: "person_alice"
    }));
    const command = ["task", "complete", taskId, "--approve", "--from-file", approvalPath] as const;
    const first = runRawJsonMaybeFail(fixture.repoRoot, command, env);
    assert.equal(first.status, 1, JSON.stringify(first.receipt));
    assert.match(JSON.stringify(first.receipt), /MULTI\.md/u);

    const restarted = runRawJsonMaybeFail(fixture.repoRoot, ["task", "start", taskId], env);
    assert.equal(restarted.status, 0, JSON.stringify(restarted.receipt));
    const restartData = (restarted.receipt.details as { readonly data?: { readonly executionId?: string } } | undefined)?.data;
    const secondExecutionId = String(restartData?.executionId ?? "");
    assert.match(secondExecutionId, /^exe_[0-9A-HJKMNP-TV-Z]{26}$/u, JSON.stringify(restarted.receipt));
    const secondSubmissionPath = path.join(fixture.root, "multiple-accepted-second-submission.json");
    writeFileSync(secondSubmissionPath, JSON.stringify({
      completionClaim: "The newer round contains a materially different delivery.",
      deliverables: ["Different multiple accepted replay content"],
      outputs: ["A distinct content pin"],
      verificationNotes: ["The second round differs from the first submission."],
      knownGaps: [],
      residualRisks: ["A mismatched pin must fail closed."]
    }));
    const secondSubmitted = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "submit", taskId, "--execution-id", secondExecutionId, "--from-file", secondSubmissionPath
    ], env);
    assert.equal(secondSubmitted.status, 0, JSON.stringify(secondSubmitted.receipt));

    const second = runRawJsonMaybeFail(fixture.repoRoot, command, env);
    assert.equal(second.status, 1, JSON.stringify(second.receipt));
    assert.match(JSON.stringify(second.receipt), /MULTI\.md/u);
    const acceptedStates = [firstExecutionId, secondExecutionId].map((executionId) =>
      JSON.parse(readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8")) as { readonly state?: string }
    );
    assert.deepEqual(acceptedStates.map((execution) => execution.state), ["accepted", "accepted"]);
    const consentPins = readdirSync(path.join(taskRoot, "consents"))
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => JSON.parse(readFileSync(path.join(taskRoot, "consents", entry), "utf8")) as {
        readonly scope?: { readonly content_pin?: { readonly digest?: string } };
      })
      .map((consent) => consent.scope?.content_pin?.digest);
    assert.equal(consentPins.length, 2);
    assert.equal(new Set(consentPins).size, 2, JSON.stringify(consentPins));

    writeFileSync(path.join(fixture.repoRoot, "MULTI.md"), "# Multiple accepted replay anchor\n");
    git(fixture.repoRoot, "add", "MULTI.md");
    git(fixture.repoRoot, "commit", "-q", "-m", "test: add multiple accepted replay anchor");

    const explicitApprovalPath = path.join(fixture.root, "multiple-accepted-explicit-approval.json");
    writeFileSync(explicitApprovalPath, JSON.stringify({
      executionId: firstExecutionId,
      findings: "The submitted round satisfies the task.",
      evidenceChecked: ["ev_cli_1"],
      rationale: "The latest equivalent approval must remain replayable after a later step fails.",
      archiveWarningsAcknowledged: true,
      consentAssertedRationale: "Approval was received through an external channel.",
      consentActions: ["approve_execution", "complete_task"],
      paths: ["MULTI.md"],
      ci: "passed",
      reviewerId: "person_alice"
    }));
    const explicitlyCompleted = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "complete", taskId, "--approve", "--from-file", explicitApprovalPath
    ], env);
    assert.equal(explicitlyCompleted.status, 0, JSON.stringify(explicitlyCompleted.receipt));
    const completionData = (explicitlyCompleted.receipt.details as {
      readonly data?: { readonly executionId?: string };
    } | undefined)?.data;
    assert.equal(completionData?.executionId, firstExecutionId, JSON.stringify(explicitlyCompleted.receipt));
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: done$/mu);
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("task complete closes an active task with one legacy submitted round and no live holder", { timeout: 60_000 }, async () => {
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
    git(fixture.authoredRoot, "add", `tasks/${taskId}-production-route/executions/${executionId}.md`);
    git(fixture.authoredRoot, "commit", "-q", "-m", "test: seed active task with submitted round");

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

function productionPlan(goal: string): string {
  return [
    "# Plan", "",
    "## Brief", "Brief.",
    "## Goal", goal,
    "## Context", "Context.",
    "## Constraints", "Constraints.",
    "## Checkpoint", "Checkpoint.",
    "## CI/Gate Authority Stop Condition", "Stop.",
    "## Implementation Plan", "Plan.",
    "## Verification", "Verify.",
    ""
  ].join("\n");
}
