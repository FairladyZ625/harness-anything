// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeProviderExecutable } from "../../daemon/test/fixtures/runtime-stub.ts";
import { run, runMaybe } from "./runtime-cli.commands.fixture.ts";
import {
  runtimeInvariantEvidence,
  eventuallyNotification,
  readPublishedDispatch,
} from "./runtime-cli.observations.fixture.ts";
import { createRuntimeFixture, seedTask } from "./runtime-cli.setup.fixture.ts";

test("Missing and nonzero callbacks preserve runtime outcome and redact callback environment", async (context) => {
  const fixture = createRuntimeFixture(context);
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
      "runtime",
      "run",
      "cli-worker",
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
      "runtime",
      "run",
      "cli-worker",
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
      "runtime",
      "run",
      "cli-worker",
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
