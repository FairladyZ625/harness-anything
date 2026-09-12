// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { run, runMaybe } from "./runtime-cli.commands.fixture.ts";
import { readPublishedDispatch, assertTaskMissionPrompt } from "./runtime-cli.observations.fixture.ts";
import { createRuntimeFixture, seedTask, installIdentities } from "./runtime-cli.setup.fixture.ts";

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
  const assembledPrompt = readFileSync(path.join(artifactRoot, "missions", `${boundDispatchId}.md`), "utf8");
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
    mission: "bound prompt",
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
    readFileSync(path.join(artifactRoot, "reports", `${boundDispatchId}.md`), "utf8"),
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
