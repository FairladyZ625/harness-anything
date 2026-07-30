// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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
  latestAuthorityOperation,
  writeColdCodexSessionLog
} from "./production-authority-canonical-ingress/fixture.ts";

test("production daemon authority submits an active recovery round while the task remains in_review", { timeout: 60_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const env = {
    HARNESS_ACTOR: "agent:codex",
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000"
  };
  const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8";
  const executionId = "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG7";
  const sessionId = "service-slugged-lifecycle-session";
  const taskRelativeRoot = `tasks/${taskId}-production-route`;
  const taskRoot = path.join(fixture.authoredRoot, taskRelativeRoot);
  const indexPath = path.join(taskRoot, "INDEX.md");
  try {
    writeFileSync(
      indexPath,
      readFileSync(indexPath, "utf8").replace("  status: active", "  status: in_review"),
      "utf8"
    );
    git(fixture.authoredRoot, "add", `${taskRelativeRoot}/INDEX.md`);
    git(fixture.authoredRoot, "commit", "-q", "-m", "test: seed in-review active recovery round");

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
      // Observe the same detached production service if startup outlives the fixed CLI wait.
    }
    await pollUntil(
      () => runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env),
      (status) => status.reachable === true,
      (status, error) => JSON.stringify({ status, error: error instanceof Error ? error.message : String(error ?? "") }),
      { timeoutMs: 20_000 }
    );

    writeColdCodexSessionLog(fixture.repoRoot, sessionId);
    const sessionEnv = { ...env, CODEX_THREAD_ID: sessionId };
    const exported = runRawJsonMaybeFail(fixture.repoRoot, [
      "session", "export", "--session", sessionId, "--runtime", "codex", "--source", "runtime",
      "--detected-at", "2026-07-17T00:00:00.000Z", "--transcript-file", fixture.transcriptPath
    ], sessionEnv);
    assert.equal(exported.status, 0, JSON.stringify(exported.receipt));

    const started = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "start", taskId, "--execution-id", executionId
    ], sessionEnv);
    assert.equal(started.status, 0, JSON.stringify(started.receipt));
    assert.equal(started.receipt.ok, true, JSON.stringify(started.receipt));

    const submissionPath = path.join(fixture.root, "in-review-recovery-submission.json");
    writeFileSync(submissionPath, JSON.stringify({
      completionClaim: "The in-review recovery round is ready for authority review.",
      deliverables: [],
      outputs: [],
      verificationNotes: ["Production daemon authority accepted submit from in_review."],
      knownGaps: [],
      residualRisks: []
    }), "utf8");
    const submitted = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "submit", taskId, "--execution-id", executionId, "--from-file", submissionPath
    ], sessionEnv);
    assert.equal(submitted.status, 0, JSON.stringify(submitted.receipt));
    assert.equal(submitted.receipt.ok, true, JSON.stringify(submitted.receipt));
    assert.match(readFileSync(indexPath, "utf8"), /^  status: in_review$/mu);
    assert.match(
      readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8"),
      /^  "state": "submitted",$/mu
    );
    assert.equal(latestAuthorityOperation(fixture.serviceRoot).state, "COMMITTED");
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
