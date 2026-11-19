// harness-test-tier: integration
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { eventuallyValue } from "../../daemon/test/fixtures/runtime-ingress.ts";
import { writeProviderExecutable } from "../../daemon/test/fixtures/runtime-stub.ts";
import {
  livingDeliverableProtocol,
  taskPlanSection,
  taskPrPublicationNote,
  taskQueryGuidance,
} from "@harness-anything/daemon/internal/runtime-spawn-mission";
import { safePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { writeFleetEdgeConfig } from "@harness-anything/daemon/internal/client/fleet-edge-config";
import { registerDaemonRepo } from "@harness-anything/storage";
import { runCommandThroughDaemon } from "../src/daemon/client.ts";
import { realizedTaskPlan as realizedPlan } from "../../../tools/fixtures/task-plan.mjs";
import {
  assertTaskMissionPrompt,
  createRuntimeFixture,
  eventuallyFile,
  eventuallyNotification,
  eventuallyRuntimeReaderReuse,
  eventuallyTerminal,
  installIdentities,
  published,
  readDispatchRecords,
  readPublishedDispatch,
  renderedRulingContract,
  run,
  runMaybe,
  seedTask,
  workerWorktreeBoundary,
} from "./runtime-cli.fixtures.ts";

test("dispatch JSONL reads ignore only an unterminated tail record", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-dispatch-tail-")),
    dispatchId = "dispatch-tail",
    stream = path.join(root, ".harness", "runtime", "dispatches", `${dispatchId}.jsonl`),
    record = JSON.stringify({ kind: "provider_event", event: { type: "thread.started" } });
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.dirname(stream), { recursive: true });

  writeFileSync(stream, record.slice(0, -1));
  assert.deepEqual(readDispatchRecords(root, dispatchId), []);
  writeFileSync(stream, `${record}\n${record.slice(0, -1)}`);
  assert.deepEqual(readDispatchRecords(root, dispatchId), [JSON.parse(record)]);
  writeFileSync(stream, `${record}\n{"kind":}\n`);
  assert.throws(() => readDispatchRecords(root, dispatchId), SyntaxError);
});

test("runtime instance CLI list returns the node identity for the current Fleet edge repository", async (context) => {
  const { root, userRoot, parent, env } = createRuntimeFixture(context),
    repoId = "runtime-cli";
  registerDaemonRepo({
    canonicalRoot: root,
    repoId,
    mode: "remote-edge",
    userRoot,
    createConvenienceLinks: false,
  });
  writeFileSync(path.join(parent, "fleet.crt"), "test fleet certificate\n", "utf8");
  writeFleetEdgeConfig(root, {
    repoId,
    host: "center.example.invalid",
    port: 7443,
    caPath: path.join(parent, "fleet.crt"),
    nodeId: "edge-runtime-node",
    credential: "test-fleet-credential",
    viewRoot: path.join(parent, "view"),
    quotaBytes: 1_048_576,
  });

  const receipt = run(root, env, ["runtime", "instance", "list", "--all"]);
  assert.equal(receipt.nodeId, "edge-runtime-node");
  assert.equal(
    (receipt.instances as readonly { readonly providerHealth: { readonly nodeId: string } }[])[0]!.providerHealth
      .nodeId,
    "edge-runtime-node",
  );
});

test(
  "parked runtime awaits omit the repo-read response deadline at the transport seam",
  { timeout: 300_000 },
  async (context) => {
    const { root, env } = createRuntimeFixture(context);
    const deadlines: unknown[] = [];
    const captureDeadline =
      <Args extends unknown[], Result>(_request: (...args: Args) => Promise<Result>) =>
      async (...args: Args): Promise<Result> => {
        deadlines.push(args[4]);
        return { ok: true } as Result;
      };
    await runCommandThroughDaemon(
      {
        rootDir: safePath(root),
        repoId: "runtime-cli",
        json: true,
        method: "repo.agentRuntime.sessions.await",
        action: { kind: "runtime-sessions-await", runtimeSessionIds: ["runtime-1"], noStream: true },
      },
      undefined,
      { env },
      captureDeadline,
    );
    await runCommandThroughDaemon(
      {
        rootDir: safePath(root),
        repoId: "runtime-cli",
        json: true,
        method: "repo.agentRuntime.overview",
        action: { kind: "runtime-status", taskId: "task-1" },
      },
      undefined,
      { env },
      captureDeadline,
    );
    assert.deepEqual(deadlines, [undefined, 30_000]);
  },
);

test(
  "Task dispatch rejects an incomplete plan then automatically acquires its lease",
  { timeout: 300_000 },
  async (context) => {
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
    const automaticPackagePath = String(automaticTask.workspacePackagePath),
      automaticPlanPath = `${automaticPackagePath}/task_plan.md`,
      oneSectionMissing = realizedPlan("Automatic lease").replace(/\n\n## Constraints\n\n[^\n]+/u, "");
    published(root, env, automaticTask);
    writeFileSync(path.join(root, automaticPlanPath), oneSectionMissing);
    const automaticArgs = [
        "agent",
        "run",
        "terra",
        "--prompt",
        "must acquire its lease",
        "--cwd",
        ".",
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
      missingSections: [{ section: "Constraints", reason: "empty" }],
    });
    writeFileSync(path.join(root, automaticPackagePath, "task_plan.md"), realizedPlan("Automatic lease"));
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
    // This case owns the detached session and settles it before its daemon is torn down. The stub
    // worker delivers nothing on the task, so the settled outcome is unknown and the wait exits 1.
    runMaybe(root, env, [
      "runtime",
      "status",
      String(automaticLease.receipt.runtimeSessionId),
      "--wait",
      "--no-stream",
    ]);
  },
);

const cancellationResumeTest = async (context: TestContext) => {
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
  // Cancellation terminates promptly; witness the output this test expects to archive first.
  await eventuallyValue(
    () =>
      readDispatchRecords(root, detachedDispatchId).find((record) => {
        const event = record.event as { item?: { id?: string } } | undefined;
        return record.kind === "provider_event" && event?.item?.id === "live";
      }) ?? null,
    `dispatch ${detachedDispatchId} provider live event`,
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
  const cancelledMission = await readPublishedDispatch(path.join(artifactRoot, "missions", `${detachedDispatchId}.md`));
  assertTaskMissionPrompt(cancelledMission, {
    repoId: "runtime-cli",
    taskId,
    workerRoot: realpathSync(workerRoot),
    taskPackageRoot: path.join(realpathSync(root), packagePath),
    daemonUserRoot: userRoot,
    daemonId,
    runtimeSessionId: detachedSessionId,
    mission: `${taskPlanSection(realizedPlan("cancel-resume"))}\n\n${taskQueryGuidance(taskId)}\n\n${renderedRulingContract(detachedDispatchId)}\n\n${workerWorktreeBoundary}\n\n本任务的提交将由评审员 closeout-reviewer 审查（内置默认）。提交即自动派评审；预算未耗尽时 changes_requested 会回到本轮返工并携带评审报告，预算耗尽后由业主使用 ha task rework <task-id> --reason <why> 退回。\n\n${livingDeliverableProtocol("baseline")!}\n\n${taskPrPublicationNote}\n\nhold`,
  });
  // A cancelled run authored no dispatch report; archiving its interrupted text as one left a
  // daemon-managed fragment the worker could not retire. The dispatch record and mission still
  // settle, and the partial output stays reachable through the record's resultRef.
  assert.equal(
    existsSync(path.join(artifactRoot, "reports", `${detachedDispatchId}.md`)),
    false,
    "cancelled dispatch must not publish a fallback report",
  );
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
  // The resumed worker completes its provider turn but commits nothing, so the dispatch settles
  // stopped and the no-stream wait exits 1 (F-4C182EEE).
  const resumedDispatch = runMaybe(root, env, [
    "agent",
    "run",
    "terra",
    "--resume-dispatch",
    detachedDispatchId,
    "--prompt",
    "follow up",
    "--no-stream",
  ]);
  assert.equal(resumedDispatch.status, 1, `${resumedDispatch.stderr}\n${JSON.stringify(resumedDispatch.receipt)}`);
  const resumedDispatchId = String((resumedDispatch.receipt.spawn as Record<string, unknown>).dispatchId),
    resumedText = String((resumedDispatch.receipt.result as Record<string, unknown>).text),
    stopGuidance =
      `\n\nTask ${taskId} is not submitted: the worker exited without a submitted delivery. ` +
      `Recover the stopped worker with: ha agent run terra --task ${taskId} --recover-dispatch ${resumedDispatchId} ` +
      `--execution-id ${executionId} --expected-version <revision> --idempotency-key <key>`;
  assert.ok(resumedText.startsWith("resumed:provider-cli-session:"), resumedText);
  assert.ok(resumedText.endsWith(stopGuidance), "an unsubmitted resume must carry its continuation entry");
  assertTaskMissionPrompt(resumedText.slice("resumed:provider-cli-session:".length, -stopGuidance.length), {
    repoId: "runtime-cli",
    taskId,
    workerRoot: realpathSync(workerRoot),
    taskPackageRoot: path.join(realpathSync(root), packagePath),
    daemonUserRoot: userRoot,
    daemonId,
    runtimeSessionId: String(resumedDispatch.receipt.runtimeSessionId),
    mission: `${taskPlanSection(realizedPlan("cancel-resume"))}\n\n${taskQueryGuidance(taskId)}\n\n${renderedRulingContract(resumedDispatchId)}\n\n${workerWorktreeBoundary}\n\n本任务的提交将由评审员 closeout-reviewer 审查（内置默认）。提交即自动派评审；预算未耗尽时 changes_requested 会回到本轮返工并携带评审报告，预算耗尽后由业主使用 ha task rework <task-id> --reason <why> 退回。\n\n${livingDeliverableProtocol("baseline")!}\n\n${taskPrPublicationNote}\n\nfollow up`,
    continuationContext: true,
  });
  const resumedRow = (
    runMaybe(root, env, ["task", "dispatches", taskId]).receipt.dispatches as Array<Record<string, unknown>>
  ).find((row) => row.dispatchId === resumedDispatchId);
  assert.equal(resumedRow?.status, "stopped");
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
};
test(
  "Cancellation is idempotent, notifies once and resumes the archived provider session",
  { timeout: 60_000 },
  cancellationResumeTest,
);

test(
  "rejected task resume stream cleanup follows the observed lease stop proof",
  { timeout: 300_000 },
  async (context) => {
    const fixture = createRuntimeFixture(context);
    installIdentities(fixture.parent, fixture.root, fixture.env);
    const { root, env } = fixture,
      { taskId, executionId } = seedTask(root, env, "rejected-resume-stop-proof");
    run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
    const detached = run(root, env, [
      "agent",
      "run",
      "terra",
      "--prompt",
      "hold",
      "--cwd",
      ".",
      "--task",
      taskId,
      "--detach",
    ]);
    const sourceDispatchId = String(detached.dispatchId),
      sourceSessionId = String(detached.runtimeSessionId);
    await eventuallyValue(
      () =>
        readDispatchRecords(root, sourceDispatchId).find((record) => {
          const event = record.event as { item?: { id?: string } } | undefined;
          return record.kind === "provider_event" && event?.item?.id === "live";
        }) ?? null,
      `dispatch ${sourceDispatchId} provider live event`,
    );
    assert.equal(run(root, env, ["runtime", "cancel", sourceSessionId]).detail, "cancelled");
    await eventuallyTerminal(root, env, ["task", "dispatches", taskId]);
    run(root, env, ["task", "start", taskId, "--execution-id", executionId]);

    const streamRoot = path.join(root, ".harness", "runtime", "dispatches"),
      streamsBeforeRejectedResume = readdirSync(streamRoot).sort(),
      leaseBeforeRejectedResume = (
        JSON.parse(String(run(root, env, ["task", "show", taskId]).evidence)) as {
          lease: { phase: string } | null;
        }
      ).lease?.phase;
    assert.equal(leaseBeforeRejectedResume, "held", "the task must hold its lease before retry admission");
    const rejectedResume = runMaybe(root, env, [
      "runtime",
      "run",
      "--resume-dispatch",
      sourceDispatchId,
      "--prompt",
      "failure:empty",
      "--detach",
    ]);
    assert.equal(rejectedResume.status, 1);
    assert.equal(rejectedResume.receipt.code, "runtime_resume_failed", JSON.stringify(rejectedResume.receipt));

    const streamsAfterRejectedResume = readdirSync(streamRoot).sort(),
      leasePhase =
        (
          JSON.parse(String(run(root, env, ["task", "show", taskId]).evidence)) as {
            lease: { phase: string } | null;
          }
        ).lease?.phase ?? null,
      addedStreams = streamsAfterRejectedResume.filter((stream) => !streamsBeforeRejectedResume.includes(stream));
    context.diagnostic(`rejected resume settlement: ${JSON.stringify({ leasePhase, addedStreams })}`);
    // The persisted lease is the settlement's stop-proof result; unresolved proof leaves it held,
    // while a proven stop releases it. The stream assertion follows that observed state.
    if (leasePhase === "held") {
      assert.equal(addedStreams.length, 1, "an unproven process-group stop must retain the rejected resume stream");
    } else {
      assert.ok(leasePhase === null || leasePhase === "released", `unexpected task lease state: ${leasePhase}`);
      assert.deepEqual(
        streamsAfterRejectedResume,
        streamsBeforeRejectedResume,
        "a proven process-group stop must clean up the rejected resume stream",
      );
    }
  },
);

test(
  "Detached runtime results are retrieved from another CLI process over a reused connection",
  { timeout: 300_000 },
  async (context) => {
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
      new RegExp(`^wait: ha runtime status ${detachedRuntimeSessionId} --wait blocks until settlement`, "mu"),
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
  },
);

test(
  "ha agent run with CLAUDE_CODE_SESSION_ID hands off a bare-person lease and supports --recover-dispatch and --resume-dispatch",
  { timeout: 300_000 },
  async (context) => {
    const fixture = createRuntimeFixture(context);
    installIdentities(fixture.parent, fixture.root, fixture.env);
    const { root, env } = fixture,
      { taskId, executionId } = seedTask(root, env, "claude-session-executor-recovery"),
      workerRelative = ".worktrees/worker-claude",
      humanEnv: NodeJS.ProcessEnv = { ...env },
      claudeEnv: NodeJS.ProcessEnv = {
        ...env,
        CLAUDE_CODE_SESSION_ID: "claude-session-e2e-1",
      };
    delete humanEnv.HARNESS_ACTOR;
    delete claudeEnv.HARNESS_ACTOR;
    mkdirSync(path.join(root, workerRelative), { recursive: true });
    run(root, humanEnv, ["task", "start", taskId, "--execution-id", executionId]);
    const initialRun = runMaybe(root, claudeEnv, [
      "agent",
      "run",
      "terra",
      "--task",
      taskId,
      "--cwd",
      workerRelative,
      "--prompt",
      "first claude session run",
      "--no-stream",
    ]);
    assert.equal(initialRun.status, 1, `${initialRun.stderr}\n${JSON.stringify(initialRun.receipt)}`);
    assert.notEqual(initialRun.receipt.code, "invalid_runtime_spawn", JSON.stringify(initialRun.receipt));
    assert.notEqual(initialRun.receipt.code, "lease_conflict", JSON.stringify(initialRun.receipt));
    assert.ok(initialRun.receipt.spawn, JSON.stringify(initialRun.receipt));
    const firstDispatchId = String((initialRun.receipt.spawn as Record<string, unknown>).dispatchId),
      firstSessionId = String(initialRun.receipt.runtimeSessionId);
    assert.ok(firstDispatchId.length > 0 && firstSessionId.length > 0, JSON.stringify(initialRun.receipt));
    assert.equal(initialRun.receipt.outcome, "stopped", JSON.stringify(initialRun.receipt));
    const shownBeforeRecover = JSON.parse(String(run(root, humanEnv, ["task", "show", taskId]).evidence)) as {
        readonly revision: number;
      },
      revisionBeforeRecover = Number(shownBeforeRecover.revision);
    assert.equal(Number.isInteger(revisionBeforeRecover), true, JSON.stringify(shownBeforeRecover));
    const dispatchesAfterInitial = runMaybe(root, humanEnv, ["task", "dispatches", taskId]).receipt.dispatches as Array<
      Record<string, unknown>
    >;
    assert.equal(
      dispatchesAfterInitial.find((row) => row.dispatchId === firstDispatchId)?.status,
      "stopped",
      JSON.stringify(dispatchesAfterInitial),
    );
    const recoveredRun = runMaybe(root, claudeEnv, [
      "agent",
      "run",
      "terra",
      "--task",
      taskId,
      "--cwd",
      workerRelative,
      "--recover-dispatch",
      firstDispatchId,
      "--execution-id",
      executionId,
      "--expected-version",
      String(revisionBeforeRecover),
      "--idempotency-key",
      "e2e-recover-1",
      "--prompt",
      "recover stopped claude worker",
      "--no-stream",
    ]);
    assert.equal(recoveredRun.status, 1, `${recoveredRun.stderr}\n${JSON.stringify(recoveredRun.receipt)}`);
    assert.notEqual(recoveredRun.receipt.code, "invalid_runtime_spawn", JSON.stringify(recoveredRun.receipt));
    assert.ok(recoveredRun.receipt.spawn, JSON.stringify(recoveredRun.receipt));
    const recoveredDispatchId = String((recoveredRun.receipt.spawn as Record<string, unknown>).dispatchId);
    assert.notEqual(recoveredDispatchId, firstDispatchId);
    assert.equal(recoveredRun.receipt.outcome, "stopped", JSON.stringify(recoveredRun.receipt));
    const recoveredHeader = readDispatchRecords(root, recoveredDispatchId)[0];
    assert.equal(recoveredHeader?.resumedFromDispatchId, undefined);
    const resumedRun = runMaybe(root, claudeEnv, [
      "agent",
      "run",
      "terra",
      "--resume-dispatch",
      recoveredDispatchId,
      "--prompt",
      "continue after recovery",
      "--no-stream",
    ]);
    assert.equal(resumedRun.status, 1, `${resumedRun.stderr}\n${JSON.stringify(resumedRun.receipt)}`);
    assert.notEqual(resumedRun.receipt.code, "invalid_runtime_spawn", JSON.stringify(resumedRun.receipt));
    assert.ok(resumedRun.receipt.spawn, JSON.stringify(resumedRun.receipt));
    const resumedDispatchId = String((resumedRun.receipt.spawn as Record<string, unknown>).dispatchId),
      resumedHeader = readDispatchRecords(root, resumedDispatchId)[0];
    assert.equal(resumedHeader?.resumedFromDispatchId, recoveredDispatchId);
    context.diagnostic(
      `claude session e2e: ${JSON.stringify({ firstDispatchId, firstSessionId, recoveredDispatchId, resumedDispatchId })}`,
    );
  },
);
