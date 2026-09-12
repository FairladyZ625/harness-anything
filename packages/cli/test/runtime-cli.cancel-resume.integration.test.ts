// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeProviderExecutable } from "../../daemon/test/fixtures/runtime-stub.ts";
import { run, runMaybe } from "./runtime-cli.commands.fixture.ts";
import {
  readDispatchRecords,
  eventuallyNotification,
  readPublishedDispatch,
  eventuallyFile,
  eventually,
  assertTaskMissionPrompt,
} from "./runtime-cli.observations.fixture.ts";
import { installIdentities, createRuntimeFixture, seedTask } from "./runtime-cli.setup.fixture.ts";

test("Cancellation is idempotent, notifies once and resumes the archived provider session", async (context) => {
  const fixture = createRuntimeFixture(context);
  installIdentities(fixture.parent, fixture.root, fixture.env);
  const { parent, root, env, userRoot, daemonId } = fixture;
  const { taskId, executionId, packagePath, artifactRoot } = seedTask(root, env, "cancel-resume");
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const notificationOnce = path.join(root, ".notify-once");
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
  const cancelled = await eventually(() => run(root, env, ["task", "dispatches", taskId])),
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
  const cancelledReport = readFileSync(path.join(artifactRoot, "reports", `${detachedDispatchId}.md`), "utf8");
  assertTaskMissionPrompt(cancelledReport.slice("live:".length), {
    repoId: "runtime-cli",
    taskId,
    canonicalRoot: realpathSync(root),
    workerRoot: realpathSync(root),
    taskPackageRoot: path.join(realpathSync(root), "harness", packagePath),
    daemonUserRoot: userRoot,
    daemonId,
    runtimeSessionId: detachedSessionId,
    mission: "hold",
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
  assert.equal(rejectedResume.receipt.code, "runtime_resume_failed");
  assert.deepEqual(readdirSync(streamRoot).sort(), streamsBeforeRejectedResume);
  assert.equal(
    (run(root, env, ["runtime", "status"]).sessions as Array<Record<string, unknown>>).length,
    sessionsBeforeRejectedResume,
  );
  const resumedDispatch = run(root, env, [
      "runtime",
      "run",
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
    workerRoot: realpathSync(root),
    taskPackageRoot: path.join(realpathSync(root), "harness", packagePath),
    daemonUserRoot: userRoot,
    daemonId,
    runtimeSessionId: String(resumedDispatch.runtimeSessionId),
    mission: "follow up",
  });
  const resumedRow = (run(root, env, ["task", "dispatches", taskId]).dispatches as Array<Record<string, unknown>>).find(
    (row) => row.dispatchId === resumedDispatchId,
  );
  assert.equal(resumedRow?.status, "succeeded");
  assert.equal(
    (
      JSON.parse(
        await readPublishedDispatch(path.join(artifactRoot, "dispatches", `${resumedDispatchId}.json`)),
      ) as Record<string, unknown>
    ).providerSessionId,
    "provider-cli-session",
  );
});
