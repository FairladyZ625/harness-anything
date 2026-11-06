// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { LeaseInterval } from "@harness-anything/kernel";
import { taskLeaseAcquiredRevision } from "../src/task-worktree.ts";

/** The marker and execution-read checks pin the acquisition identified by the newest interval.
 * `readLatestLeaseInterval` is the only reader they receive, so a history scan cannot creep back in. */
const latestOf = (latest: LeaseInterval | null) => ({ readLatestLeaseInterval: () => latest }),
  interval = (executionId: string, acquiredRevision: number, releasedRevision: number | null = null) =>
    ({ executionId, acquiredRevision, releasedRevision }) as LeaseInterval;

test("the newest open acquisition returns its revision for the holder", () => {
  assert.equal(taskLeaseAcquiredRevision(latestOf(interval("execution-a", 7)), "task-1", "execution-a"), 7);
});

test("a re-entry's newest acquisition fences the previous execution", () => {
  assert.equal(taskLeaseAcquiredRevision(latestOf(interval("execution-b", 12)), "task-1", "execution-a"), null);
});

test("a released newest acquisition and an empty history both answer null", () => {
  assert.equal(taskLeaseAcquiredRevision(latestOf(interval("execution-a", 7, 9)), "task-1", "execution-a"), null);
  assert.equal(taskLeaseAcquiredRevision(latestOf(null), "task-1", "execution-a"), null);
});
