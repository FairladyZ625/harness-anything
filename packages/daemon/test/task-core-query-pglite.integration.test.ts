// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { taskLifecycleWritePlan } from "@harness-anything/kernel";
import { taskListPayload } from "@harness-anything/application/internal/queries/task-list-read.ts";
import { taskShowFromProjection } from "@harness-anything/application/internal/queries/task-show-read.ts";
import type { TaskCoreQueryPorts } from "@harness-anything/application/internal/queries/task-query-ports.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { makeTaskEventStore } from "../../storage/src/store/task-event-store.ts";
import { makeTaskProjectionReader } from "../../storage/src/projection/rebuildable-task-projection.ts";
import { pgliteIntegrationSuite } from "../../storage/test/pglite/pglite-runtime.fixture.ts";
import { initRepo } from "../../storage/test/store/task-event-store.fixtures.ts";
import { withTempStoreAsync } from "../../storage/test/store/helpers.ts";

const taskId = "task_stateless_core";

pgliteIntegrationSuite("task core reads without a local worktree", () => {
  test("PGlite list and show stay identical when checkout probes are omitted", async () => {
    await withTempStoreAsync(async (rootDir) => {
      initRepo(rootDir);
      const repoId = "stateless-task-core";
      const storage = {
        backend: "pglite" as const,
        dataDir: join(rootDir, "database"),
        materialize: false,
        scope: { tenantId: "tenant", projectId: "project", readers: [], policyEpoch: 0 },
      };
      const embedded = makeTaskEventStore({ repoId, rootDir, storage });
      const edge = { kind: "node", nodeId: "node-edge-a" } as const;
      for (const original of lifecycleFixture({ taskId, executionId: "execution-core" }).events) {
        const event = { ...original, source: edge };
        embedded.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
      }
      const reader = makeTaskProjectionReader({ repoId, storage });
      const show = (ports: TaskCoreQueryPorts) =>
        taskShowFromProjection(rootDir, reader, taskId, undefined, undefined, "include_done", ports, {});
      const absent = show({});
      const explicit = show({
        linkedWorktree: () => false,
        taskPlanPresent: () => false,
        readWorktreeSetupSucceeded: () => null,
      });
      assert.deepEqual(absent, explicit);
      assert.equal(absent.outcome, "applied");
      const evidence = JSON.parse(absent.evidence) as { workspace?: { kind?: string; state?: string } };
      if (evidence.workspace?.kind === "worktree") assert.notEqual(evidence.workspace.state, "materialized");
      const reads = {
        readTaskIndex: reader.readTaskIndex.bind(reader),
        readTaskChildCounts: reader.readTaskChildCounts.bind(reader),
        rootThreshold: 4,
      };
      const codedError = (code: string, message: string) => Object.assign(new Error(message), { code });
      const listed = taskListPayload(reads, {}, {}, codedError);
      const listedAgain = taskListPayload(reads, {}, {}, codedError);
      assert.deepEqual(listed.payload, listedAgain.payload);
      assert.equal(listed.payload.schema, "task-list/v2");
      assert.equal(
        listed.read.rows.some((row) => row.taskId === taskId),
        true,
      );
    });
  });
});
