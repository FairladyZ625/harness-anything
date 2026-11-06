// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskProjectionQueries } from "@harness-anything/kernel";
import { readTaskReviewAttribution } from "../src/task-review-attribution.ts";

type Reads = Parameters<typeof readTaskReviewAttribution>[0];
const actor = (id: string | null) => ({
  principal: { personId: "same-owner" },
  executor: id === null ? null : { kind: "agent" as const, id },
});
const interval = (id: string, acquiredRevision: number, releasedRevision: number | null) => ({
  taskId: "task-a",
  executionId: `execution-${id}`,
  holder: { taskId: "task-a", executionId: `execution-${id}`, actor: actor(id), source: "local" as const },
  previousHolder: null,
  acquiredRevision,
  releasedRevision,
  leaseExpiresAt: "2026-11-06T12:00:00.000Z",
  reason: "initial_claim" as const,
});
const row = (executorId: string | null, revision: number, type = "task_progress_recorded") => ({
  actor: { personId: "same-owner", executorId },
  revision,
  opId: `op-${revision}`,
  eventId: `event-${revision}`,
  schema: "task-progress-event/v1",
  type,
  occurredAt: "2026-11-06T11:00:00.000Z",
  entityRefs: ["task/task-a"],
});

test("owner evidence about a read-only API call is not attributed to a worker with the same principal", () => {
  const reads: Reads = {
      readEventList: () => ({
        rows: [row("owner-coordinator", 12), row("worker", 11)],
        hasMore: false,
        nextCursor: null,
      }),
      readLeaseIntervals: () => [interval("worker", 10, 20)],
    },
    result = readTaskReviewAttribution(reads, "task-a", 20);
  assert.deepEqual(result.actions[0]!.actor, actor("owner-coordinator"));
  assert.equal(result.actions[0]!.executionId, null);
  assert.equal(result.actions[0]!.authorization.lease, null);
  assert.equal(result.actions[1]!.executionId, "execution-worker");
  // The authenticated note author is not proof of who performed the external GET it describes.
  assert.deepEqual(result.externalEvidence, { identityConfidence: "unverified", actor: null });
});

test("a worker action retains its executor and unverified external authorization despite sharing the owner principal", () => {
  const reads: Reads = {
      readEventList: () => ({ rows: [row("runtime-session:worker", 15)], hasMore: false, nextCursor: null }),
      readLeaseIntervals: () => [interval("runtime-session:worker", 10, 20)],
    },
    action = readTaskReviewAttribution(reads, "task-a", 20).actions[0]!;
  assert.deepEqual(action.actor, actor("runtime-session:worker"));
  assert.equal(action.runtimeSessionId, "worker");
  assert.equal(action.executionId, "execution-runtime-session:worker");
  assert.equal(action.identityConfidence, "recorded");
  assert.equal(action.authorization.confidence, "unverified", "a lease is not publication permission");
  assert.deepEqual(action.evidence, { opId: "op-15", eventId: "event-15", revision: 15 });
});

test("lease boundaries identify the acting execution, and never assign old or unrelated actors to the newest worker", () => {
  const reads: Reads = {
      readEventList: () => ({
        rows: [row("old", 31), row("new", 30), row("old", 25), row("old", 20), row("old", 9), row(null, 15)],
        hasMore: true,
        nextCursor: "9",
      }),
      readLeaseIntervals: () => [interval("old", 10, 20), interval("new", 30, null)],
    },
    result = readTaskReviewAttribution(reads, "task-a", 40);
  assert.deepEqual(
    result.actions.map(({ executionId }) => executionId),
    [null, "execution-new", null, "execution-old", null, null],
  );
  assert.deepEqual(result.actions.at(-1)!.actor, actor(null));
  assert.deepEqual(result.page, { hasMore: true, nextCursor: "9" });
});

test("the read is task-indexed, cut-bounded and independent of artifact/event payload size", () => {
  let query: Parameters<TaskProjectionQueries["readEventList"]>[0] | undefined;
  const reads: Reads = {
    readEventList: (value) => {
      query = value;
      return { rows: Array.from({ length: 100 }, (_, i) => row("worker", 100 - i)), hasMore: true, nextCursor: "1" };
    },
    readLeaseIntervals: () => [interval("worker", 1, null)],
  };
  // No full event, artifact, dispatch prompt, or repository-wide scan port is supplied.
  const result = readTaskReviewAttribution(reads, "task-a", 100);
  assert.deepEqual(query, { entity: "task/task-a", limit: 100, revisionBound: 101 });
  assert.equal(result.actions.length, 100);
  assert.equal(result.sourceRevision, 100);
  assert.equal(result.page.hasMore, true);
});
