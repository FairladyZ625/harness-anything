// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  livingDeliverableProtocol,
  taskPlanSection,
  taskPrPublicationNote,
  taskQueryGuidance,
} from "@harness-anything/daemon/internal/runtime-spawn-mission";
import { realizedTaskPlan as realizedPlan } from "../../../tools/fixtures/task-plan.mjs";
import {
  assertTaskMissionPrompt,
  createRuntimeFixture,
  installIdentities,
  readDispatchRecords,
  readPublishedDispatch,
  recoverLatest,
  renderedRulingContract,
  run,
  runMaybe,
  seedTask,
  workerWorktreeBoundary,
} from "./runtime-cli.fixtures.ts";

test("CLI assignment freezes expiry and a center start preserves it across release", (context) => {
  const { root, env } = createRuntimeFixture(context),
    { taskId, executionId } = seedTask(root, env, "assignment");
  const show = () => JSON.parse(String(run(root, env, ["task", "show", taskId]).evidence));
  const before = show();
  const assigned = run(root, env, [
    "task",
    "assign",
    taskId,
    "--person",
    "owner",
    "--expected-version",
    String(before.revision),
  ]);
  assert.equal(assigned.outcome, "applied");
  const after = show();
  assert.equal(after.task.assignment.assignee.personId, "owner");
  const expiresAt = after.task.assignment.expiresAt;
  assert.ok(Date.parse(expiresAt) > Date.now() + 23 * 60 * 60 * 1000);
  const conflict = runMaybe(root, env, ["task", "unassign", taskId, "--expected-version", String(before.revision)]);
  assert.notEqual(conflict.status, 0);
  run(root, { ...env, HARNESS_ACTOR: "" }, ["settings", "update", "--task-assignment-ttl-ms", "3600000"]);
  assert.equal(show().task.assignment.expiresAt, expiresAt);
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const rejected = runMaybe(root, env, ["task", "unassign", taskId, "--expected-version", String(show().revision)]);
  assert.notEqual(rejected.status, 0);
  run(root, env, ["task", "release", taskId]);
  assert.equal(show().task.assignment.expiresAt, expiresAt);
  run(root, env, ["task", "unassign", taskId, "--expected-version", String(show().revision)]);
  assert.equal(show().task.assignment, null);
});

test(
  "Delegated dispatches archive identity, mission and separate reports and reject invalid delegates",
  { timeout: 300_000 },
  async (context) => {
    const fixture = createRuntimeFixture(context);
    const { parent, root, env, userRoot, daemonId } = fixture;
    installIdentities(parent, root, env);
    // The stub worker completes its provider turn but never commits, so every task-bound dispatch in
    // this file settles stopped and each wait/report command honestly exits 1 (F-4C182EEE).
    const runStopped = (args: readonly string[]): Record<string, unknown> => {
      const result = runMaybe(root, env, args);
      assert.equal(result.status, 1, `${result.stderr}\n${JSON.stringify(result.receipt)}`);
      return result.receipt;
    };
    const { taskId, executionId, packagePath, artifactRoot } = seedTask(root, env, "archive");
    run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
    const first = runStopped([
      "agent",
      "run",
      "terra",
      "--prompt",
      "first report",
      "--cwd",
      ".",
      "--task",
      taskId,
      "--no-stream",
    ]);
    const firstDispatchId = String((first.spawn as Record<string, unknown>).dispatchId);
    await readPublishedDispatch(path.join(artifactRoot, "dispatches", `${firstDispatchId}.json`));
    run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
    const assembledPromptPrefix =
        "# Agent Identity: Terra (terra)\n\nReview precisely.\n\n# Harness Execution Discipline",
      boundArgs = [
        "agent",
        "run",
        "fable",
        "--to",
        "terra",
        "--prompt",
        "bound prompt",
        "--cwd",
        ".",
        "--task",
        taskId,
        ...recoverLatest(root, env, taskId),
        "--no-stream",
      ],
      bound = runStopped(boundArgs),
      boundSpawn = bound.spawn as Record<string, unknown>,
      boundDispatchId = String(boundSpawn.dispatchId),
      boundDispatch = JSON.parse(
        await readPublishedDispatch(path.join(artifactRoot, "dispatches", `${boundDispatchId}.json`)),
      ) as Record<string, unknown>;
    // #4376: a caller that lost the first receipt retries the same recovery through the real CLI and
    // daemon RPC; it gets the receipt of the dispatch already produced, and no second worker runs.
    const boundReplay = runMaybe(root, env, boundArgs),
      boundReplaySpawn = boundReplay.receipt.spawn as Record<string, unknown> | undefined;
    assert.equal(boundReplaySpawn?.dispatchId, boundDispatchId, JSON.stringify(boundReplay.receipt));
    assert.equal(boundReplaySpawn?.opId, boundSpawn.opId, "the replay answers with the original operation");
    assert.equal(boundReplaySpawn?.status, "accepted_durable", JSON.stringify(boundReplaySpawn));
    assert.equal((boundReplaySpawn?.recovery as Record<string, unknown> | undefined)?.replayed, true);
    assert.equal(
      (runMaybe(root, env, ["task", "dispatches", taskId]).receipt.dispatches as Array<Record<string, unknown>>).length,
      2,
      "the replay leaves the first and the recovered dispatch only",
    );
    const assembledPrompt = await readPublishedDispatch(path.join(artifactRoot, "missions", `${boundDispatchId}.md`));
    assert.ok(assembledPrompt.startsWith(assembledPromptPrefix), assembledPrompt);
    assert.match(assembledPrompt, /# Worker Role/u);
    assertTaskMissionPrompt(assembledPrompt, {
      repoId: "runtime-cli",
      taskId,
      workerRoot: realpathSync(root),
      taskPackageRoot: path.join(realpathSync(root), packagePath),
      daemonUserRoot: userRoot,
      daemonId,
      runtimeSessionId: String(bound.runtimeSessionId),
      mission: `${taskPlanSection(realizedPlan("archive"))}\n\n${taskQueryGuidance(taskId)}\n\n${renderedRulingContract(boundDispatchId)}\n\n${workerWorktreeBoundary}\n\n本任务的提交将由评审员 closeout-reviewer 审查（内置默认）。提交即自动派评审；预算未耗尽时 changes_requested 会回到本轮返工并携带评审报告，预算耗尽后由业主使用 ha task rework <task-id> --reason <why> 退回。\n\n${livingDeliverableProtocol("baseline")!}\n\n${taskPrPublicationNote}\n\nbound prompt`,
      continuationContext: true,
    });
    assert.ok(
      assembledPrompt.indexOf("# Worker Role") < assembledPrompt.indexOf("prompt://review") &&
        assembledPrompt.indexOf("prompt://review") < assembledPrompt.indexOf("# Standard Task") &&
        assembledPrompt.indexOf("# Standard Task") < assembledPrompt.indexOf("# Mission"),
      "a squad-delegated worker must keep its role, prompts, and preset through the real CLI",
    );
    const sameNamedReportDispatches = [firstDispatchId, boundDispatchId],
      sameNamedReportPaths = sameNamedReportDispatches.map((dispatchId) =>
        path.join(artifactRoot, "reports", `${dispatchId}.md`),
      ),
      sameNamedReportArchives = sameNamedReportDispatches.map(
        (dispatchId) =>
          JSON.parse(readFileSync(path.join(artifactRoot, "dispatches", `${dispatchId}.json`), "utf8")) as Record<
            string,
            unknown
          >,
      );
    const evidenceRoot = path.join(root, packagePath, "artifacts", "dispatches", boundDispatchId);
    assert.equal(existsSync(path.join(evidenceRoot, "stream.jsonl")), true, "abnormal stream evidence is published");
    assert.equal(
      existsSync(path.join(evidenceRoot, "request-trace.json")),
      true,
      "abnormal settlement publishes the correlation trace",
    );
    assert.notEqual(firstDispatchId, boundDispatchId, "independent runtime reports must not share an artifact key");
    assert.equal(sameNamedReportPaths.every(existsSync), true, "each runtime report must remain materialized");
    assert.equal(
      sameNamedReportArchives.every(
        (archive, index) =>
          archive.dispatchId === sameNamedReportDispatches[index] &&
          archive.taskId === taskId &&
          archive.executionId === executionId,
      ),
      true,
      "each dispatch-scoped report must retain its own Task execution owner",
    );
    assert.notEqual(
      readFileSync(sameNamedReportPaths[0]!, "utf8"),
      readFileSync(sameNamedReportPaths[1]!, "utf8"),
      "separate report bodies must not overwrite one another",
    );
    assert.equal(
      await readPublishedDispatch(path.join(artifactRoot, "reports", `${boundDispatchId}.md`)),
      `final:${assembledPrompt}`,
    );
    assert.deepEqual(boundDispatch, {
      schema: "runtime-dispatch/v1",
      dispatchId: boundDispatchId,
      taskId,
      executionId,
      agentId: "terra",
      agentName: "Terra",
      delegatedByAgentId: "fable",
      delegatedByAgentName: "Fable",
      squadId: "core-squad",
      instanceId: "cli-worker",
      model: "runtime-test-model",
      reasoningEffort: null,
      fast: false,
      cwd: realpathSync(root),
      missionRef: `${packagePath.replace(/^harness\//u, "")}/artifacts/missions/${boundDispatchId}.md`,
      runtimeSessionId: bound.runtimeSessionId,
      providerSessionId: "provider-cli-session",
      startedAt: boundDispatch.startedAt,
      endedAt: boundDispatch.endedAt,
      outcome: "stopped",
      exitCode: 0,
      lastConclusion: `final:${assembledPrompt}`.trim().slice(0, 8_192),
      exitHead: null,
      resultRef: (bound.result as Record<string, unknown>).ref,
      eventStreamRef: `file:.harness/runtime/dispatches/${boundDispatchId}.jsonl`,
      // A task-bound worker that exits stopped is an abnormal terminal in this task's contract, so
      // settlement publishes the redacted stream and correlation trace beside the dispatch record.
      forensicsRef: {
        stream: `${packagePath.replace(/^harness\//u, "")}/artifacts/dispatches/${boundDispatchId}/stream.jsonl`,
        requestTrace: `${packagePath.replace(/^harness\//u, "")}/artifacts/dispatches/${boundDispatchId}/request-trace.json`,
      },
      attemptGroupId: boundDispatchId,
      attemptIndex: 0,
      provider: { instance: "cli-worker", model: "runtime-test-model" },
      classification: "worker_stop",
      reason: "Worker stopped after a normal exit without a submitted delivery.",
    });
    assert.match(String(boundDispatch.startedAt), /^\d{4}-\d{2}-\d{2}T/u);
    assert.match(String(boundDispatch.endedAt), /^\d{4}-\d{2}-\d{2}T/u);
    assert.doesNotMatch(JSON.stringify(boundDispatch), /(?:OPENAI_API_KEY|sk-runtime-secret-1234567890)/u);
    assert.ok(readDispatchRecords(root, boundDispatchId).length > 0);
    run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
    const dispatchRow = (runStopped(["task", "dispatches", taskId]).dispatches as Array<Record<string, unknown>>).find(
      (row) => row.dispatchId === boundDispatchId,
    );
    assert.deepEqual(
      dispatchRow && {
        agentId: dispatchRow.agentId,
        delegatedByAgentId: dispatchRow.delegatedByAgentId,
        squadId: dispatchRow.squadId,
      },
      { agentId: "terra", delegatedByAgentId: "fable", squadId: "core-squad" },
    );
    const outsider = runMaybe(root, env, [
      "agent",
      "run",
      "fable",
      "--to",
      "outsider",
      "--prompt",
      "reject outsider",
      "--cwd",
      ".",
      "--task",
      taskId,
      ...recoverLatest(root, env, taskId),
      "--no-stream",
    ]);
    assert.equal(outsider.status, 1);
    assert.equal(outsider.receipt.code, "squad_member_not_found");
    // An explicit instance pin must still serve the target Agent's declaration; a foreign
    // runtime kind cannot be borrowed by naming the instance directly.
    run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
    const crossKind = runMaybe(root, env, [
      "agent",
      "run",
      "fable",
      "--to",
      "opencode-worker",
      "--instance",
      "cli-worker",
      "--prompt",
      "cross-kind dispatch",
      "--cwd",
      ".",
      "--task",
      taskId,
      ...recoverLatest(root, env, taskId),
      "--no-stream",
    ]);
    assert.equal(crossKind.status, 1, JSON.stringify(crossKind));
    assert.equal(crossKind.receipt.code, "agent_runtime_unavailable", JSON.stringify(crossKind));
  },
);
