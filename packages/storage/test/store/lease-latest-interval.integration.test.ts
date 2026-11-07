// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { taskLifecycleWritePlan } from "@harness-anything/kernel/internal/domain/task-lifecycle-publication.ts";
import type { TaskEventV1 } from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import { twoRoundLifecycleEvents } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { makeTaskEventStore, type CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";

const taskId = "task-two-round";

/** Marker publication and execution-read checks ask only for the current acquisition. A second
 * round must not make that read walk the first round's interval, and the answer must stay the
 * newest row. */
test("latest acquisition seeks one indexed row after the task is re-entered", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" }),
      { events } = twoRoundLifecycleEvents();
    for (const event of events) {
      eventStore.append(taskBundle(event));
      projection.apply(event);
    }
    try {
      const history = projection.readLeaseIntervals(taskId);
      assert.equal(history.length, 2, "the fixture must accumulate two acquisitions");
      const latest = projection.readLatestLeaseInterval(taskId);
      assert.equal(latest?.executionId, "execution-round-two");
      assert.deepEqual(latest, history.at(-1));
      const submittedExecutionLatest = projection.readLatestLeaseIntervalForExecution(taskId, "execution-round-one");
      assert.equal(submittedExecutionLatest?.executionId, "execution-round-one");
      assert.deepEqual(
        submittedExecutionLatest,
        history.find((interval) => interval.executionId === "execution-round-one"),
        "a later task round must not change the submitted execution's placement lease",
      );
      assert.equal(projection.readLatestLeaseIntervalForExecution(taskId, "execution-missing"), null);
      assert.equal(projection.readLatestLeaseInterval("task-missing"), null);

      const db = new DatabaseSync(projection.path);
      try {
        const plan = db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT * FROM lease_interval WHERE task_id = ? ORDER BY acquired_revision DESC LIMIT 1",
          )
          .all(taskId)
          .map((row) => String((row as { readonly detail: string }).detail))
          .join("\n");
        assert.match(plan, /lease_interval_task_acquisition/u, plan);
        assert.doesNotMatch(plan, /TEMP B-TREE/u, plan);
        const executionPlan = db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT * FROM lease_interval WHERE task_id = ? AND execution_id = ? ORDER BY acquired_revision DESC LIMIT 1",
          )
          .all(taskId, "execution-round-one")
          .map((row) => String((row as { readonly detail: string }).detail))
          .join("\n");
        assert.match(executionPlan, /sqlite_autoindex_lease_interval_1/u, executionPlan);
        assert.doesNotMatch(executionPlan, /TEMP B-TREE/u, executionPlan);
      } finally {
        db.close();
      }
    } finally {
      projection.close();
    }
  });
});

function taskBundle(event: TaskEventV1): CanonicalWriteBundle {
  return { event, plan: taskLifecycleWritePlan(event), blobs: [] };
}
function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Projection Test");
  git(rootDir, "config", "user.email", "projection-test@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
