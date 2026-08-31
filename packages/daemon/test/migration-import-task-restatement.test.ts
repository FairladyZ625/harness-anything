// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { REPLAY_TASK_GRAPH } from "../../kernel/src/index.ts";
import { restateLegacyTaskEvents, restateTaskContractBody } from "../src/migration-import-task-restatement.ts";

const actor = { principal: { personId: "person_zeyu" }, executor: null } as const;

test("Task/v1 restatement preserves pinned and explicitly writes false when the field is absent", () => {
  const restated = restateLegacyTaskEvents([
    input(1, "task_missing_pin", legacyTask("task_missing_pin")),
    input(2, "task_pinned", { ...legacyTask("task_pinned"), pinned: true }),
  ]);
  assert.deepEqual(restated.get("task_missing_pin"), {
    taskId: "task_missing_pin",
    pinned: false,
    pinnedWasPresent: false,
    sourceRevision: 1,
    sourcePath: "harness/events/1.json",
  });
  assert.equal(restated.get("task_pinned")?.pinned, true);
  assert.equal(restated.get("task_pinned")?.pinnedWasPresent, true);
});

test("Task/v1 restatement rejects a row missing any non-migrated required field", () => {
  const { title: _title, ...missingTitle } = legacyTask("task_missing_title");
  assert.throws(
    () => restateLegacyTaskEvents([input(1, "task_missing_title", missingTitle)]),
    /Task\/v1 cannot be restated as Task\/v2: Task\/v2 fields are incomplete/u,
  );
});

test("Task/v1 restatement rejects duplicate task identity creation", () => {
  assert.throws(
    () =>
      restateLegacyTaskEvents([
        input(1, "task_duplicate", legacyTask("task_duplicate")),
        input(2, "task_duplicate", legacyTask("task_duplicate")),
      ]),
    /identity occurs more than once/u,
  );
});

test("Task/v1 restatement rejects reverse source revisions", () => {
  assert.throws(
    () =>
      restateLegacyTaskEvents([
        input(2, "task_two", legacyTask("task_two")),
        input(1, "task_one", legacyTask("task_one")),
      ]),
    /revisions must increase/u,
  );
});

test("task contract restatement preserves a declared digest and rewrites migrated identity", () => {
  const rootDir = fixtureRoot();
  try {
    const digest = `sha256:${"a".repeat(64)}` as const,
      restated = restateTaskContractBody({
        sourceRoot: rootDir,
        sourcePath: "harness/tasks/task-old/task-contract.json",
        body: JSON.stringify({
          schema: "task-contract/v1",
          contractVersion: 1,
          taskId: "task-old",
          packagePath: "tasks/task-old-before",
          presetSnapshotDigest: digest,
          title: "Migrated task",
        }),
        targetTaskId: "task-new",
        targetPackagePath: "tasks/task-new-migrated-task",
      }),
      contract = JSON.parse(restated.body) as Record<string, unknown>;
    assert.equal(restated.presetSnapshotDigest, digest);
    assert.equal(restated.source, "contract");
    assert.equal(contract.taskId, "task-new");
    assert.equal(contract.packagePath, "tasks/task-new-migrated-task");
    assert.equal(contract.presetSnapshotDigest, digest);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("task contract restatement recomputes a missing digest from contract metadata", () => {
  const rootDir = fixtureRoot();
  try {
    const restated = restateTaskContractBody({
      sourceRoot: rootDir,
      sourcePath: "harness/tasks/task-old/task-contract.json",
      body: JSON.stringify(taskContractMetadata()),
      targetTaskId: "task-new",
      targetPackagePath: "tasks/task-new-migrated-task",
    });
    assert.equal(restated.source, "compiled");
    assert.match(restated.presetSnapshotDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(
      (JSON.parse(restated.body) as Record<string, unknown>).presetSnapshotDigest,
      restated.presetSnapshotDigest,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("task contract restatement fails closed when a missing digest cannot be derived", () => {
  const rootDir = fixtureRoot();
  try {
    assert.throws(
      () =>
        restateTaskContractBody({
          sourceRoot: rootDir,
          sourcePath: "harness/tasks/task-old/task-contract.json",
          body: JSON.stringify({ ...taskContractMetadata(), title: null }),
          targetTaskId: "task-new",
          targetPackagePath: "tasks/task-new-migrated-task",
        }),
      /cannot derive presetSnapshotDigest from task contract metadata/u,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("legacy snapshot contracts use canonical task fallback metadata and normalize document paths", () => {
  const rootDir = fixtureRoot();
  try {
    const restated = restateTaskContractBody({
        sourceRoot: rootDir,
        sourcePath: "harness/tasks/task-old/task-contract.json",
        body: JSON.stringify({
          schema: "task-contract-snapshot/v1",
          vertical: "software/coding",
          preset: { id: "standard-task" },
          profile: { id: "baseline" },
          documents: [{ slot: "task.closeout", materializeAs: "closeout.md", locale: "en-US" }],
        }),
        targetTaskId: "task-new",
        targetPackagePath: "tasks/task-new-migrated-task",
        fallback: { title: "Migrated task", taskClass: "standard" },
      }),
      contract = JSON.parse(restated.body) as {
        readonly schema: string;
        readonly title: string;
        readonly presetId: string;
        readonly documents: readonly { readonly path?: string }[];
      };
    assert.equal(restated.source, "compiled");
    assert.equal(contract.schema, "task-contract/v1");
    assert.equal(contract.title, "Migrated task");
    assert.equal(contract.presetId, "standard-task");
    assert.equal(contract.documents[0]?.path, "closeout.md");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function fixtureRoot(): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-contract-restatement-"));
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  return rootDir;
}

function taskContractMetadata() {
  return {
    schema: "task-contract/v1",
    contractVersion: 1,
    taskId: "task-old",
    packagePath: "tasks/task-old-before",
    title: "Migrated task",
    taskClass: "standard",
    verticalId: "software/coding",
    presetId: "standard-task",
    profileId: "baseline",
    locale: "en-US",
  } as const;
}

function input(
  workspaceRevision: number,
  taskId: string,
  task: Readonly<Record<string, unknown>>,
  type = "task_created",
) {
  return {
    sourcePath: `harness/events/${workspaceRevision}.json`,
    value: {
      schema: "task-event/v1",
      eventId: `event-${workspaceRevision}`,
      workspaceRevision,
      opId: `op-${workspaceRevision}`,
      type,
      taskId,
      actor,
      source: "migration-import/v1",
      occurredAt: `2026-01-01T00:00:0${workspaceRevision}.000Z`,
      payload: { task },
    },
  };
}

function legacyTask(taskId: string) {
  return {
    schema: "task/v1",
    taskId,
    title: taskId,
    taskClass: "standard",
    status: "planned",
    graph: REPLAY_TASK_GRAPH,
    currentNode: "implementation",
    iteration: 0,
    createdBy: actor,
    completionGateIds: [],
    presetSnapshotDigest: null,
  } as const;
}
