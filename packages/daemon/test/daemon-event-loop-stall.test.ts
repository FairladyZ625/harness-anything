// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  frameArrivalAt,
  pruneEventLoopStallWindows,
  recordEventLoopStallWindow,
  type EventLoopStallWindow,
} from "../src/daemon-event-loop-stall.ts";

test("only frames read in the recovery grace window clamp back to the stall start", () => {
  const windows: EventLoopStallWindow[] = [];
  recordEventLoopStallWindow(windows, 1_000, 3_000);
  assert.equal(frameArrivalAt(3_005, windows, 20), 1_000);
  assert.equal(frameArrivalAt(3_005, windows, 20), 1_000, "two connections in the same turn both see it");
  assert.equal(frameArrivalAt(3_100, windows, 20), 3_100, "a later idle frame must not inherit a past stall");
});

test("a frame handled before the heartbeat pulse uses only the currently running delay", () => {
  assert.equal(frameArrivalAt(10_000, [], 20, 500), 9_500);
  assert.equal(frameArrivalAt(10_000, [], 20, 5), 10_000);
});

test("stall windows are pruned by wall-clock age", () => {
  const windows: EventLoopStallWindow[] = [];
  recordEventLoopStallWindow(windows, 1_000, 3_000);
  pruneEventLoopStallWindows(windows, 3_000 + 61_000);
  assert.deepEqual(windows, []);
});
