// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeProviderExecutable } from "../../daemon/test/fixtures/runtime-stub.ts";
import { taskQueryGuidance } from "@harness-anything/daemon/internal/runtime-spawn-mission";
import { safePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { runCommandThroughDaemon } from "../src/daemon/client.ts";
import { realizedTaskPlan as realizedPlan } from "../../../tools/fixtures/task-plan.mjs";
import {
  assertTaskMissionPrompt,
  createRuntimeFixture,
  eventuallyFile,
  eventuallyNotification,
  eventuallyRuntimeReaderReuse,
  eventuallyRuntimeStatus,
  eventuallyTerminal,
  installIdentities,
  processAlive,
  published,
  readDispatchRecords,
  readPublishedDispatch,
  run,
  runAsync,
  runMaybe,
  seedTask,
  writeIdentity,
} from "./runtime-cli.fixtures.ts";

test("Task dispatch rejects an incomplete plan then automatically acquires its lease", async (context) => {
  const fixture = createRuntimeFixture(context);
  installIdentities(fixture.parent, fixture.root, fixture.env);
  const { root, env } = fixture;
  const taskId = "task-runtime-automatic-lease";
  const automaticTaskId = `${taskId}-automatic`;
  const automaticTask = run(root, env, [
    "task",
    "create",
    "--id",
    automaticTaskId,
    "--admin",
    "--title",
    "Automatic lease",
  ]);
  const automaticPackagePath = String(automaticTask.packagePath),
    automaticPlanPath = `${automaticPackagePath}/task_plan.md`,
    oneSectionMissing = realizedPlan("Automatic lease").replace(
      /\n\n## CI\/Gate Authority Stop Condition\n\n[^\n]+/u,
      "",
    );
  published(root, env, automaticTask);
  writeFileSync(path.join(root, "harness", automaticPlanPath), oneSectionMissing);
  const automaticArgs = [
      "agent",
      "run",
      "terra",
      "--prompt",
      "must acquire its lease",
      "--task",
      automaticTaskId,
      "--detach",
    ],
    placeholderLease = runMaybe(root, env, automaticArgs);
  assert.equal(placeholderLease.status, 1);
  assert.equal(placeholderLease.receipt.code, "plan_placeholder");
  assert.deepEqual(placeholderLease.receipt.diagnostic, {
    kind: "missing-sections",
    documentPath: automaticPlanPath,
    diskDiffers: true,
    missingSections: [{ section: "CI/Gate Authority Stop Condition", reason: "empty" }],
  });
  writeFileSync(path.join(root, "harness", automaticPackagePath, "task_plan.md"), realizedPlan("Automatic lease"));
  const automaticPlanSync = run(root, env, ["doc", "sync", "--submit", "--path", automaticPlanPath]);
  const automaticLease = runMaybe(root, env, automaticArgs);
  assert.equal(automaticLease.status, 0, JSON.stringify(automaticLease));
  assert.equal(automaticLease.receipt.outcome, "running");
  assert.equal(typeof automaticLease.receipt.dispatchId, "string");
  context.diagnostic(
    `revision-aware plan hint: ${JSON.stringify({
      before: {
        outcome: placeholderLease.receipt.outcome,
        code: placeholderLease.receipt.code,
        diagnostic: placeholderLease.receipt.diagnostic,
      },
      sync: { outcome: automaticPlanSync.outcome, summary: automaticPlanSync.summary },
      after: {
        outcome: automaticLease.receipt.outcome,
        dispatchId: automaticLease.receipt.dispatchId,
      },
    })}`,
  );
  // This case owns the detached session and settles it before its daemon is torn down.
  run(root, env, ["runtime", "status", String(automaticLease.receipt.runtimeSessionId), "--wait", "--no-stream"]);
});

test("Cancellation is idempotent, notifies once and resumes the archived provider session", async (context) => {
  const fixture = createRuntimeFixture(context);
  installIdentities(fixture.parent, fixture.root, fixture.env);
  const { parent, root, env, userRoot, daemonId } = fixture;
  const { taskId, executionId, packagePath, artifactRoot } = seedTask(root, env, "cancel-resume");
  const workerRelative = ".worktrees/resume-worker",
    workerRoot = path.join(root, workerRelative);
  mkdirSync(workerRoot, { recursive: true });
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const notificationOnce = path.join(workerRoot, ".notify-once");
  const onceNotifier = writeProviderExecutable(
    path.join(parent, "notify-once"),
    'const fs = require("node:fs"); fs.readFileSync(0, "utf8"); fs.appendFileSync(".notify-once", "once\\n");\n',
  );
  const detached = run(root, env, [
      "agent",
      "run",
      "terra",
      "--prompt",
      "hold",
      "--task",
      taskId,
      "--cwd",
      workerRelative,
      "--detach",
      "--on-exit",
      onceNotifier,
    ]),
    detachedDispatchId = String(detached.dispatchId),
    detachedSessionId = String(detached.runtimeSessionId),
    running = run(root, env, ["task", "dispatches", taskId]);
  assert.equal(detached.outcome, "running");
  assert.equal(
    (running.dispatches as Array<Record<string, unknown>>).find((row) => row.dispatchId === detachedDispatchId)?.status,
    "running",
  );
  assert.equal(run(root, env, ["runtime", "cancel", detachedSessionId]).detail, "cancelled");
  assert.equal(run(root, env, ["runtime", "cancel", detachedSessionId]).detail, "already-exited");
  const cancelled = await eventuallyTerminal(root, env, ["task", "dispatches", taskId]),
    cancelledRow = (cancelled.dispatches as Array<Record<string, unknown>>).find(
      (row) => row.dispatchId === detachedDispatchId,
    )!;
  assert.equal(cancelledRow.status, "cancelled");
  assert.equal(
    (
      JSON.parse(
        await readPublishedDispatch(path.join(artifactRoot, "dispatches", `${detachedDispatchId}.json`)),
      ) as Record<string, unknown>
    ).outcome,
    "cancelled",
  );
  const cancelledReport = await readPublishedDispatch(path.join(artifactRoot, "reports", `${detachedDispatchId}.md`));
  assertTaskMissionPrompt(cancelledReport.slice("live:".length), {
    repoId: "runtime-cli",
    taskId,
    canonicalRoot: realpathSync(root),
    workerRoot: realpathSync(workerRoot),
    taskPackageRoot: path.join(realpathSync(root), "harness", packagePath),
    daemonUserRoot: userRoot,
    daemonId,
    runtimeSessionId: detachedSessionId,
    mission: `${taskQueryGuidance(taskId)}\n\nhold`,
  });
  const cancelledWait = runMaybe(root, env, ["runtime", "status", detachedSessionId, "--wait", "--no-stream"]);
  assert.equal(cancelledWait.status, 1);
  assert.equal(cancelledWait.receipt.outcome, "cancelled");
  const cancelledNotificationTrace = await eventuallyNotification(root, detachedDispatchId);
  await eventuallyFile(notificationOnce);
  const onceLines = readFileSync(notificationOnce, "utf8").trim().split(/\r?\n/u),
    cancelledRecords = readDispatchRecords(root, detachedDispatchId).filter(
      (record) => record.kind === "exit_notification",
    );
  assert.equal(onceLines.length, 1, JSON.stringify(onceLines));
  assert.equal(cancelledRecords.filter((record) => record.phase === "started").length, 1);
  assert.equal(cancelledRecords.filter((record) => record.phase === "finished").length, 1);
  assert.equal(cancelledNotificationTrace.finished?.exitCode, 0);
  context.diagnostic(
    `notification at-most-once: ${JSON.stringify({ executions: onceLines.length, records: cancelledRecords })}`,
  );
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const streamRoot = path.join(root, ".harness", "runtime", "dispatches"),
    streamsBeforeRejectedResume = readdirSync(streamRoot).sort(),
    sessionsBeforeRejectedResume = (run(root, env, ["runtime", "status"]).sessions as Array<Record<string, unknown>>)
      .length,
    rejectedResume = runMaybe(root, env, [
      "runtime",
      "run",
      "--resume-dispatch",
      detachedDispatchId,
      "--prompt",
      "failure:empty",
      "--detach",
    ]);
  assert.equal(rejectedResume.status, 1);
  assert.equal(rejectedResume.receipt.code, "runtime_resume_failed", JSON.stringify(rejectedResume.receipt));
  assert.deepEqual(readdirSync(streamRoot).sort(), streamsBeforeRejectedResume);
  assert.equal(
    (run(root, env, ["runtime", "status"]).sessions as Array<Record<string, unknown>>).length,
    sessionsBeforeRejectedResume,
  );
  const originalHeader = readDispatchRecords(root, detachedDispatchId)[0]!;
  const mismatchedAgent = runMaybe(root, env, [
    "agent",
    "run",
    "astra",
    "--resume-dispatch",
    detachedDispatchId,
    "--prompt",
    "follow up",
    "--no-stream",
  ]);
  assert.equal(mismatchedAgent.status, 1);
  assert.equal(mismatchedAgent.receipt.code, "runtime_resume_agent_mismatch");
  const resumedDispatch = run(root, env, [
      "agent",
      "run",
      "terra",
      "--resume-dispatch",
      detachedDispatchId,
      "--prompt",
      "follow up",
      "--no-stream",
    ]),
    resumedDispatchId = String((resumedDispatch.spawn as Record<string, unknown>).dispatchId),
    resumedText = String((resumedDispatch.result as Record<string, unknown>).text);
  assert.ok(resumedText.startsWith("resumed:provider-cli-session:"), resumedText);
  assertTaskMissionPrompt(resumedText.slice("resumed:provider-cli-session:".length), {
    repoId: "runtime-cli",
    taskId,
    canonicalRoot: realpathSync(root),
    workerRoot: realpathSync(workerRoot),
    taskPackageRoot: path.join(realpathSync(root), "harness", packagePath),
    daemonUserRoot: userRoot,
    daemonId,
    runtimeSessionId: String(resumedDispatch.runtimeSessionId),
    mission: `${taskQueryGuidance(taskId)}\n\nfollow up`,
  });
  const resumedRow = (run(root, env, ["task", "dispatches", taskId]).dispatches as Array<Record<string, unknown>>).find(
    (row) => row.dispatchId === resumedDispatchId,
  );
  assert.equal(resumedRow?.status, "succeeded");
  const resumedHeader = readDispatchRecords(root, resumedDispatchId)[0];
  assert.equal(resumedHeader?.agentId, "terra");
  assert.equal(resumedHeader?.cwd, realpathSync(workerRoot));
  assert.equal(resumedHeader?.model, originalHeader.model);
  assert.equal(resumedHeader?.permissionMode, originalHeader.permissionMode);
  assert.equal(resumedHeader?.resumedFromDispatchId, detachedDispatchId);
  const duplicateResume = runMaybe(root, env, [
    "agent",
    "run",
    "terra",
    "--resume-dispatch",
    detachedDispatchId,
    "--prompt",
    "again",
    "--no-stream",
  ]);
  assert.equal(duplicateResume.status, 1);
  assert.equal(duplicateResume.receipt.code, "runtime_dispatch_already_resumed");
  assert.equal((duplicateResume.receipt.diagnostic as Record<string, unknown>).actual, resumedDispatchId);
  assert.equal(
    (
      JSON.parse(
        await readPublishedDispatch(path.join(artifactRoot, "dispatches", `${resumedDispatchId}.json`)),
      ) as Record<string, unknown>
    ).providerSessionId,
    "provider-cli-session",
  );
});

test("Detached runtime results are retrieved from another CLI process over a reused connection", async (context) => {
  const fixture = createRuntimeFixture(context);
  const { root, env, userRoot, daemonId } = fixture;
  const detachedProcess = runMaybe(root, env, [
      "runtime",
      "run",
      "cli-worker",
      "--prompt",
      "stream prompt",
      "--detach",
    ]),
    detachedReceipt = detachedProcess.receipt,
    detachedRuntimeSessionId = String(detachedReceipt.runtimeSessionId);
  assert.equal(detachedProcess.status, 0, detachedProcess.stderr);
  assert.equal(detachedReceipt.nextAction, `ha runtime status ${detachedRuntimeSessionId} --wait`);
  assert.match(
    String(detachedReceipt.summary),
    new RegExp(`next: ha runtime status ${detachedRuntimeSessionId} --wait$`, "u"),
  );
  const retrievalProcess = runMaybe(root, env, [
      "runtime",
      "status",
      detachedRuntimeSessionId,
      "--wait",
      "--no-stream",
    ]),
    retrievedText = String((retrievalProcess.receipt.result as Record<string, unknown>).text);
  assert.equal(retrievalProcess.status, 0, retrievalProcess.stderr);
  assert.equal(retrievalProcess.receipt.outcome, "succeeded");
  assert.equal(retrievedText, "final:stream prompt");
  assert.equal(Number.isInteger(detachedProcess.pid) && Number.isInteger(retrievalProcess.pid), true);
  assert.notEqual(
    detachedProcess.pid,
    retrievalProcess.pid,
    "detach and status --wait must execute in different CLI processes",
  );
  const readerReuse = await eventuallyRuntimeReaderReuse(userRoot, daemonId);
  context.diagnostic(
    `detach cross-process retrieval: ${JSON.stringify({ launcherPid: detachedProcess.pid, retrievalPid: retrievalProcess.pid, runtimeSessionId: detachedRuntimeSessionId, outcome: retrievalProcess.receipt.outcome, resultText: retrievedText, readerReuse })}`,
  );
});

test("Daemon request contracts receive executor attribution only on declared surfaces", async (context) => {
  const fixture = createRuntimeFixture(context);
  const { root, env } = fixture;
  const { taskId, executionId } = seedTask(root, env, "executor");
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  // #1572: with HARNESS_ACTOR declared, the daemon request log is the server-side proof that executor
  // attribution still arrives — inside the action for repo.task.run writes (task start) and at payload
  // level for preset methods (task create) — while nothing is ever rejected for an undeclared executor.
  const requests = readFileSync(path.join(root, ".harness", "requests", "requests.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    requests.find((entry) => entry.method === "repo.task.run" && entry.command === "task-start")?.executor,
    { kind: "agent", id: "runtime-cli-test" },
  );
  assert.deepEqual(requests.find((entry) => entry.method === "repo.task.create")?.executor, {
    kind: "agent",
    id: "runtime-cli-test",
  });
  assert.equal(
    requests.some((entry) => entry.code === "invalid_request"),
    false,
    JSON.stringify(requests.filter((entry) => entry.code === "invalid_request")),
  );
  // A contracted read method with no CLI argv (repo.tasks.documents.list declares a closed payload
  // without executor) stands in for "the next new command": with an explicit HARNESS_ACTOR, injection
  // must follow the daemon-declared surface, so the real daemon accepts the request instead of
  // rejecting an undeclared executor.
  const probe = await runCommandThroughDaemon(
    {
      rootDir: safePath(root),
      repoId: "runtime-cli",
      json: true,
      method: "repo.tasks.documents.list",
      action: { kind: "task-documents-list", taskId },
    },
    undefined,
    { env: { ...env, HARNESS_ACTOR: "agent:injection-probe" } },
  );
  assert.equal(probe.ok, true, JSON.stringify(probe));
});

test("CLI installs identities, updates squads and assembles wildcard worker prompts", async (context) => {
  const fixture = createRuntimeFixture(context);
  const { parent, root, env } = fixture;
  const { squadSource } = installIdentities(parent, root, env);
  const agents = JSON.parse(String(run(root, env, ["agent", "list"]).evidence)) as { agents: Array<{ id: string }> },
    squads = JSON.parse(String(run(root, env, ["squad", "list"]).evidence)) as { squads: Array<{ id: string }> };
  assert.deepEqual(
    agents.agents.map(({ id }) => id),
    ["any-worker", "fable", "opencode-worker", "outsider", "terra"],
  );
  assert.deepEqual(
    squads.squads.map(({ id }) => id),
    ["core-squad"],
  );
  writeIdentity(squadSource, {
    id: "core-squad",
    title: "Core Squad",
    kind: "squad",
    squad: {
      id: "core-squad",
      name: "Core Squad",
      leader: "fable",
      workers: ["terra", "opencode-worker"],
      leaderTurnBudget: 8,
      roster: "# Core Squad\n\nFable delegates; humans edited this roster.",
    },
  });
  run(root, env, ["squad", "install", "--source", squadSource]);
  const squad = JSON.parse(String(run(root, env, ["squad", "inspect", "core-squad"]).evidence)) as {
    squad: { roster: string };
  };
  assert.match(squad.squad.roster, /humans edited/u);
  const { taskId, executionId } = seedTask(root, env, "identity");
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const wildcard = run(root, env, [
    "agent",
    "run",
    "any-worker",
    "--prompt",
    "wildcard prompt",
    "--task",
    taskId,
    "--no-stream",
  ]);
  const wildcardText = String((wildcard.result as Record<string, unknown>).text);
  assert.ok(
    wildcardText.startsWith(
      "final:# Agent Identity: Any Worker (any-worker)\n\nUse any compatible runtime.\n\n# Harness Execution Discipline",
    ),
    wildcardText,
  );
  assert.match(wildcardText, /# Worker Role/u);
  assert.ok(wildcardText.endsWith(`# Assigned Mission\n${taskQueryGuidance(taskId)}\n\nwildcard prompt`), wildcardText);
  assert.ok(
    wildcardText.indexOf("# Worker Role") < wildcardText.indexOf("prompt://review") &&
      wildcardText.indexOf("prompt://review") < wildcardText.indexOf("# Standard Task") &&
      wildcardText.indexOf("# Standard Task") < wildcardText.indexOf("# Mission"),
    "the role prompt, declared prompts, and preset must reach the real CLI dispatch in declaration order",
  );
});

test("Concurrent fact writes preserve runtime progress attribution and task wait artifacts", async (context) => {
  const fixture = createRuntimeFixture(context);
  installIdentities(fixture.parent, fixture.root, fixture.env);
  const { root, env } = fixture;
  const { taskId, executionId, packagePath } = seedTask(root, env, "progress");
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const concurrentProjectionReads = await Promise.all([
      ...Array.from({ length: 6 }, (_, index) =>
        runAsync(root, env, [
          "fact",
          "record",
          taskId,
          "--statement",
          `Concurrent projection observation ${String(index + 1)}`,
          "--source",
          `test:runtime-cli-concurrency:${String(index + 1)}`,
        ]),
      ),
      runAsync(root, env, [
        "agent",
        "run",
        "terra",
        "--prompt",
        `progress-middle:${taskId}`,
        "--task",
        taskId,
        "--no-stream",
      ]),
    ]),
    factWrites = concurrentProjectionReads.slice(0, 6),
    progressResult = concurrentProjectionReads[6]!;
  assert.equal(
    factWrites.every((result) => result.status === 0 && result.receipt.outcome === "applied"),
    true,
    JSON.stringify(factWrites),
  );
  assert.equal(progressResult.status, 0, `${progressResult.stderr}\n${JSON.stringify(progressResult.receipt)}`);
  context.diagnostic(
    `projection readiness concurrency: ${JSON.stringify({ factWrites: factWrites.length, runtime: progressResult.receipt.outcome })}`,
  );
  const progressRun = progressResult.receipt,
    progressDispatchId = String((progressRun.spawn as Record<string, unknown>).dispatchId),
    shownProgress = JSON.parse(String(run(root, env, ["task", "show", taskId]).evidence)) as {
      progress: Array<{
        actor: { executor: unknown };
        payload: { text: string; evidence: unknown[]; runtimeSessionId?: string };
      }>;
    },
    runtimeExecutor = { kind: "agent", id: `runtime-session:${progressRun.runtimeSessionId}` };
  assert.deepEqual(
    shownProgress.progress.map((event) => event.payload.text),
    ["Provider checkpoint one.", "Provider checkpoint two."],
  );
  assert.equal(
    shownProgress.progress.every((event) => event.payload.evidence.length === 1),
    true,
  );
  assert.deepEqual(
    shownProgress.progress.map((event) => event.actor.executor),
    [runtimeExecutor, runtimeExecutor],
  );
  assert.deepEqual(
    shownProgress.progress.map((event) => event.payload.runtimeSessionId),
    [progressRun.runtimeSessionId, progressRun.runtimeSessionId],
  );
  const unrelatedProgress = runMaybe(root, { ...env, HARNESS_ACTOR: "agent:unrelated-runtime" }, [
    "task",
    "progress",
    "append",
    taskId,
    "--text",
    "Unrelated checkpoint.",
    "--evidence",
    "test:reports/runtime-progress.txt:unrelated",
  ]);
  assert.equal(unrelatedProgress.status, 1);
  assert.equal(unrelatedProgress.receipt.code, "progress_lease_required");
  const taskWait = runMaybe(root, env, ["runtime", "status", "--task", taskId, "--wait", "--no-stream"]);
  assert.equal(taskWait.status, 0, `${taskWait.stderr}\n${JSON.stringify(taskWait.receipt)}`);
  assert.equal(taskWait.receipt.outcome, "succeeded");
  const waitedRow = (taskWait.receipt.dispatches as Array<Record<string, unknown>>).find(
    (row) => row.dispatchId === progressDispatchId,
  );
  assert.equal(waitedRow?.exitCode, 0);
  assert.equal(waitedRow?.dispatchPath, `${packagePath}/artifacts/dispatches/${progressDispatchId}.json`);
  assert.equal(waitedRow?.reportPath, `${packagePath}/artifacts/reports/${progressDispatchId}.md`);
});

test("A detached runtime worker survives daemon restart and remains cancellable", async (context) => {
  const fixture = createRuntimeFixture(context);
  const { root, env } = fixture;
  const restartDetached = run(root, env, ["runtime", "run", "cli-worker", "--prompt", "hold", "--detach"]),
    restartSessionId = String(restartDetached.runtimeSessionId),
    restartDispatchId = String(restartDetached.dispatchId),
    liveBeforeRestart = await eventuallyRuntimeStatus(root, env, restartSessionId, "live"),
    workerPid = Number(
      readDispatchRecords(root, restartDispatchId).find((record) => record.kind === "process_started")?.pid,
    ),
    daemonBeforeRestart = run(root, env, ["daemon", "status"]),
    stoppedForRestart = run(root, env, ["daemon", "stop", "--force"]);
  assert.equal(liveBeforeRestart.session.liveness, "live");
  assert.equal(processAlive(workerPid), true, `runtime worker ${String(workerPid)} must be live before daemon restart`);
  assert.equal(stoppedForRestart.forced, true, JSON.stringify(stoppedForRestart));
  assert.equal(processAlive(workerPid), true, `runtime worker ${String(workerPid)} must survive daemon stop --force`);
  assert.equal(run(root, env, ["daemon", "start", "--service"]).ok, true);
  const liveAfterRestart = await eventuallyRuntimeStatus(root, env, restartSessionId, "live"),
    daemonAfterRestart = run(root, env, ["daemon", "status"]);
  assert.notEqual(daemonAfterRestart.pid, daemonBeforeRestart.pid, "runtime status must use a restarted daemon");
  assert.equal(liveAfterRestart.session.liveness, "live");
  assert.equal(liveAfterRestart.session.activity.outcome, null);
  assert.equal(processAlive(workerPid), true, `runtime worker ${String(workerPid)} must agree with runtime status`);
  assert.equal(run(root, env, ["runtime", "cancel", restartSessionId]).detail, "cancelled");
  context.diagnostic(
    `daemon restart liveness: ${JSON.stringify({
      runtimeSessionId: restartSessionId,
      workerPid,
      daemonBefore: daemonBeforeRestart.pid,
      daemonAfter: daemonAfterRestart.pid,
      before: liveBeforeRestart.session.liveness,
      after: liveAfterRestart.session.liveness,
    })}`,
  );
});

test("Read-only dispatch contracts and closed batch and wire payloads are enforced", async (context) => {
  const fixture = createRuntimeFixture(context);
  const { root, env } = fixture;
  const { taskId, executionId } = seedTask(root, env, "validation");
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const readOnly = runMaybe(root, env, [
    "runtime",
    "run",
    "cli-worker",
    "--permission-mode",
    "read-only",
    "--prompt",
    "read-only",
    "--no-stream",
  ]);
  assert.equal(readOnly.status, 0, `${readOnly.stderr}\n${JSON.stringify(readOnly.receipt)}`);
  assert.equal(readOnly.receipt.outcome, "succeeded");
  const readOnlySpawn = readOnly.receipt.spawn as Record<string, unknown>;
  assert.deepEqual(
    { ledgerAccess: readOnlySpawn.ledgerAccess, reportDelivery: readOnlySpawn.reportDelivery },
    { ledgerAccess: "unavailable", reportDelivery: "stdout" },
  );
  assert.match(
    String((readOnly.receipt.result as Record<string, unknown>).text),
    /Read-only Dispatch Contract[\s\S]*daemon-ledger commands are unavailable[\s\S]*final stdout/u,
  );
  const noAction = runMaybe(root, env, ["runtime", "run", "cli-worker", "--prompt", "no-action", "--no-stream"]);
  assert.equal(noAction.status, 0, `${noAction.stderr}\n${JSON.stringify(noAction.receipt)}`);
  assert.equal(noAction.receipt.outcome, "succeeded");
  writeFileSync(
    path.join(root, "batch-unknown-declaration.json"),
    JSON.stringify({
      schema: "runtime-batch/v1",
      maxConcurrency: 1,
      dispatches: [{ instance: "cli-worker", prompt: "unused" }],
      permissionMode: "read-only",
    }),
  );
  const unknownDeclaration = runMaybe(root, env, ["runtime", "batch", "batch-unknown-declaration.json"]);
  assert.equal(unknownDeclaration.status, 1);
  assert.equal(unknownDeclaration.receipt.code, "batch_file_invalid");
  assert.equal((unknownDeclaration.receipt.diagnostic as Record<string, unknown>).kind, "validation");
  writeFileSync(
    path.join(root, "batch-unknown-dispatch.json"),
    JSON.stringify({
      schema: "runtime-batch/v1",
      maxConcurrency: 1,
      dispatches: [{ instance: "cli-worker", prompt: "unused", permissionMode: "read-only" }],
    }),
  );
  const unknownDispatch = runMaybe(root, env, ["runtime", "batch", "batch-unknown-dispatch.json"]);
  assert.equal(unknownDispatch.status, 1);
  assert.equal(unknownDispatch.receipt.code, "batch_file_invalid");
  assert.equal((unknownDispatch.receipt.diagnostic as Record<string, unknown>).kind, "validation");
  const unknownSpawn = await runCommandThroughDaemon(
    {
      rootDir: safePath(root),
      repoId: "runtime-cli",
      json: true,
      method: "repo.agentRuntime.spawn",
      action: {
        kind: "runtime-run",
        runtimeInstanceId: "cli-worker",
        cwd: { scope: "repo-root" },
        prompt: "unused",
        taskId: null,
        idempotencyKey: "unknown-wire-field",
        permission_mode: "read-only",
      } as never,
    },
    undefined,
    { env },
  );
  assert.equal(unknownSpawn.code, "unknown_field");
  const unknownSpawnDiagnostic = unknownSpawn.diagnostic as Record<string, unknown>;
  assert.deepEqual(
    {
      kind: unknownSpawnDiagnostic.kind,
      entity: unknownSpawnDiagnostic.entity,
      field: unknownSpawnDiagnostic.field,
      actual: unknownSpawnDiagnostic.actual,
    },
    {
      kind: "validation",
      entity: "repo.agentRuntime.spawn",
      field: "permission_mode",
      actual: "unknown",
    },
  );
  assert.match(String(unknownSpawnDiagnostic.expectation), /Allowed fields:.*agentId.*permissionMode/u);
  const unknownCancel = await runCommandThroughDaemon(
    {
      rootDir: safePath(root),
      repoId: "runtime-cli",
      json: true,
      method: "repo.agentRuntime.cancel",
      action: { kind: "runtime-cancel", runtimeSessionId: "missing", force: true } as never,
    },
    undefined,
    { env },
  );
  assert.equal(unknownCancel.code, "unknown_field");
  assert.deepEqual(
    {
      kind: (unknownCancel.diagnostic as Record<string, unknown>).kind,
      field: (unknownCancel.diagnostic as Record<string, unknown>).field,
    },
    { kind: "validation", field: "force" },
  );
  const unknownRead = await runCommandThroughDaemon(
    {
      rootDir: safePath(root),
      repoId: "runtime-cli",
      json: true,
      method: "repo.task.read",
      action: { kind: "decision-list", permissionMode: "read-only" } as never,
    },
    undefined,
    { env: { ...env, HARNESS_ACTOR: "" } },
  );
  assert.equal(unknownRead.code, "invalid_command");
});
