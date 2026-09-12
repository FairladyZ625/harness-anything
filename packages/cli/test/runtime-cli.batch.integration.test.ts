// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { run, runMaybe } from "./runtime-cli.commands.fixture.ts";
import { eventuallyFile } from "./runtime-cli.observations.fixture.ts";
import { createRuntimeFixture, seedTask, installIdentities } from "./runtime-cli.setup.fixture.ts";

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
