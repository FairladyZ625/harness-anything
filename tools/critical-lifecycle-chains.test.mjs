// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  cleanupFixture,
  createFixture,
  git,
  receiptValue,
  runCli,
  settleCliWrite,
  writeJson,
  writeText
} from "./coldstart-exhaustive-runtime.mjs";

const sourceCliEntry = path.resolve("packages/cli/src/index.ts");

test("critical lifecycle chains use serial isolated daemons and durable readback", async (t) => {
  await t.test("init -> daemon -> durable write -> restart -> readback", async () => {
    await withStartedFixture(async (fixture) => {
      seedPublicCommit(fixture);
      const task = createTask(fixture, "Restart durability chain");
      assertTaskReadback(fixture, task, "planned");

      const progressText = "Durable progress survives an isolated daemon restart.";
      runWrite(fixture, ["task", "progress", "append", task.taskId, "--text", progressText], "append durable progress");
      assert.match(readFileSync(path.join(fixture.root, task.packagePath, "progress.md"), "utf8"), new RegExp(escapeRegExp(progressText), "u"));

      const factStatement = "The restart chain wrote durable task state before restart.";
      const fact = runWrite(fixture, [
        "fact", "record", "--task", task.taskId, "--statement", factStatement,
        "--source", "critical lifecycle integration", "--confidence", "high"
      ], "record durable fact");
      const factId = requiredString(receiptValue(fact, "factId"), "fact id");
      assertFactReadback(fixture, task, factId, factStatement);

      const before = assertPassed(runCli(fixture, ["daemon", "status", "--user-root", fixture.daemonUserRoot]), "daemon status before restart");
      const beforePid = requiredNumber(receiptValue(before, "pid"), "daemon pid before restart");
      assertPassed(runCli(fixture, ["daemon", "restart", "--user-root", fixture.daemonUserRoot], { timeoutMs: 45_000 }), "daemon restart");
      const after = assertPassed(runCli(fixture, ["daemon", "status", "--user-root", fixture.daemonUserRoot]), "daemon status after restart");
      const afterPid = requiredNumber(receiptValue(after, "pid"), "daemon pid after restart");
      assert.notEqual(afterPid, beforePid, "restart must replace the fixture daemon process");

      assertTaskReadback(fixture, task, "planned");
      assertFactReadback(fixture, task, factId, factStatement);
      assert.match(readFileSync(path.join(fixture.root, task.packagePath, "progress.md"), "utf8"), new RegExp(escapeRegExp(progressText), "u"));
    });
  });

  await t.test("task create -> start -> progress/fact -> submit/review -> complete", async () => {
    await withStartedFixture(async (fixture) => {
      const publicHead = seedPublicCommit(fixture);
      const task = createTask(fixture, "Completion lifecycle chain");
      writeTaskDocuments(fixture, task);
      const sessionId = "critical-completion-session";
      exportSession(fixture, sessionId);
      const sessionEnvironment = { CODEX_THREAD_ID: sessionId, CODEX_SESSION_ID: sessionId };

      const started = runWrite(fixture, ["task", "start", task.taskId], "start task", { env: sessionEnvironment });
      const executionId = requiredString(receiptValue(started, "executionId"), "execution id");
      assertTaskReadback(fixture, task, "active");
      assertPassed(runCli(fixture, ["execution", "show", executionId]), "read active execution");

      const progressText = "Lifecycle evidence was written through the canonical command path.";
      runWrite(fixture, ["task", "progress", "append", task.taskId, "--text", progressText], "append task progress");
      assert.match(readFileSync(path.join(fixture.root, task.packagePath, "progress.md"), "utf8"), new RegExp(escapeRegExp(progressText), "u"));
      const statement = "The completion chain observed its persisted active execution.";
      const fact = runWrite(fixture, [
        "fact", "record", "--task", task.taskId, "--statement", statement,
        "--source", "critical lifecycle integration", "--confidence", "high"
      ], "record task fact");
      const factId = requiredString(receiptValue(fact, "factId"), "fact id");
      assertFactReadback(fixture, task, factId, statement);

      const submissionPath = path.join(fixture.base, "submission.json");
      writeJson(submissionPath, submissionPacket());
      runWrite(fixture, ["task", "submit", task.taskId, "--from-file", submissionPath], "submit task", { env: sessionEnvironment });
      assertTaskReadback(fixture, task, "in_review");
      runWrite(fixture, ["task", "code-doc", "reconcile", task.taskId, "--commit", publicHead, "--path", "README.md", "--force"], "record code-doc reconciliation");
      runWrite(fixture, ["materializer", "run"], "publish code-doc reconciliation");

      const consent = runWrite(fixture, [
        "task", "consent-record", task.taskId, "--execution-id", executionId,
        "--asserted", "Fixture owner approved through the isolated local channel.",
        "--consent-action", "approve_execution", "--consent-action", "complete_task"
      ], "record consent");
      const consentId = requiredString(receiptValue(consent, "consentId"), "consent id");
      const review = runWrite(fixture, [
        "task", "review-execution", task.taskId, "--execution-id", executionId,
        "--verdict", "approved", "--findings", "All lifecycle evidence is persisted.",
        "--rationale", "Readback proves the isolated command chain.", "--consent", consentId,
        "--evidence-checked", "ev_cli_1", "--acknowledge-archive-warnings"
      ], "review execution");
      const reviewId = requiredString(receiptValue(review, "reviewId"), "review id");
      assertPassed(runCli(fixture, ["review", "show", reviewId]), "read persisted review");

      const approvalPath = path.join(fixture.base, "approval.json");
      writeJson(approvalPath, approvalPacket(executionId, publicHead));
      runWrite(fixture, ["task", "complete", task.taskId, "--approve", "--from-file", approvalPath], "complete task", { env: sessionEnvironment });
      assertTaskReadback(fixture, task, "done");
      const execution = assertPassed(runCli(fixture, ["execution", "show", executionId]), "read completed execution");
      assert.equal(findScalar(execution.receipt, "state"), "accepted");
    });
  });

  await t.test("delete/reopen/supersede positive and negative paths", async () => {
    await withStartedFixture(async (fixture) => {
      seedPublicCommit(fixture);
      const task = createTask(fixture, "Disposition lifecycle chain");
      assertTaskReadback(fixture, task, "planned");

      assertRejected(runCli(fixture, ["task", "delete", "--soft", task.taskId]), "delete without required reason");
      assertTaskReadback(fixture, task, "planned");

      const missingTaskId = "task_01KZP000000000000000000000";
      assertRejected(runCli(fixture, ["task", "reopen", missingTaskId, "--reason", "negative control for unknown task"]), "reopen an unknown task");

      runWrite(fixture, ["task", "delete", "--soft", task.taskId, "--reason", "exercise tombstone readback"], "soft delete task");
      assertTaskDispositionReadback(fixture, task, "tombstoned");
      runWrite(fixture, ["task", "reopen", task.taskId, "--reason", "exercise reopen readback"], "reopen tombstoned task");
      assertTaskDispositionReadback(fixture, task, "active");

      assertRejected(runCli(fixture, [
        "task", "supersede", task.taskId, "--by", missingTaskId, "--confirm", task.taskId,
        "--reason", "negative control for missing replacement"
      ]), "supersede by an unknown replacement");
      assertTaskDispositionReadback(fixture, task, "active");

      const superseded = runWrite(fixture, [
        "task", "supersede", task.taskId, "--title", "Replacement disposition task",
        "--reason", "exercise supersede readback"
      ], "supersede task");
      const replacementRef = requiredString(superseded.receipt?.paths?.find?.((entry) => entry?.role === "primary")?.path, "replacement task ref");
      const replacementId = requiredString(replacementRef.replace(/^task\//u, ""), "replacement task id");
      const replacement = { taskId: replacementId, packagePath: packagePathFromReceipt(superseded.receipt) };
      assert.notEqual(replacementId, task.taskId);
      assertTaskDispositionReadback(fixture, task, "archived");
      assertTaskReadback(fixture, replacement, "planned");
      assert.equal(existsSync(path.join(fixture.root, replacement.packagePath, "INDEX.md")), true);
      assert.match(readFileSync(path.join(fixture.root, replacement.packagePath, "relations.md"), "utf8"), new RegExp(`task/${escapeRegExp(replacementId)} supersedes task/${escapeRegExp(task.taskId)}`, "u"));
    });
  });
});

async function withStartedFixture(run) {
  const fixture = createFixture({ cliEntry: sourceCliEntry });
  let bodyError;
  try {
    const init = runWrite(fixture, ["init", "--name", "critical-lifecycle"], "initialize fixture");
    const manifestPath = requiredString(receiptValue(init, "manifestPath"), "authority manifest path");
    assert.equal(existsSync(path.join(fixture.root, "harness/harness.yaml")), true);
    assert.equal(existsSync(manifestPath), true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.schema, "authority-production-composition/v1");
    assert.equal(manifest.repos?.[0]?.canonicalRoot, fixture.root);
    assertPassed(runCli(fixture, ["daemon", "repo", "register", "--root", fixture.root, "--user-root", fixture.daemonUserRoot]), "register fixture repository");
    assertPassed(runCli(fixture, ["daemon", "start", "--service", "--user-root", fixture.daemonUserRoot, "--authority-manifest", manifestPath], { timeoutMs: 30_000 }), "start fixture daemon");
    const status = assertPassed(runCli(fixture, ["daemon", "status", "--user-root", fixture.daemonUserRoot]), "read fixture daemon status");
    assert.equal(findScalar(status.receipt, "reachable"), true);
    await run(fixture);
  } catch (error) {
    bodyError = error;
  }
  const cleanup = await cleanupFixture(fixture);
  assert.deepEqual(cleanup.errors, [], `fixture cleanup errors: ${cleanup.errors.join("; ")}`);
  assert.equal(cleanup.baseRemoved, true);
  assert.equal(cleanup.protectedUnchanged, true);
  if (bodyError) throw bodyError;
}

function seedPublicCommit(fixture) {
  writeText(path.join(fixture.root, "README.md"), "# Critical lifecycle fixture\n");
  git(fixture, "add", "--all");
  git(fixture, "commit", "-m", "test: seed lifecycle fixture");
  return git(fixture, "rev-parse", "HEAD");
}

function createTask(fixture, title) {
  const created = runWrite(fixture, ["task", "create", "--title", title, "--vertical", "software/coding", "--preset", "standard-task"], `create ${title}`);
  const taskId = requiredString(receiptValue(created, "taskId"), "task id");
  const packagePath = packagePathFromReceipt(created.receipt);
  assert.equal(existsSync(path.join(fixture.root, packagePath, "INDEX.md")), true);
  return { taskId, packagePath };
}

function assertTaskReadback(fixture, task, expectedStatus) {
  const shown = assertPassed(runCli(fixture, ["task", "show", task.taskId]), `read task ${task.taskId}`);
  assert.equal(findScalar(shown.receipt, "status"), expectedStatus);
  const index = readFileSync(path.join(fixture.root, task.packagePath, "INDEX.md"), "utf8");
  assert.match(index, new RegExp(`task_id: ${escapeRegExp(task.taskId)}`, "u"));
  assert.match(index, new RegExp(`status: ${escapeRegExp(expectedStatus)}`, "u"));
}

function assertTaskDispositionReadback(fixture, task, expectedDisposition) {
  const shown = assertPassed(runCli(fixture, ["task", "show", task.taskId]), `read task disposition ${task.taskId}`);
  assert.equal(findScalar(shown.receipt, "packageDisposition"), expectedDisposition);
  const index = readFileSync(path.join(fixture.root, task.packagePath, "INDEX.md"), "utf8");
  assert.match(index, new RegExp(`packageDisposition: ${escapeRegExp(expectedDisposition)}`, "u"));
}

function assertFactReadback(fixture, task, factId, statement) {
  const shown = assertPassed(runCli(fixture, ["fact", "show", "--task", task.taskId, "--id", factId]), `read fact ${factId}`);
  assert.equal(findScalar(shown.receipt, "factId", "fact_id"), factId);
  const facts = readFileSync(path.join(fixture.root, task.packagePath, "facts.md"), "utf8");
  assert.match(facts, new RegExp(escapeRegExp(factId), "u"));
  assert.match(facts, new RegExp(escapeRegExp(statement), "u"));
}

function writeTaskDocuments(fixture, task) {
  writeText(path.join(fixture.root, task.packagePath, "task_plan.md"), "# Lifecycle Plan\n\nTask Contract: harness-task v1\n\n## Brief\n\nExercise the critical completion chain.\n\n## Goal\n\nPersist every lifecycle transition.\n\n## Context\n\nUse the isolated daemon fixture.\n\n## Constraints\n\nDo not access external services.\n\n## Checkpoint\n\nStop on failed readback.\n\n## CI/Gate Authority Stop Condition\n\nNo gate changes.\n\n## Implementation Plan\n\n- Exercise and read back each step.\n\n## Verification\n\n- Complete the task through the CLI.\n");
  writeText(path.join(fixture.root, task.packagePath, "closeout.md"), "# Closeout\n\n## Summary\n\nThe isolated lifecycle chain completed.\n\n## Verification\n\nEvery transition has a durable readback.\n\n## Residual Risk\n\nNone.\n");
}

function exportSession(fixture, sessionId) {
  const transcriptPath = path.join(fixture.home, ".codex/sessions", `${sessionId}.jsonl`);
  writeText(transcriptPath, [
    JSON.stringify({ timestamp: "2026-08-10T00:00:00.000Z", type: "event_msg", payload: { type: "user_message", message: "Exercise completion lifecycle" } }),
    JSON.stringify({ timestamp: "2026-08-10T00:00:01.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "verified" }] } }),
    ""
  ].join("\n"));
  runWrite(fixture, [
    "session", "export", "--session", sessionId, "--runtime", "codex", "--source", "runtime",
    "--detected-at", "2026-08-10T00:00:00.000Z", "--transcript-file", transcriptPath
  ], "export fixture session");
}

function submissionPacket() {
  return {
    completionClaim: "The critical lifecycle chain persisted all required evidence.",
    deliverables: ["Integration lifecycle evidence"],
    outputs: ["Durable task, fact, review, and execution records"],
    verificationNotes: ["Every mutation was read back before the next step."],
    knownGaps: [],
    residualRisks: []
  };
}

function approvalPacket(executionId, commit) {
  return {
    executionId,
    verdict: "approved",
    findings: "The persisted lifecycle evidence satisfies the fixture task.",
    evidenceChecked: ["ev_cli_1"],
    rationale: "Independent readback proves each lifecycle transition.",
    archiveWarningsAcknowledged: true,
    consentAssertedRationale: "Fixture owner approval was received through the isolated local channel.",
    consentActions: ["approve_execution", "complete_task"],
    commit,
    paths: ["README.md"],
    ci: "passed",
    reviewerId: "person_coldstart_exhaustive_2bfb590688",
    externalCheckpointRefs: []
  };
}

function assertPassed(record, label) {
  assert.equal(record.exitCode, 0, `${label}: ${record.stdout}${record.stderr}`);
  assert.equal(record.receiptOk, true, `${label}: ${record.stdout}${record.stderr}`);
  assert.equal(typeof record.receipt?.schema, "string", `${label} must return a structured receipt`);
  return record;
}

function assertRejected(record, label) {
  assert.notEqual(record.exitCode, 0, `${label} unexpectedly passed: ${record.stdout}`);
  assert.notEqual(record.receiptOk, true, `${label} unexpectedly returned ok receipt`);
}

function runWrite(fixture, args, label, options = {}) {
  const record = assertPassed(runCli(fixture, args, options), label);
  return settleCliWrite(fixture, record);
}

function packagePathFromReceipt(receipt) {
  const pathEntry = receipt?.paths?.find?.((entry) => entry?.role === "package")?.path
    ?? receipt?.details?.pathsByRole?.package;
  return requiredString(pathEntry, "task package path");
}

function findScalar(root, ...keys) {
  const wanted = new Set(keys);
  const queue = [root];
  const seen = new Set();
  while (queue.length > 0) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (wanted.has(key) && ["string", "number", "boolean"].includes(typeof child)) return child;
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return undefined;
}

function requiredString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.notEqual(value.length, 0, `${label} must not be empty`);
  return value;
}

function requiredNumber(value, label) {
  assert.equal(typeof value, "number", `${label} must be a number`);
  return value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
