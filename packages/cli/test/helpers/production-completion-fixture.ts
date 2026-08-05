import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createFixture,
  git,
  writeColdCodexSessionLog
} from "../production-authority-canonical-ingress/fixture.ts";
import {
  productionCloseout,
  productionPlan,
  publishSeededTaskFixture
} from "./canonical-task-publication-fixture.ts";
import {
  defaultDaemonUserRoot,
  pollUntil,
  runDaemonCommand,
  runRawJsonMaybeFail,
  stopDaemon
} from "./daemon-cli.ts";

export interface ReviewedCompletionFixture {
  readonly fixture: ReturnType<typeof createFixture>;
  readonly taskId: string;
  readonly executionId: string;
  readonly taskRoot: string;
  readonly taskHolderRoot: string;
  readonly approvalPath: string;
  readonly closeoutPacketPath: string;
  readonly env: Readonly<Record<string, string>>;
}

interface ReviewedCompletionFixtureOptions {
  readonly exercisePlanPublication?: boolean;
  readonly assertReleasedHolder?: boolean;
}

export async function withReviewedCompletionFixture(
  sessionId: string,
  options: ReviewedCompletionFixtureOptions,
  run: (context: ReviewedCompletionFixture) => void | Promise<void>
): Promise<void> {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8";
  const executionId = "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG7";
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
    writeFileSync(path.join(taskRoot, "closeout.md"), productionCloseout("Original production closeout."));
    git(fixture.authoredRoot, "add", `tasks/${taskId}-production-route/closeout.md`);
    git(fixture.authoredRoot, "commit", "-q", "-m", "test: seed substantive production closeout");
    writeFileSync(path.join(taskRoot, "task_plan.md"), productionPlan("Original facade completion plan."));
    git(fixture.authoredRoot, "add", `tasks/${taskId}-production-route/task_plan.md`);
    git(fixture.authoredRoot, "commit", "-q", "-m", "test: seed facade completion plan");
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

    const submissionPath = path.join(fixture.root, `${sessionId}-submission.json`);
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
    if (options.assertReleasedHolder === true) {
      const holder = runRawJsonMaybeFail(fixture.repoRoot, ["task", "holder", taskId], env);
      assert.equal(holder.status, 0, JSON.stringify(holder.receipt));
      const holderData = (holder.receipt.details as {
        readonly data?: { readonly effectiveHolder?: unknown };
      } | undefined)?.data;
      assert.equal(holderData?.effectiveHolder, null, JSON.stringify(holder.receipt));
    }

    if (options.exercisePlanPublication === true) {
      writeFileSync(path.join(taskRoot, "task_plan.md"), productionPlan("Updated by the final facade chain."));
      const synced = runRawJsonMaybeFail(fixture.repoRoot, [
        "doc", "sync", "--submit", "--path", `tasks/${taskId}-production-route/task_plan.md`
      ], env);
      assert.equal(synced.status, 0, JSON.stringify(synced.receipt));
      const publishedProse = runRawJsonMaybeFail(fixture.repoRoot, [
        "materializer", "run", "--current-session-only"
      ], env);
      assert.equal(publishedProse.status, 0, JSON.stringify(publishedProse.receipt));
    }

    const reconciled = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "code-doc", "reconcile", taskId,
      "--commit", fixture.publicHead, "--path", "README.md", "--force"
    ], env);
    assert.equal(reconciled.status, 0, JSON.stringify(reconciled.receipt));
    const publishedWitness = runRawJsonMaybeFail(fixture.repoRoot, [
      "materializer", "run", "--current-session-only"
    ], env);
    assert.equal(publishedWitness.status, 0, JSON.stringify(publishedWitness.receipt));

    const approvalPath = path.join(fixture.root, `${sessionId}-approval.json`);
    writeFileSync(approvalPath, JSON.stringify({
      executionId,
      verdict: "approved",
      findings: "The submitted evidence and public code anchor satisfy the task.",
      evidenceChecked: ["ev_cli_1"],
      rationale: "The production daemon path proves the requested full-chain behavior.",
      archiveWarningsAcknowledged: true,
      consentAssertedRationale: "Approval was received through an external channel.",
      consentActions: ["approve_execution", "complete_task"],
      commit: fixture.publicHead,
      paths: ["README.md"],
      ci: "passed",
      reviewerId: "person_alice",
      externalCheckpointRefs: []
    }));
    const reviewed = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "review-execution", taskId, "--from-file", approvalPath
    ], env);
    assert.equal(reviewed.status, 0, JSON.stringify(reviewed.receipt));

    writeFileSync(path.join(taskRoot, "closeout.md"), productionCloseout("Closeout amended after the first reconciliation."));
    const closeoutPacketPath = path.join(fixture.root, `${sessionId}-closeout.json`);
    writeFileSync(closeoutPacketPath, JSON.stringify({
      completionClaim: "The production facade deadzone regression is ready for approval.",
      deliverables: ["Facade completion regression"],
      outputs: ["Full-chain production daemon evidence"],
      verificationNotes: ["Production daemon setup completed."],
      knownGaps: [],
      residualRisks: [],
      executionId,
      verdict: "approved",
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

    await run({
      fixture,
      taskId,
      executionId,
      taskRoot,
      taskHolderRoot: path.join(fixture.repoRoot, ".harness", "task-holders"),
      approvalPath,
      closeoutPacketPath,
      env
    });
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

export function publishCloseout(
  repoRoot: string,
  taskId: string,
  env: Readonly<Record<string, string>>
): void {
  const syncedCloseout = runRawJsonMaybeFail(repoRoot, [
    "doc", "sync", "--submit", "--path", `tasks/${taskId}-production-route/closeout.md`
  ], env);
  assert.equal(syncedCloseout.status, 0, JSON.stringify(syncedCloseout.receipt));
  const publishedCloseout = runRawJsonMaybeFail(repoRoot, [
    "materializer", "run", "--current-session-only"
  ], env);
  assert.equal(publishedCloseout.status, 0, JSON.stringify(publishedCloseout.receipt));
}
