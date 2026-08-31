// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { makeTaskProjection } from "../../src/projection/task-projection.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import type { TaskEventV1 } from "../../src/domain/task-lifecycle.contract.ts";
import { deriveRelationId } from "../../src/domain/entity-relation.ts";
import { lifecycleFixture } from "./task-lifecycle-fixture.ts";
import { withTempStoreAsync } from "./helpers.ts";

function initRepo(rootDir: string): void {
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
    ["commit", "--quiet", "--allow-empty", "-m", "seed"],
    ["update-ref", "refs/ha/canonical", "HEAD"],
  ])
    execFileSync("git", args, { cwd: rootDir });
}

// Regression for the 2026-08-31 GUI outage: lifecycle event payloads may embed
// legacy hosted fields on payload.task (relations as replay input for the
// Relation aggregate, metadata.longRunning from older generations). The stored
// snapshot must be normalized through currentTaskForWrite, or every GUI task
// read is rejected by the protocol validator (`snapshot.task is invalid`).
test("projected snapshot.task never hosts legacy relations or longRunning fields", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "normalize-repo", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore }),
      created = lifecycleFixture().events[0]!,
      relationIdentity = {
        source: "task/task-1",
        target: "task/task-2",
        type: "depends-on",
        direction: "directed",
      } as const,
      legacyRelation = {
        relation_id: deriveRelationId(relationIdentity),
        ...relationIdentity,
        strength: "strong",
        origin: "declared",
        state: "active",
        rationale: "legacy hosted relation embedded in the event payload",
      };
    const event = {
      ...created,
      payload: {
        ...created.payload,
        task: {
          ...(created as { payload: { task: object } }).payload.task,
          relations: [legacyRelation],
          metadata: {
            idempotencyKey: null,
            parentTaskId: null,
            workKind: null,
            riskTier: null,
            urgency: null,
            verticalId: "software/coding",
            presetId: "standard-task",
            profileId: "baseline",
            moduleKey: null,
            slug: "fixture",
            surfaces: [],
            fromLegacyId: null,
            longRunning: true,
          },
        },
      },
    } as unknown as TaskEventV1;
    projection.apply(event, taskLifecycleWritePlan(event));
    const rows = projection.list().rows;
    assert.equal(rows.length, 1);
    const task = rows[0]!.snapshot.task as Record<string, unknown> | null;
    assert.ok(task, "snapshot.task must be materialized");
    assert.ok(!Object.hasOwn(task, "relations"), "snapshot.task must not host a relations field");
    const metadata = task.metadata as Record<string, unknown>;
    assert.ok(!Object.hasOwn(metadata, "longRunning"), "snapshot.task.metadata must not host longRunning");
    assert.equal(task.taskId, "task-1");
    projection.close();
  });
});
