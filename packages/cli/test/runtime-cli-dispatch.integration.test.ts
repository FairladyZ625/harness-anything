// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeProviderExecutable } from "../../daemon/test/fixtures/runtime-stub.ts";
import { taskQueryGuidance } from "@harness-anything/daemon/internal/runtime-spawn-mission";
import { makeTaskEventReader } from "@harness-anything/kernel";
import { realizedTaskPlan as realizedPlan } from "../../../tools/fixtures/task-plan.mjs";
import {
  assertTaskMissionPrompt,
  cli,
  createRuntimeFixture,
  eventuallyFile,
  eventuallyNotification,
  installIdentities,
  published,
  readPublishedDispatch,
  run,
  runMaybe,
  runtimeInvariantEvidence,
  seedTask,
} from "./runtime-cli.fixtures.ts";

test("Delegated dispatches archive identity, mission and separate reports and reject invalid delegates", async (context) => {
  const fixture = createRuntimeFixture(context);
  const { parent, root, env, userRoot, daemonId } = fixture;
  installIdentities(parent, root, env);
  const { taskId, executionId, packagePath, artifactRoot } = seedTask(root, env, "archive");
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const first = run(root, env, ["agent", "run", "terra", "--prompt", "first report", "--task", taskId, "--no-stream"]);
  const firstDispatchId = String((first.spawn as Record<string, unknown>).dispatchId);
  await readPublishedDispatch(path.join(artifactRoot, "dispatches", `${firstDispatchId}.json`));
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const assembledPromptPrefix =
      "# Agent Identity: Terra (terra)\n\nReview precisely.\n\n# Harness Execution Discipline",
    bound = run(root, env, [
      "agent",
      "run",
      "fable",
      "--to",
      "terra",
      "--prompt",
      "bound prompt",
      "--task",
      taskId,
      "--no-stream",
    ]),
    boundSpawn = bound.spawn as Record<string, unknown>,
    boundDispatchId = String(boundSpawn.dispatchId),
    boundDispatch = JSON.parse(
      await readPublishedDispatch(path.join(artifactRoot, "dispatches", `${boundDispatchId}.json`)),
    ) as Record<string, unknown>;
  const assembledPrompt = await readPublishedDispatch(path.join(artifactRoot, "missions", `${boundDispatchId}.md`));
  assert.ok(assembledPrompt.startsWith(assembledPromptPrefix), assembledPrompt);
  assert.match(assembledPrompt, /# Worker Role/u);
  assertTaskMissionPrompt(assembledPrompt, {
    repoId: "runtime-cli",
    taskId,
    canonicalRoot: realpathSync(root),
    workerRoot: realpathSync(root),
    taskPackageRoot: path.join(realpathSync(root), "harness", packagePath),
    daemonUserRoot: userRoot,
    daemonId,
    runtimeSessionId: String(bound.runtimeSessionId),
    mission: `${taskQueryGuidance(taskId)}\n\nbound prompt`,
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
    missionRef: `${packagePath}/artifacts/missions/${boundDispatchId}.md`,
    runtimeSessionId: bound.runtimeSessionId,
    providerSessionId: "provider-cli-session",
    startedAt: boundDispatch.startedAt,
    endedAt: boundDispatch.endedAt,
    outcome: "succeeded",
    exitCode: 0,
    resultRef: (bound.result as Record<string, unknown>).ref,
    eventStreamRef: `file:.harness/runtime/dispatches/${boundDispatchId}.jsonl`,
    attemptGroupId: boundDispatchId,
    attemptIndex: 0,
    provider: { instance: "cli-worker", model: "runtime-test-model" },
    classification: "worker_stop",
    reason: "Worker completed the attempt successfully.",
  });
  assert.match(String(boundDispatch.startedAt), /^\d{4}-\d{2}-\d{2}T/u);
  assert.match(String(boundDispatch.endedAt), /^\d{4}-\d{2}-\d{2}T/u);
  assert.doesNotMatch(JSON.stringify(boundDispatch), /(?:api.?key|credential|environment|token)/iu);
  assert.equal(existsSync(path.join(root, ".harness", "runtime", "dispatches", `${boundDispatchId}.jsonl`)), true);
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const dispatchRow = (
    run(root, env, ["task", "dispatches", taskId]).dispatches as Array<Record<string, unknown>>
  ).find((row) => row.dispatchId === boundDispatchId);
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
    "--task",
    taskId,
    "--no-stream",
  ]);
  assert.equal(outsider.status, 1);
  assert.equal(outsider.receipt.code, "squad_member_not_found");
  const mismatch = runMaybe(root, env, [
    "agent",
    "run",
    "fable",
    "--to",
    "opencode-worker",
    "--instance",
    "cli-worker",
    "--prompt",
    "reject mismatch",
    "--task",
    taskId,
    "--no-stream",
  ]);
  assert.equal(mismatch.status, 1);
  assert.equal(mismatch.receipt.code, "agent_runtime_type_mismatch");
});

test("Runtime report is archived after the worker submits its execution", async (context) => {
  const fixture = createRuntimeFixture(context);
  installIdentities(fixture.parent, fixture.root, fixture.env);
  const { root, env } = fixture;
  const taskId = "task-runtime-archive",
    executionId = "exec-runtime-archive";
  const submittedTaskId = `${taskId}-submitted`,
    submittedExecutionId = `${executionId}-submitted`,
    submittedTask = run(root, env, [
      "task",
      "create",
      "--id",
      submittedTaskId,
      "--admin",
      "--title",
      "Submitted runtime archive",
    ]),
    submittedPackagePath = String(submittedTask.packagePath),
    submittedPlanPath = `${submittedPackagePath}/task_plan.md`;
  published(root, env, submittedTask);
  writeFileSync(path.join(root, "harness", submittedPlanPath), realizedPlan("Submitted runtime archive"));
  run(root, env, ["doc", "sync", "--submit", "--path", submittedPlanPath]);
  const started = run(root, env, ["task", "start", submittedTaskId, "--execution-id", submittedExecutionId]);
  // The delivery commits below write repo Git directly, so the daemon must finish publishing the
  // cuts of the writes above first; otherwise the two HEAD writers race and git dies with
  // `cannot lock ref 'HEAD'`.
  published(root, env, started);
  // This standard task submits a public code cut bound to the runtime cwd.
  const deliveryGit = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  deliveryGit(["init", "-b", "main"]);
  deliveryGit(["config", "user.name", "Harness Test"]);
  deliveryGit(["config", "user.email", "harness@example.test"]);
  writeFileSync(path.join(root, "README.md"), "Runtime archive baseline.\n");
  deliveryGit(["add", "README.md"]);
  deliveryGit(["commit", "-m", "test: seed runtime delivery baseline"]);
  deliveryGit(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  writeFileSync(path.join(root, "README.md"), "Runtime archive delivery.\n");
  deliveryGit(["add", "README.md"]);
  deliveryGit(["commit", "-m", "test: record runtime delivery"]);
  const submittedCut = { commitSha: deliveryGit(["rev-parse", "HEAD"]) };
  const submittedRuntime = run(root, env, [
      "agent",
      "run",
      "terra",
      "--prompt",
      `submit-before-exit:${submittedTaskId}:${submittedCut.commitSha}`,
      "--task",
      submittedTaskId,
      "--no-stream",
    ]),
    submittedDispatchId = String((submittedRuntime.spawn as Record<string, unknown>).dispatchId),
    submittedReportPath = `${submittedPackagePath}/artifacts/reports/${submittedDispatchId}.md`;
  // The report is archived by a doc-sync publication after the runtime settles, and the dispatch
  // read derives reportPath from the archived file, so the row is read only after the file exists.
  await eventuallyFile(path.join(root, "harness", submittedReportPath));
  assert.equal(existsSync(path.join(root, "harness", submittedReportPath)), true);
  const submittedDispatch = (
    run(root, env, ["task", "dispatches", submittedTaskId]).dispatches as Array<Record<string, unknown>>
  ).find((row) => row.dispatchId === submittedDispatchId);
  assert.equal(submittedDispatch?.reportPath, submittedReportPath);
});

test("Task-bound batch enforces one lease holder and archives successful dispatches", async (context) => {
  const fixture = createRuntimeFixture(context);
  const { parent, root, env } = fixture;
  installIdentities(parent, root, env);
  const { taskId, executionId, packagePath, artifactRoot } = seedTask(root, env, "batch");
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  mkdirSync(path.join(artifactRoot, "missions"), { recursive: true });
  writeFileSync(path.join(artifactRoot, "missions", "existing-mission.md"), "existing mission");
  run(root, env, ["doc", "sync", "--submit", "--path", `${packagePath}/artifacts/missions/existing-mission.md`]);
  const tracker = path.join(root, ".batch-tracker");
  writeFileSync(
    path.join(root, "batch.json"),
    JSON.stringify(
      {
        schema: "runtime-batch/v1",
        maxConcurrency: 2,
        dispatches: [
          { instance: "cli-worker", agent: "fable", to: "missing-agent", prompt: "must reject" },
          {
            instance: "cli-worker",
            agent: "fable",
            to: "terra",
            model: "runtime-test-model",
            effort: "high",
            fast: true,
            prompt: "batch hold one",
            task: taskId,
          },
          {
            instance: "cli-worker",
            agent: "fable",
            to: "terra",
            effort: "high",
            fast: true,
            prompt: "batch hold two",
            cwd: ".",
            task: taskId,
          },
          {
            instance: "cli-worker",
            agent: "fable",
            to: "terra",
            effort: "high",
            fast: true,
            mission: "existing-mission",
            task: taskId,
          },
          {
            instance: "cli-worker",
            agent: "fable",
            to: "terra",
            effort: "high",
            fast: true,
            prompt: "batch hold three",
            task: taskId,
          },
        ],
      },
      null,
      2,
    ),
  );
  const batch = runMaybe(root, env, ["runtime", "batch", "batch.json"]);
  assert.equal(batch.status, 1, `${batch.stderr}\n${JSON.stringify(batch.receipt)}`);
  assert.equal(batch.receipt.command, "runtime-batch");
  assert.equal(batch.receipt.outcome, "partial_failure");
  const batchRows = batch.receipt.dispatches as Array<Record<string, unknown>>;
  assert.equal(batchRows.length, 5);
  const taskBatchRows = batchRows.slice(1),
    successfulBatchRows = taskBatchRows.filter((row) => row.status === "succeeded"),
    rejectedTaskBatchRows = taskBatchRows.filter((row) => row.status === "rejected");
  assert.ok(successfulBatchRows.length >= 1, JSON.stringify(batch.receipt));
  assert.equal(
    successfulBatchRows.length + rejectedTaskBatchRows.length,
    taskBatchRows.length,
    JSON.stringify(batch.receipt),
  );
  assert.equal(
    rejectedTaskBatchRows.every((row) => row.code === "runtime_task_lease_required"),
    true,
    JSON.stringify(batch.receipt),
  );
  assert.equal(batchRows[0]?.code, "squad_member_not_found");
  assert.equal(
    successfulBatchRows.every((row) => typeof row.dispatchId === "string" && typeof row.runtimeSessionId === "string"),
    true,
  );
  const batchDispatchIds = new Set(successfulBatchRows.map((row) => String(row.dispatchId))),
    batchDispatches = (
      run(root, env, ["task", "dispatches", taskId]).dispatches as Array<Record<string, unknown>>
    ).filter((row) => batchDispatchIds.has(String(row.dispatchId)));
  assert.equal(batchDispatches.length, successfulBatchRows.length);
  assert.equal(
    batchDispatches.every(
      (row) => row.agentId === "terra" && row.delegatedByAgentId === "fable" && row.squadId === "core-squad",
    ),
    true,
    JSON.stringify(batchDispatches),
  );
  const batchArchives = successfulBatchRows.map((row) =>
    path.join(artifactRoot, "dispatches", `${String(row.dispatchId)}.json`),
  );
  await Promise.all(batchArchives.map(eventuallyFile));
  assert.deepEqual(
    batchArchives.filter((archive) => !existsSync(archive)),
    [],
    "successful runtime batch dispatch archives must become visible",
  );
  const slowBatchArchive = batchArchives[0]!;
  assert.equal((JSON.parse(readFileSync(slowBatchArchive, "utf8")) as Record<string, unknown>).reasoningEffort, "high");
  assert.equal((JSON.parse(readFileSync(slowBatchArchive, "utf8")) as Record<string, unknown>).fast, true);
  const events = existsSync(tracker) ? readFileSync(tracker, "utf8").trim().split("\n").filter(Boolean) : [],
    trackedBatchDispatches = successfulBatchRows.filter((row) => row.index !== 3).length;
  let active = 0,
    peak = 0;
  for (const event of events) {
    active += event === "start" ? 1 : -1;
    peak = Math.max(peak, active);
  }
  assert.equal(events.filter((event) => event === "start").length, trackedBatchDispatches);
  assert.equal(events.filter((event) => event === "end").length, trackedBatchDispatches);
  assert.ok(peak <= 1, `task-bound batch exceeded its single lease holder: ${events.join(",")}`);
});

test("CLI discovers instances, runs direct prompts, resumes and streams with status retrieval", async (context) => {
  const fixture = createRuntimeFixture(context);
  const { root, env, version } = fixture;
  const { artifactRoot } = seedTask(root, env, "direct");
  const inventory = run(root, env, ["runtime", "instance", "list"]),
    installation = (inventory.installations as Array<Record<string, unknown>>).find(
      (row) => row.kindId === "codex" && row.version === `codex ${version}`,
    );
  assert.ok(installation, JSON.stringify(inventory));
  const missingInstance = runMaybe(root, env, [
    "runtime",
    "run",
    "missing-instance",
    "--prompt",
    "must reject",
    "--detach",
  ]);
  assert.equal(missingInstance.status, 1);
  assert.equal(missingInstance.receipt.code, "runtime_instance_not_found");
  assert.equal(missingInstance.receipt.dispatchId, undefined);
  const directPrompt = run(root, env, ["runtime", "run", "cli-worker", "--prompt", "file prompt", "--no-stream"]);
  assert.equal((directPrompt.result as Record<string, unknown>).text, "final:file prompt");
  for (const directory of ["missions", "dispatches", "reports"])
    assert.equal(existsSync(path.join(artifactRoot, directory)), false, `${directory} must not exist without --task`);
  const resumed = run(root, env, [
    "runtime",
    "run",
    "cli-worker",
    "--prompt",
    "second turn",
    "--resume",
    "provider-cli-session",
    "--no-stream",
  ]);
  assert.equal((resumed.result as Record<string, unknown>).text, "resumed:provider-cli-session:second turn");
  assert.equal((resumed.session as Record<string, unknown>).providerSessionId, "provider-cli-session");
  const streamed = spawnSync(
    process.execPath,
    [cli, "--root", root, "runtime", "run", "cli-worker", "--prompt", "stream prompt"],
    { encoding: "utf8", env },
  );
  assert.equal(streamed.status, 0, streamed.stderr);
  assert.equal(streamed.stdout.trim(), "final:stream prompt");
  const listed = run(root, env, ["runtime", "status"]),
    sessions = listed.sessions as Array<Record<string, unknown>>;
  assert.equal(sessions.length, 3);
  assert.match(streamed.stderr, /\[message\] live:stream prompt/u, JSON.stringify(sessions));
  const detail = run(root, env, ["runtime", "status", String(resumed.runtimeSessionId)]);
  assert.equal((detail.result as Record<string, unknown>).text, "resumed:provider-cli-session:second turn");
  const waited = run(root, env, ["runtime", "status", String(resumed.runtimeSessionId), "--wait", "--no-stream"]);
  assert.equal(waited.command, "runtime-status");
  assert.equal(waited.summary, "resumed:provider-cli-session:second turn");
});

test("Provider failures preserve reasons, redact secrets and publish failed task archives", async (context) => {
  const fixture = createRuntimeFixture(context);
  installIdentities(fixture.parent, fixture.root, fixture.env);
  const { root, env } = fixture;
  const { taskId, executionId, packagePath, artifactRoot } = seedTask(root, env, "failure");
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const emptyFailure = runMaybe(root, env, [
    "runtime",
    "run",
    "cli-worker",
    "--prompt",
    "failure:empty",
    "--no-stream",
  ]);
  assert.equal(emptyFailure.status, 1);
  assert.equal(emptyFailure.receipt.code, "provider_exit");
  assert.equal(emptyFailure.receipt.reason, "Provider exited with code 1 and produced no output.");
  assert.equal(emptyFailure.receipt.summary, emptyFailure.receipt.reason);
  const secret = "sk-runtime-secret-1234567890",
    secretFailure = runMaybe(root, env, ["runtime", "run", "cli-worker", "--prompt", "failure:secret", "--no-stream"]);
  assert.equal(secretFailure.status, 1);
  assert.match(String(secretFailure.receipt.reason), /Provider exited with code 1.*OPENAI_API_KEY=\[REDACTED\]/u);
  assert.doesNotMatch(JSON.stringify(secretFailure.receipt), new RegExp(secret, "u"));
  assert.doesNotMatch(
    readFileSync(path.join(root, ".harness", "requests", "requests.jsonl"), "utf8"),
    new RegExp(secret, "u"),
  );
  const structuredFailure = runMaybe(root, env, [
    "runtime",
    "run",
    "cli-worker",
    "--prompt",
    "failure:structured",
    "--no-stream",
  ]);
  assert.equal(structuredFailure.status, 1);
  assert.match(String(structuredFailure.receipt.reason), /structured provider failure/u);
  assert.doesNotMatch(JSON.stringify(structuredFailure.receipt), new RegExp(secret, "u"));
  const quotaFailure = runMaybe(root, env, ["runtime", "run", "cli-worker", "--prompt", "failure:429", "--no-stream"]);
  assert.equal(quotaFailure.status, 1);
  assert.equal(quotaFailure.receipt.code, "quota_exhausted");
  assert.match(
    String(quotaFailure.receipt.reason),
    /faultClass=quota_exhausted; resetAt=2026-09-06T05:06:07\.000Z;.*credit balance exhausted/u,
  );
  const quotaAttempt = (
    (quotaFailure.receipt.session as Record<string, unknown>).attemptChain as {
      attempts: Array<Record<string, unknown>>;
    }
  ).attempts[0]!;
  assert.equal(quotaAttempt.classification, "provider_quota");
  assert.equal(quotaAttempt.resetAt, "2026-09-06T05:06:07.000Z");
  assert.match(String(quotaAttempt.nextAction), /ha runtime run --resume-dispatch/u);
  writeFileSync(
    path.join(root, "failure-batch.json"),
    JSON.stringify({
      schema: "runtime-batch/v1",
      maxConcurrency: 1,
      dispatches: [{ instance: "cli-worker", prompt: "failure:empty" }],
    }),
  );
  const failureBatch = runMaybe(root, env, ["runtime", "batch", "failure-batch.json"]);
  assert.equal(failureBatch.status, 1);
  const failureRow = (failureBatch.receipt.dispatches as Array<Record<string, unknown>>)[0]!;
  assert.equal(failureRow.code, "provider_exit");
  assert.equal(failureRow.reason, "Provider exited with code 1 and produced no output.");
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const detachedFailure = run(root, env, [
    "agent",
    "run",
    "terra",
    "--prompt",
    "failure:429",
    "--task",
    taskId,
    "--detach",
  ]);
  const failureWait = runMaybe(root, env, ["runtime", "status", "--task", taskId, "--wait", "--no-stream"]);
  assert.equal(detachedFailure.outcome, "running");
  assert.equal(failureWait.status, 1, `${failureWait.stderr}\n${JSON.stringify(failureWait.receipt)}`);
  assert.equal(failureWait.receipt.outcome, "failed");
  const failedRow = (failureWait.receipt.dispatches as Array<Record<string, unknown>>).find(
    (row) => row.dispatchId === detachedFailure.dispatchId,
  );
  assert.equal(failedRow?.status, "failed");
  assert.equal(failedRow?.classification, "provider_quota");
  assert.equal(failedRow?.resetAt, "2026-09-06T05:06:07.000Z");
  assert.equal(failedRow?.nextAction, `ha agent run terra --resume-dispatch ${String(detachedFailure.dispatchId)}`);
  assert.equal(failedRow?.exitCode, 1);
  assert.equal(failedRow?.dispatchPath, `${packagePath}/artifacts/dispatches/${detachedFailure.dispatchId}.json`);
  await eventuallyFile(path.join(artifactRoot, "reports", `${detachedFailure.dispatchId}.md`));
  const publishedFailureRow = (
    runMaybe(root, env, ["task", "dispatches", taskId]).receipt.dispatches as Array<Record<string, unknown>>
  ).find((row) => row.dispatchId === detachedFailure.dispatchId);
  assert.equal(publishedFailureRow?.reportPath, `${packagePath}/artifacts/reports/${detachedFailure.dispatchId}.md`);
  const healthAfterRuntimeFailure = (run(root, env, ["daemon", "status"]).repos as Array<Record<string, unknown>>)[0]
    ?.materialization as Record<string, unknown>;
  assert.equal(healthAfterRuntimeFailure.state, "ok", JSON.stringify(healthAfterRuntimeFailure));
  context.diagnostic(
    `detach -> task wait failure: ${JSON.stringify({
      detached: detachedFailure,
      wait: failureWait.receipt,
      dispatch: failedRow,
      materialization: healthAfterRuntimeFailure,
    })}`,
  );
});

test("Named missions reject invalid inputs and task-derived missions carry dispatch preconditions", async (context) => {
  const fixture = createRuntimeFixture(context);
  const { parent, root, env, userRoot, daemonId } = fixture;
  installIdentities(parent, root, env);
  const { taskId, executionId, packagePath, artifactRoot } = seedTask(root, env, "mission");
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const existingMissionPath = `${packagePath}/artifacts/missions/existing-mission.md`;
  const pathLikeMission = runMaybe(root, env, [
    "agent",
    "run",
    "terra",
    "--mission",
    existingMissionPath,
    "--task",
    taskId,
    "--no-stream",
  ]);
  assert.equal(pathLikeMission.status, 1);
  assert.equal(pathLikeMission.receipt.code, "invalid_runtime_mission");
  assert.deepEqual(pathLikeMission.receipt.diagnostic, {
    kind: "validation",
    entity: "runtime mission",
    field: "mission",
    actual: "path-like value",
    expectation:
      "Expected a bare mission id; the daemon resolves harness/<task-package>/artifacts/missions/<name>.md " +
      "and did not look up this file. Retry ha agent run <agent-id> --task <task-id> --mission <name>",
  });
  context.diagnostic(`invalid_runtime_mission receipt=${JSON.stringify(pathLikeMission.receipt)}`);
  // The unavailable rejection is only deterministic while the file is absent: once it exists on
  // disk, the WAL materializer's authored-candidate settlement may auto-submit it after any
  // flush, racing both this rejection and a doc status that expects "eligible".
  const unsyncedMission = runMaybe(root, env, [
    "agent",
    "run",
    "terra",
    "--mission",
    "existing-mission",
    "--task",
    taskId,
    "--no-stream",
  ]);
  assert.equal(unsyncedMission.status, 1);
  assert.equal(unsyncedMission.receipt.code, "runtime_mission_unavailable");
  mkdirSync(path.join(artifactRoot, "missions"), { recursive: true });
  writeFileSync(path.join(root, "harness", existingMissionPath), "existing mission");
  // Manual sync stays the tested path; a concurrent authored-candidate settlement may have won
  // the write, which the receipt reports as no_changes — both outcomes leave the doc clean.
  const missionSync = run(root, env, ["doc", "sync", "--submit", "--path", existingMissionPath]);
  assert.match(String(run(root, env, ["doc", "status", "--path", existingMissionPath]).evidence), /"state":"clean"/u);
  const promptFile = runMaybe(root, env, [
    "agent",
    "run",
    "terra",
    "--prompt-file",
    path.join("harness", packagePath, "artifacts", "missions", "existing-mission.md"),
    "--task",
    taskId,
    "--no-stream",
  ]);
  assert.equal(promptFile.status, 0, JSON.stringify(promptFile));
  assert.ok(
    String((promptFile.receipt.result as Record<string, unknown>).text).endsWith(
      `# Assigned Mission\n${taskQueryGuidance(taskId)}\n\nexisting mission`,
    ),
  );
  const promptFileDispatchId = String((promptFile.receipt.spawn as Record<string, unknown>).dispatchId);
  const reused = run(root, env, [
      "agent",
      "run",
      "terra",
      "--mission",
      "existing-mission",
      "--task",
      taskId,
      "--no-stream",
    ]),
    reusedDispatchId = String((reused.spawn as Record<string, unknown>).dispatchId),
    reusedDispatch = JSON.parse(
      await readPublishedDispatch(path.join(artifactRoot, "dispatches", `${reusedDispatchId}.json`)),
    ) as Record<string, unknown>;
  // The mission and report publish after the dispatch record, so they are awaited the same way.
  const reusedMission = await readPublishedDispatch(path.join(artifactRoot, "missions", `${reusedDispatchId}.md`)),
    reusedReport = await readPublishedDispatch(path.join(artifactRoot, "reports", `${reusedDispatchId}.md`));
  context.diagnostic(
    `hand-written mission route: ${JSON.stringify({
      before: {
        outcome: unsyncedMission.receipt.outcome,
        code: unsyncedMission.receipt.code,
        diagnostic: unsyncedMission.receipt.diagnostic,
      },
      sync: { outcome: missionSync.outcome, summary: missionSync.summary },
      after: { outcome: reused.outcome, dispatchId: reusedDispatchId },
    })}`,
  );
  assert.equal(reusedDispatch.missionRef, `${packagePath}/artifacts/missions/${reusedDispatchId}.md`);
  assert.deepEqual(
    readdirSync(path.join(artifactRoot, "missions")).sort(),
    ["existing-mission.md", `${promptFileDispatchId}.md`, `${reusedDispatchId}.md`].sort(),
  );
  assert.equal(reusedReport, `final:${reusedMission}`);
  assertTaskMissionPrompt(reusedMission, {
    repoId: "runtime-cli",
    taskId,
    canonicalRoot: realpathSync(root),
    workerRoot: realpathSync(root),
    taskPackageRoot: path.join(realpathSync(root), "harness", packagePath),
    daemonUserRoot: userRoot,
    daemonId,
    runtimeSessionId: String(reused.runtimeSessionId),
    mission:
      `Your task package is ${path.join(realpathSync(root), "harness", packagePath)}.\n` +
      "Read task_plan.md in that package and complete the task.\n\n" +
      `${taskQueryGuidance(taskId)}\n\n` +
      "# Mission: existing-mission\n\nexisting mission",
  });
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const taskPackage = path.join(realpathSync(root), "harness", packagePath),
    derivedMission =
      `Your task package is ${taskPackage}.\n` +
      `Read task_plan.md in that package and complete the task.\n\n` +
      taskQueryGuidance(taskId),
    derived = run(root, env, ["agent", "run", "terra", "--task", taskId, "--cwd", ".", "--no-stream"]),
    derivedText = String((derived.result as Record<string, unknown>).text);
  assert.match(
    derivedText,
    /^final:# Agent Identity: Terra \(terra\).*# Harness Execution Discipline.*# Worker Role/su,
  );
  assertTaskMissionPrompt(derivedText.slice("final:".length), {
    repoId: "runtime-cli",
    taskId,
    canonicalRoot: realpathSync(root),
    workerRoot: realpathSync(root),
    taskPackageRoot: taskPackage,
    daemonUserRoot: userRoot,
    daemonId,
    runtimeSessionId: String(derived.runtimeSessionId),
    mission: derivedMission,
  });
  assert.equal(derivedText.includes("Review precisely."), true);
});

test("Missing and nonzero callbacks preserve runtime outcome and redact callback environment", async (context) => {
  const fixture = createRuntimeFixture(context);
  installIdentities(fixture.parent, fixture.root, fixture.env);
  const { parent, root, env } = fixture;
  const { taskId, executionId, artifactRoot } = seedTask(root, env, "notification-failure");
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const nonzeroTrace = path.join(root, ".notify-nonzero.json");
  const nonzeroNotifier = writeProviderExecutable(
    path.join(parent, "notify-nonzero"),
    `const fs = require("node:fs"), payload = JSON.parse(fs.readFileSync(0, "utf8")); fs.writeFileSync(".notify-nonzero.json", JSON.stringify({ cwd: process.cwd(), environment: process.env, payload })); process.exit(23);\n`,
  );
  const invalidOnExit = runMaybe(root, env, [
    "runtime",
    "run",
    "cli-worker",
    "--prompt",
    "invalid callback",
    "--on-exit",
    nonzeroNotifier,
  ]);
  assert.equal(invalidOnExit.status, 2);
  assert.equal(invalidOnExit.receipt.code, "invalid_field");
  assert.equal((invalidOnExit.receipt.diagnostic as Record<string, unknown>).kind, "validation");
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const controlNotification = run(root, env, [
      "agent",
      "run",
      "terra",
      "--prompt",
      "notification control",
      "--task",
      taskId,
      "--detach",
    ]),
    controlNotificationWait = run(root, env, [
      "runtime",
      "status",
      String(controlNotification.runtimeSessionId),
      "--wait",
      "--no-stream",
    ]),
    controlInvariant = await runtimeInvariantEvidence(root, artifactRoot, controlNotification, controlNotificationWait);
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const missingNotifier = path.join(parent, "missing-notifier"),
    missingNotification = run(root, env, [
      "agent",
      "run",
      "terra",
      "--prompt",
      "notification missing",
      "--task",
      taskId,
      "--detach",
      "--on-exit",
      missingNotifier,
    ]),
    missingNotificationWait = run(root, env, [
      "runtime",
      "status",
      String(missingNotification.runtimeSessionId),
      "--wait",
      "--no-stream",
    ]),
    missingTrace = await eventuallyNotification(root, String(missingNotification.dispatchId)),
    missingInvariant = await runtimeInvariantEvidence(root, artifactRoot, missingNotification, missingNotificationWait);
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const nonzeroNotification = run(root, env, [
      "agent",
      "run",
      "terra",
      "--prompt",
      "notification nonzero",
      "--task",
      taskId,
      "--detach",
      "--on-exit",
      nonzeroNotifier,
    ]),
    nonzeroNotificationWait = run(root, env, [
      "runtime",
      "status",
      String(nonzeroNotification.runtimeSessionId),
      "--wait",
      "--no-stream",
    ]),
    nonzeroNotificationTrace = await eventuallyNotification(root, String(nonzeroNotification.dispatchId)),
    nonzeroInvariant = await runtimeInvariantEvidence(root, artifactRoot, nonzeroNotification, nonzeroNotificationWait),
    callbackObservation = JSON.parse(readFileSync(nonzeroTrace, "utf8")) as Record<string, unknown>,
    callbackEnvironment = callbackObservation.environment as Record<string, unknown>,
    callbackPayload = callbackObservation.payload as Record<string, unknown>;
  assert.deepEqual(missingInvariant, controlInvariant);
  assert.deepEqual(nonzeroInvariant, controlInvariant);
  assert.deepEqual(
    missingTrace.finished && {
      started: missingTrace.finished.started,
      exitCode: missingTrace.finished.exitCode,
      timedOut: missingTrace.finished.timedOut,
      errorCode: missingTrace.finished.errorCode,
    },
    { started: false, exitCode: null, timedOut: false, errorCode: "ENOENT" },
  );
  assert.deepEqual(
    nonzeroNotificationTrace.finished && {
      started: nonzeroNotificationTrace.finished.started,
      exitCode: nonzeroNotificationTrace.finished.exitCode,
      timedOut: nonzeroNotificationTrace.finished.timedOut,
    },
    { started: true, exitCode: 23, timedOut: false },
  );
  assert.equal(callbackObservation.cwd, realpathSync(root));
  assert.equal(callbackEnvironment.OPENAI_API_KEY, undefined);
  assert.equal(callbackEnvironment.HARNESS_NOTIFY_TEST_SECRET, undefined);
  assert.deepEqual(callbackPayload, {
    schema: "runtime-session-exited/v1",
    runtimeSessionId: nonzeroNotification.runtimeSessionId,
    outcome: "succeeded",
    exitCode: 0,
  });
  assert.doesNotMatch(JSON.stringify(callbackPayload), /notification nonzero|final:|credential|token|api.?key/iu);
  const missingArchive = JSON.parse(
      await readPublishedDispatch(
        path.join(artifactRoot, "dispatches", `${String(missingNotification.dispatchId)}.json`),
      ),
    ) as Record<string, unknown>,
    nonzeroArchive = JSON.parse(
      await readPublishedDispatch(
        path.join(artifactRoot, "dispatches", `${String(nonzeroNotification.dispatchId)}.json`),
      ),
    ) as Record<string, unknown>;
  assert.equal(missingArchive.onExitCommand, missingNotifier);
  assert.equal(nonzeroArchive.onExitCommand, nonzeroNotifier);
  context.diagnostic(
    `failed notification trace: ${JSON.stringify({ missing: missingTrace.finished, nonzero: nonzeroNotificationTrace.finished, invariant: nonzeroInvariant })}`,
  );
});

test("Repository writes commit while an exit callback is still running", async (context) => {
  const fixture = createRuntimeFixture(context);
  installIdentities(fixture.parent, fixture.root, fixture.env);
  const { parent, root, env } = fixture;
  const { taskId, executionId } = seedTask(root, env, "notification-queue");
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const notificationStarted = path.join(root, ".notify-hold-started"),
    notificationRelease = path.join(root, ".notify-hold-release"),
    notificationFinished = path.join(root, ".notify-hold-finished");
  const holdNotifier = writeProviderExecutable(
    path.join(parent, "notify-hold"),
    'const fs = require("node:fs"); fs.readFileSync(0, "utf8"); ' +
      'const watcher = fs.watch(".", (_, filename) => { if (filename !== ".notify-hold-release") return; ' +
      'watcher.close(); fs.writeFileSync(".notify-hold-finished", "finished\\n"); }); ' +
      'fs.writeFileSync(".notify-hold-started", "started\\n");\n',
  );
  const queueNotification = run(root, env, [
    "agent",
    "run",
    "terra",
    "--prompt",
    "notification queue hold",
    "--task",
    taskId,
    "--detach",
    "--on-exit",
    holdNotifier,
  ]);
  run(root, env, ["runtime", "status", String(queueNotification.runtimeSessionId), "--wait", "--no-stream"]);
  await eventuallyFile(notificationStarted);
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const revisionBefore = makeTaskEventReader({ repoId: "runtime-cli", rootDir: root }).readHead()?.revision ?? 0,
    queueWrite = run(root, env, [
      "task",
      "progress",
      "append",
      taskId,
      "--text",
      "Notification queue remained writable.",
      "--evidence",
      "test:reports/notification-queue.txt:write progressed while callback was active",
    ]),
    revisionAfter = makeTaskEventReader({ repoId: "runtime-cli", rootDir: root }).readHead()?.revision ?? 0;
  assert.ok(revisionAfter > revisionBefore, `${revisionBefore} -> ${revisionAfter}`);
  assert.equal(
    existsSync(notificationFinished),
    false,
    "the notification must still be executing when the repo write commits",
  );
  writeFileSync(notificationRelease, "release\n");
  const queueNotificationTrace = await eventuallyNotification(root, String(queueNotification.dispatchId));
  assert.equal(queueNotificationTrace.started?.phase, "started");
  assert.equal(queueNotificationTrace.finished?.timedOut, false);
  assert.equal(existsSync(notificationFinished), true);
  context.diagnostic(
    `notification queue concurrency: ${JSON.stringify({ revisionBefore, revisionAfter, writeReceiptRevision: queueWrite.revision, notifierStillRunningAtCommit: true })}`,
  );
});
