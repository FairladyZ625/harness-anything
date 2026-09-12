// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { run, runMaybe, runAsync } from "./runtime-cli.commands.fixture.ts";
import { installIdentities, createRuntimeFixture, seedTask } from "./runtime-cli.setup.fixture.ts";

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
