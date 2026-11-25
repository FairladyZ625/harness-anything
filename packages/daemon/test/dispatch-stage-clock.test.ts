// harness-test-tier: fast
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  readDispatchStageClock,
  timeDispatchStage,
  withDispatchStageClock,
} from "../src/daemon-host/dispatch-stage-clock.ts";

test("stages outside a dispatch run unchanged and report nothing", async () => {
  assert.equal(await timeDispatchStage("origin_refresh", () => 7), 7);
  assert.deepEqual(readDispatchStageClock(), {});
});

test("a dispatch sums repeated stages, keeps failed stages, and nests under its outermost clock", async () => {
  const report = await withDispatchStageClock(async () => {
    await timeDispatchStage("task_context_read", () => delay(15));
    await timeDispatchStage("task_context_read", () => delay(15));
    await assert.rejects(
      timeDispatchStage("center_task_start", async () => {
        await delay(5);
        throw new Error("center rejected");
      }),
      /center rejected/u,
    );
    // A nested clock (a launch inside the spawn request) reports into the request's clock.
    await withDispatchStageClock(() => timeDispatchStage("worktree_add", () => delay(5)));
    return readDispatchStageClock();
  });
  assert.deepEqual(Object.keys(report.stages ?? {}).toSorted(), [
    "center_task_start",
    "task_context_read",
    "worktree_add",
  ]);
  assert.ok((report.stages?.task_context_read ?? 0) >= 25, "both reads are summed");
  assert.ok((report.durationMs ?? 0) >= (report.stages?.task_context_read ?? 0));
});

test("concurrent dispatches keep separate clocks", async () => {
  const [slow, fast] = await Promise.all([
    withDispatchStageClock(async () => {
      await timeDispatchStage("replica_wait", () => delay(40));
      return readDispatchStageClock().stages;
    }),
    withDispatchStageClock(async () => {
      await timeDispatchStage("worktree_setup", () => delay(5));
      return readDispatchStageClock().stages;
    }),
  ]);
  assert.deepEqual(Object.keys(slow ?? {}), ["replica_wait"]);
  assert.deepEqual(Object.keys(fast ?? {}), ["worktree_setup"]);
});
