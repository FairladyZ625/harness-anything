// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { run } from "./runtime-cli.commands.fixture.ts";
import { readDispatchRecords, eventuallyRuntimeStatus, processAlive } from "./runtime-cli.observations.fixture.ts";
import { createRuntimeFixture } from "./runtime-cli.setup.fixture.ts";

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
