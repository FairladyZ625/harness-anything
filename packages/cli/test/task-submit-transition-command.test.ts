// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { decodeTaskSubmitTransitionCommand } from "@harness-anything/application";
import { parseArgs } from "../src/cli/parse-args.ts";
import { taskSubmitTransitionCommandFromCliAction } from "../src/cli/task-submit-transition-command.ts";
import { cliDaemonCommandHostServices } from "../src/composition/daemon-command-host-services.ts";

const packet = {
  completionClaim: "The typed submission is ready for review.",
  deliverables: ["typed task-submit"],
  outputs: ["integration passed"],
  verificationNotes: ["npm run check:local"],
  knownGaps: [],
  residualRisks: ["integration tier remains"]
};

test("CLI submit intent is field-equal after daemon host strict decoding", () => {
  const parsed = parseArgs([
    "task", "submit", "task_TYPED",
    "--json-input", JSON.stringify({ ...packet, executionId: "exe_TYPED", leaseToken: "lease_TYPED" })
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const constructed = taskSubmitTransitionCommandFromCliAction(parsed.value.action);
  const transported = JSON.parse(JSON.stringify(parsed.value)) as Record<string, unknown>;
  const decoded = cliDaemonCommandHostServices.parseCommandPayload({ command: transported });
  assert.deepEqual(decoded.action, constructed);
  assert.deepEqual(decoded.action, {
    kind: "task-submit",
    taskId: "task_TYPED",
    executionId: "exe_TYPED",
    leaseToken: "lease_TYPED",
    submission: packet,
    callerIdempotencyKey: constructed.callerIdempotencyKey,
    dryRun: false
  });
});

test("daemon host rejects unknown typed fields and the strict contract rejects missing fields", () => {
  const action = submitAction();
  assert.throws(
    () => cliDaemonCommandHostServices.parseCommandPayload({
      command: { rootDir: "/repo", json: true, action: { ...action, silentlyDropped: true } }
    }),
    /TASK_SUBMIT_TRANSITION_COMMAND_INVALID:\$\.action\.silentlyDropped:no unknown fields/u
  );
  const { callerIdempotencyKey: _missing, ...withoutIdempotencyKey } = action;
  assert.throws(
    () => decodeTaskSubmitTransitionCommand(withoutIdempotencyKey),
    /TASK_SUBMIT_TRANSITION_COMMAND_INVALID:\$\.action\.callerIdempotencyKey:required field/u
  );
});

test("CLI derives the same load-bearing idempotency key for the same submit intent", () => {
  const first = parseArgs(["task", "submit", "task_RETRY", "--json-input", JSON.stringify(packet)]);
  const replay = parseArgs(["task", "submit", "task_RETRY", "--json-input", JSON.stringify(packet)]);
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (!first.ok || !replay.ok) return;
  const firstCommand = taskSubmitTransitionCommandFromCliAction(first.value.action);
  const replayCommand = taskSubmitTransitionCommandFromCliAction(replay.value.action);
  assert.match(firstCommand.callerIdempotencyKey, /^task-submit-[a-f0-9]{64}$/u);
  assert.equal(replayCommand.callerIdempotencyKey, firstCommand.callerIdempotencyKey);
});

function submitAction() {
  return {
    kind: "task-submit" as const,
    taskId: "task_STRICT",
    executionId: "exe_STRICT",
    leaseToken: null,
    submission: packet,
    callerIdempotencyKey: "caller-strict-key",
    dryRun: false
  };
}
