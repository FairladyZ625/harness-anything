// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createScheduleV1, type ScheduleV1 } from "@harness-anything/kernel";
import { executeBuiltinScheduleOccurrence } from "../src/schedule-builtin-executor.ts";

const now = "2026-10-09T00:00:00.000Z";
const binding = { actor: { principal: { personId: "settlement-test" }, executor: null }, source: "local" as const };
const base = createScheduleV1({
  scheduleId: "builtin-ci-observe",
  name: "CI",
  mode: "detect",
  actor: binding.actor,
  occurredAt: now,
  spec: {
    trigger: { kind: "interval", everyMs: 60000, anchorAt: now },
    target: { kind: "builtin", builtinId: "ci-observe" },
    mission: "Observe CI",
  },
});
const schedule: ScheduleV1 = {
  ...base,
  status: {
    ...base.status,
    activeRun: {
      occurrenceId: "occurrence-test",
      kind: "manual",
      scheduledFor: now,
      claimedAt: now,
      nodeId: "local",
      claimFence: "claim-test",
      attemptIndex: 0,
    },
  },
};
for (const outcome of ["succeeded", "failed"] as const) {
  test(`C2 ${outcome} executor preserves and logs a rejected settlement code`, async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args.join(" ")));
    const rejected = { outcome: "op_rejected" as const, code: "schedule_claim_stale", opId: "op-test", revision: 0 };
    const receipt = await executeBuiltinScheduleOccurrence({
      cell: {
        rootDir: ".",
        now: () => now,
        observeCi: async () => ({ outcome, detail: "test" }),
        runSnapshot: async (work) => work(),
      },
      schedule,
      binding,
      idempotencyKey: "test",
      runInternal: async () => rejected,
    });
    assert.equal(receipt, rejected);
    assert.deepEqual(warnings, [
      "[schedule-builtin] builtin-ci-observe/claim-test settlement rejected: schedule_claim_stale.",
    ]);
  });
}

test("C2 thrown settlement failure logs its code and remains rejected", async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args.join(" ")));
  const failure = Object.assign(new Error("Writer changed"), { code: "writer_epoch_stale" });
  await assert.rejects(
    executeBuiltinScheduleOccurrence({
      cell: {
        rootDir: ".",
        now: () => now,
        observeCi: async () => ({ outcome: "succeeded", detail: "test" }),
        runSnapshot: async (work) => work(),
      },
      schedule,
      binding,
      idempotencyKey: "test",
      runInternal: async () => {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.deepEqual(warnings, [
    "[schedule-builtin] builtin-ci-observe/claim-test settlement failed: writer_epoch_stale: Writer changed",
  ]);
});
