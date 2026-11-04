// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { WriteReceipt } from "@harness-anything/kernel";
import type { RepoCellRuntimeContext } from "../src/repo-cell-action-context.ts";
import type { RuntimeAttemptTerminal, TrustedScheduleRuntime } from "../src/runtime-spawn.ts";
import { settleScheduledRuntime } from "../src/schedule-action-runtime.ts";

const runtimeSessionId = "runtime_0123456789abcdef01234567",
  uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

test("schedule terminal link and settle mint request ids instead of deriving them from the runtime session", async () => {
  const schedule: TrustedScheduleRuntime = {
      scheduleId: "schedule-1",
      occurrenceId: "occurrence-1",
      claimFence: "claim_0123456789abcdef01234567",
      mode: "detect",
    },
    terminal: RuntimeAttemptTerminal = {
      runtimeSessionId,
      dispatchId: "dispatch_0123456789abcdef01234567",
      task: null,
      schedule,
      outcome: "succeeded",
      reason: "fixture complete",
      endedAt: "2026-11-05T00:00:00.000Z",
      binding: {} as RuntimeAttemptTerminal["binding"],
    },
    cell = {
      rootDir: "/tmp/harness-schedule-request-id",
      projection: {
        getEntity: () => ({
          value: {
            status: { activeRun: { runtimeSessionId: "runtime_old", claimFence: schedule.claimFence } },
          },
        }),
      },
      cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    } as unknown as RepoCellRuntimeContext,
    calls: {
      readonly action: { readonly kind: string; readonly idempotencyKey?: unknown };
      readonly actionId: string;
    }[] = [];

  await settleScheduledRuntime(cell, terminal, async (action, actionId) => {
    calls.push({ action, actionId });
    return { outcome: "applied", opId: actionId, revision: 1 } as WriteReceipt;
  });

  assert.equal(calls.length, 2, "a stale terminal links the dispatch and then settles the occurrence");
  assert.deepEqual(
    calls.map(({ action }) => [action.kind, action.idempotencyKey]),
    [
      ["schedule-dispatch-link", `${runtimeSessionId}:terminal-link`],
      ["schedule-settle", `${runtimeSessionId}:attempt-terminal`],
    ],
    "the business idempotency key stays an explicit action field",
  );
  for (const { actionId } of calls) {
    assert.match(actionId, uuid, "the request id is a fresh random UUID");
    assert.equal(actionId.includes(runtimeSessionId), false, "the request id never embeds the runtime session");
    assert.equal(actionId.includes(schedule.scheduleId), false, "the request id never embeds the schedule id");
    assert.equal(actionId.includes(schedule.claimFence), false, "the request id never embeds the claim fence");
  }
  assert.notEqual(calls[0]!.actionId, calls[1]!.actionId, "each settlement step is its own request");
});
