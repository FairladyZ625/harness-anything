// harness-test-tier: integration
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("one task complete intent publishes approval and completion through the production daemon", { timeout: 60_000 }, async () => {
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

    const synced = runRawJsonMaybeFail(fixture.repoRoot, [
      "doc", "sync", "--submit", "--path", `tasks/${taskId}-production-route/task_plan.md`
    ], env);
    assert.equal(synced.status, 0, JSON.stringify(synced.receipt));
    const publishedProse = runRawJsonMaybeFail(fixture.repoRoot, [
      "materializer", "run", "--current-session-only"
    ], env);
    assert.equal(publishedProse.status, 0, JSON.stringify(publishedProse.receipt));
    const reconciled = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "code-doc", "reconcile", taskId,
      "--commit", fixture.publicHead, "--path", "README.md", "--force"
    ], env);
    assert.equal(reconciled.status, 0, JSON.stringify(reconciled.receipt));
    const publishedWitness = runRawJsonMaybeFail(fixture.repoRoot, [
      "materializer", "run", "--current-session-only"
    ], env);
    assert.equal(publishedWitness.status, 0, JSON.stringify(publishedWitness.receipt));

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
    const completeCommand = [
      "task", "complete", taskId, "--approve", "--from-file", approvalPath
    ] as const;
    const original = runRawJsonMaybeFail(fixture.repoRoot, completeCommand, env);
    const completed = original.status === 0
      ? original
      : runRawJsonMaybeFail(fixture.repoRoot, completeCommand, env);

    assert.equal(completed.status, 0, JSON.stringify({ original: original.receipt, completed: completed.receipt }));
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
    const transition = details?.data?.report as { readonly transitionId?: string } | undefined;
    assert.match(transition?.transitionId ?? "", /^trn_[0-9a-f]{32}$/u);
    for (const attempt of ["replay-1", "replay-2"] as const) {
      const replayed = runRawJsonMaybeFail(fixture.repoRoot, completeCommand, env);
      assert.equal(replayed.status, 0, JSON.stringify({ attempt, original: original.receipt, replayed: replayed.receipt }));
      const replayTransition = ((replayed.receipt.details as {
        readonly data?: { readonly report?: { readonly transitionId?: string } };
      } | undefined)?.data?.report)?.transitionId;
      assert.equal(replayTransition, transition?.transitionId, JSON.stringify({ attempt, replayed: replayed.receipt }));
    }
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
