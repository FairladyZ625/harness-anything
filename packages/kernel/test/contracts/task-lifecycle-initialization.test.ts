// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyTaskLifecycleSnapshot,
  initializeTaskLifecycleSnapshot,
  reduceTaskEvent,
} from "../../src/domain/task-lifecycle.contract.ts";
import { currentTaskForWrite } from "../../src/domain/task.ts";
import type { TaskBootstrapEventV1 } from "../../src/domain/task-bootstrap-event.ts";
import type { MigrationImportEventV1 } from "../../src/domain/migration-import-event.ts";
import { MIGRATION_DOCUMENT_POLICY_ID, MIGRATION_IMPORT_SOURCE } from "../../src/domain/migration-import-event.ts";
import { lifecycleFixture } from "../store/task-lifecycle-fixture.ts";

const fixture = lifecycleFixture(),
  created = fixture.events[0]!;
assert.equal(created.type, "task_created");
if (created.type !== "task_created") throw new Error("fixture must begin with task creation");
const bootstrap: TaskBootstrapEventV1 = {
  ...created,
  schema: "task-bootstrap-event/v1",
  type: "task_bootstrapped",
  payload: {
    task: created.payload.task,
    presetSnapshotClaim: {
      digest: `sha256:${"a".repeat(64)}`,
      sha256: "b".repeat(64),
      size: 2,
      mediaType: "application/json",
    },
    initialDocumentClaims: [],
  },
};

test("canonical bootstrap seed replays the same subsequent lifecycle as task creation", () => {
  let snapshot = initializeTaskLifecycleSnapshot(bootstrap);
  for (const event of fixture.events.slice(1)) snapshot = reduceTaskEvent(snapshot, event);
  assert.deepEqual(snapshot, fixture.snapshot);
});

test("bootstrap and imported seed preserve non-default lifecycle state and metadata", () => {
  const task = currentTaskForWrite({ ...fixture.snapshot.task!, status: "blocked", iteration: 3, pinned: true }),
    imported: MigrationImportEventV1 = {
      schema: "migration-import-event/v1",
      eventId: "import-task-seed",
      opId: "import-task-seed",
      workspaceRevision: 41,
      actor: created.actor,
      source: MIGRATION_IMPORT_SOURCE,
      occurredAt: created.occurredAt,
      type: "entity_migrated",
      payload: {
        migratedFrom: "legacy-task",
        generation: "v0",
        entity: {
          kind: "task",
          provenance: "imported_snapshot",
          task,
          originalStatus: task.status,
          packagePath: "tasks/legacy-task",
          documentClaim: {
            path: "tasks/legacy-task/INDEX.md",
            sha256: "c".repeat(64),
            size: 1,
            mediaType: "text/markdown",
            policyId: MIGRATION_DOCUMENT_POLICY_ID,
          },
        },
      },
    };
  for (const event of [{ ...bootstrap, workspaceRevision: 41, payload: { ...bootstrap.payload, task } }, imported]) {
    const snapshot = initializeTaskLifecycleSnapshot(event);
    assert.deepEqual(snapshot.task, task);
    assert.equal(snapshot.revision, 41);
    assert.deepEqual(snapshot.executions, []);
    assert.equal(snapshot.lease, null);
  }
});

test("canonical seed cannot overwrite an aggregate or replay at an old revision", () => {
  const snapshot = initializeTaskLifecycleSnapshot(bootstrap),
    rejected = (operation: () => unknown) =>
      assert.throws(operation, { code: "invalid_transition", message: /event revision or aggregate identity/u });
  rejected(() => reduceTaskEvent(snapshot, { ...bootstrap, workspaceRevision: snapshot.revision + 1 }));
  rejected(() => reduceTaskEvent(emptyTaskLifecycleSnapshot(bootstrap.workspaceRevision), bootstrap));
  rejected(() => initializeTaskLifecycleSnapshot({ ...bootstrap, taskId: "different-task" }));
});

test("non-task migration cannot initialize a task aggregate", () => {
  const nonTask = {
    schema: "migration-import-event/v1",
    workspaceRevision: 1,
    payload: { entity: { kind: "repo-document" } },
  } as unknown as MigrationImportEventV1;
  assert.throws(() => initializeTaskLifecycleSnapshot(nonTask), { code: "invalid_transition" });
});
