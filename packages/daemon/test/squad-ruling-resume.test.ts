// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { SquadRunProjectionRow } from "@harness-anything/kernel";
import { squadRulingResumeNext } from "../src/squad-ruling-resume.ts";

const SQUAD_RUN_ID = "squad_0123456789abcdef01234567",
  LEADER_DISPATCH_ID = "dispatch_000000000000000000000001",
  WORKER_DISPATCH_ID = "dispatch_000000000000000000000002";

function run(state: Readonly<Record<string, unknown>>): SquadRunProjectionRow {
  return { squadRunId: SQUAD_RUN_ID, revision: 1, state };
}

function taskRun(overrides: Readonly<Record<string, unknown>> = {}): SquadRunProjectionRow {
  return run({
    squadId: "debug-squad",
    squadRunId: SQUAD_RUN_ID,
    phase: "failed",
    subject: { kind: "task", taskId: "task-owner", executionId: "execution-owner" },
    leaderTurns: [{ dispatchId: LEADER_DISPATCH_ID, runtimeSessionId: "runtime-leader" }],
    workerAttempts: [{ dispatchId: WORKER_DISPATCH_ID, runtimeSessionId: "runtime-worker" }],
    ...overrides,
  });
}

test("a leader ruling names the new Squad run under the task the owner will restart", () => {
  const next = squadRulingResumeNext({
    runs: [taskRun()],
    dispatchId: LEADER_DISPATCH_ID,
    runtimeInstanceId: "instance-leader",
  });
  assert.equal(next?.command, "ha squad run debug-squad --instance instance-leader --task task-owner");
  assert.match(String(next?.reason), new RegExp(`restart Squad run ${SQUAD_RUN_ID}`, "u"));
});

test("a worker ruling and an unrelated dispatch keep the task-level next step alone", () => {
  for (const dispatchId of [WORKER_DISPATCH_ID, "dispatch_000000000000000000000003"])
    assert.equal(squadRulingResumeNext({ runs: [taskRun()], dispatchId, runtimeInstanceId: "instance" }), null);
});

test("a converged run or a schedule-occurrence run offers no task restart command", () => {
  assert.equal(
    squadRulingResumeNext({
      runs: [taskRun({ phase: "converged" })],
      dispatchId: LEADER_DISPATCH_ID,
      runtimeInstanceId: "instance",
    }),
    null,
  );
  assert.equal(
    squadRulingResumeNext({
      runs: [
        run({
          squadId: "debug-squad",
          squadRunId: SQUAD_RUN_ID,
          phase: "failed",
          subject: { kind: "schedule-occurrence", scheduleId: "schedule-nightly", occurrenceId: "occurrence-1" },
          leaderTurns: [{ dispatchId: LEADER_DISPATCH_ID, runtimeSessionId: "runtime-leader" }],
        }),
      ],
      dispatchId: LEADER_DISPATCH_ID,
      runtimeInstanceId: "instance",
    }),
    null,
  );
});

test("a missing dispatch instance leaves the placeholder rather than guessing one", () => {
  assert.equal(
    squadRulingResumeNext({ runs: [taskRun()], dispatchId: LEADER_DISPATCH_ID, runtimeInstanceId: null })?.command,
    "ha squad run debug-squad --instance <runtime-instance-id> --task task-owner",
  );
});
