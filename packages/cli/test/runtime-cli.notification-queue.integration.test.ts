// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import { writeProviderExecutable } from "../../daemon/test/fixtures/runtime-stub.ts";
import { run } from "./runtime-cli.commands.fixture.ts";
import { eventuallyNotification, eventuallyFile } from "./runtime-cli.observations.fixture.ts";
import { createRuntimeFixture, seedTask } from "./runtime-cli.setup.fixture.ts";

test("Repository writes commit while an exit callback is still running", async (context) => {
  const fixture = createRuntimeFixture(context);
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
    "runtime",
    "run",
    "cli-worker",
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
