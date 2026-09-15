// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  REPLAY_TASK_GRAPH,
  canonicalizeContractValue,
  makeTaskProjection,
  serializeEventHead,
  sha256Text,
} from "../../kernel/src/index.ts";
import { readMigrationProjectionOracle } from "../src/migration-import-oracle.ts";
import {
  compileRestatedTaskContract,
  restateLegacyTaskEvents,
  restateTaskContractBody,
} from "../src/migration-import-task-restatement.ts";

// Fragment from migration-import-oracle.test.ts. Block-scoped so its `actor` fixture stays separate
// from the task-restatement fragment below.
{
  const actor = {
    principal: { personId: "migration-oracle-fixture" },
    executor: { kind: "agent", id: "migration-import" },
  } as const;

  test("mismatched same-cut oracle rejects when disposable replay cannot reach the canonical event head", () => {
    const root = mkdtempSync(path.join(tmpdir(), "migration-oracle-cut-")),
      authored = path.join(root, "harness"),
      local = path.join(root, ".harness/cache");
    try {
      mkdirSync(path.join(authored, "events"), { recursive: true });
      mkdirSync(local, { recursive: true });
      writeFileSync(
        path.join(authored, "harness.yaml"),
        "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
      );
      writeFileSync(path.join(authored, "events/head.json"), '{"revision":7}\n');
      const database = new DatabaseSync(path.join(local, "task.sqlite"));
      database.exec("CREATE TABLE projection_meta(singleton INTEGER PRIMARY KEY, watermark INTEGER NOT NULL)");
      database.prepare("INSERT INTO projection_meta VALUES(1, 6)").run();
      database.close();
      assert.throws(
        () => readMigrationProjectionOracle(root),
        (error: unknown) =>
          error instanceof Error &&
          (error as Error & { readonly code?: string }).code === "migration_projection_oracle_cut_mismatch" &&
          /Rebuilt projection watermark 0.*head 7/u.test(error.message),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stale same-cut oracle rebuilds a legacy migration task through the normalized event stream", () => {
    const root = mkdtempSync(path.join(tmpdir(), "migration-oracle-in-place-"));
    try {
      const taskId = "task_legacy_in_place",
        packagePath = `tasks/${taskId}-legacy-in-place`,
        documentBody = taskDocument(taskId),
        documentSha = sha256Text(documentBody),
        event = {
          schema: "migration-import-event/v1",
          eventId: "event-legacy-in-place",
          workspaceRevision: 1,
          opId: "op-legacy-in-place",
          type: "entity_migrated",
          actor,
          source: "migration-import/v1",
          occurredAt: "2026-08-15T00:00:00.000Z",
          payload: {
            migratedFrom: taskId,
            generation: "v0",
            entity: {
              kind: "task",
              task: {
                schema: "task/v1",
                taskId,
                title: "Legacy in-place task",
                taskClass: "standard",
                status: "planned",
                graph: REPLAY_TASK_GRAPH,
                currentNode: "implementation",
                iteration: 0,
                createdBy: actor,
                completionGateIds: [],
                presetSnapshotDigest: null,
              },
              originalStatus: "planned",
              packagePath,
              documentClaim: {
                path: `${packagePath}/INDEX.md`,
                sha256: documentSha,
                size: Buffer.byteLength(documentBody),
                mediaType: "text/markdown",
                policyId: "typed-migration-import/v1",
              },
            },
          },
        },
        eventBody = `${JSON.stringify(canonicalizeContractValue(event))}\n`;
      writeHarnessRoot(root);
      mkdirSync(path.join(root, "harness/events"), { recursive: true });
      mkdirSync(path.join(root, "harness/objects/sha256", documentSha.slice(0, 2)), { recursive: true });
      mkdirSync(path.join(root, "harness", packagePath), { recursive: true });
      writeFileSync(path.join(root, "harness/events/op-legacy-in-place.json"), eventBody);
      writeFileSync(
        path.join(root, "harness/events/head.json"),
        serializeEventHead({
          revision: 1,
          opId: event.opId,
          eventDigest: `sha256:${sha256Text(eventBody)}`,
        }),
      );
      writeFileSync(
        path.join(root, "harness/objects/sha256", documentSha.slice(0, 2), documentSha.slice(2)),
        documentBody,
      );
      writeFileSync(path.join(root, "harness", packagePath, "INDEX.md"), documentBody);
      createEmptyProjection(root);

      const oracle = readMigrationProjectionOracle(root);

      assert.equal(oracle.basis, "rebuilt-source");
      assert.equal(oracle.watermark, 1);
      assert.equal(oracle.eventHeadRevision, 1);
      assert.equal(oracle.tasks.get(taskId)?.snapshot.task?.schema, "task/v2");
      assert.ok(
        oracle.formatObservations.some(
          ({ code, detail }) =>
            code === "legacy_event_normalized" && /migration task entity.*provenance=imported_snapshot/u.test(detail),
        ),
      );
      assert.ok(oracle.formatObservations.some(({ code }) => code === "source_projection_rebuilt"));
      const sourceDatabase = new DatabaseSync(path.join(root, ".harness/cache/task.sqlite"), { readOnly: true });
      try {
        assert.equal(
          (
            sourceDatabase.prepare("SELECT watermark FROM projection_meta WHERE singleton=1").get() as {
              readonly watermark: number;
            }
          ).watermark,
          0,
        );
      } finally {
        sourceDatabase.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("matching source projection remains the same-cut oracle", () => {
    const root = mkdtempSync(path.join(tmpdir(), "migration-oracle-same-cut-"));
    try {
      writeHarnessRoot(root);
      createEmptyProjection(root);
      const oracle = readMigrationProjectionOracle(root);
      assert.equal(oracle.basis, "same-cut-projection");
      assert.equal(oracle.watermark, 0);
      assert.equal(oracle.eventHeadRevision, null);
      assert.equal(oracle.formatObservations.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function writeHarnessRoot(root: string): void {
    mkdirSync(path.join(root, "harness"), { recursive: true });
    writeFileSync(
      path.join(root, "harness/harness.yaml"),
      "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
  }

  function createEmptyProjection(root: string): void {
    const projection = makeTaskProjection({
      rootDir: root,
      eventStore: {
        readHead: () => null,
        readBatch: () => ({ sourceRevision: 0, events: [], cursor: null, done: true, accessedItems: 0 }),
        readContentBlob: () => null,
      },
    });
    projection.rebuild();
    projection.close();
  }

  function taskDocument(taskId: string): string {
    return [
      "---",
      "schema: task-package/v2",
      `task_id: ${taskId}`,
      'title: "Legacy in-place task"',
      "lifecycle:",
      "  status: planned",
      "  engine: migration-import/v1",
      "bindingCreatedAt: 2026-08-15T00:00:00.000Z",
      "vertical: software/coding",
      "preset: standard-task",
      "profile: baseline",
      "---",
      "",
      "# Legacy in-place task",
      "",
    ].join("\n");
  }
}

// Fragment from migration-import-task-restatement.test.ts.
{
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

  test("legacy snapshot contract preserves its nested preset digest without resolving the retired preset", () => {
    const rootDir = fixtureRoot();
    try {
      const digest = `sha256:${"b".repeat(64)}` as const,
        restated = restateTaskContractBody({
          sourceRoot: rootDir,
          sourcePath: "harness/tasks/task-old/task-contract.json",
          body: JSON.stringify({
            schema: "task-contract-snapshot/v1",
            vertical: "software/coding",
            preset: { id: "retired-local-preset", version: "0.1.0", digest },
            profile: { id: "baseline" },
            documents: [],
          }),
          targetTaskId: "task-new",
          targetPackagePath: "tasks/task-new-migrated-task",
          fallback: { title: "Migrated task", taskClass: "standard" },
        }),
        contract = JSON.parse(restated.body) as Record<string, unknown>;
      assert.equal(restated.source, "contract");
      assert.equal(restated.presetSnapshotDigest, digest);
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

  test("retired long-running-task metadata restates the real M3 sample through standard-task", () => {
    const rootDir = fixtureRoot();
    try {
      const taskId = "task_01KWFQ0285MRXE92BYX7AGF9HD",
        restated = restateTaskContractBody({
          sourceRoot: rootDir,
          sourcePath: `harness/tasks/${taskId}/task-contract.json`,
          body: JSON.stringify({ schema: "task-contract/v1", taskId, taskClass: "standard" }),
          targetTaskId: taskId,
          targetPackagePath: `tasks/${taskId}-m3-triadic-kernel`,
          fallback: {
            title: "M3 triadic kernel milestone main coordination task",
            taskClass: "standard",
            verticalId: "software/coding",
            presetId: "long-running-task",
            profileId: "baseline",
            slug: "m3-triadic-kernel",
          },
        }),
        contract = JSON.parse(restated.body) as Record<string, unknown>;
      assert.deepEqual(restated.repair, {
        disposition: "retired-preset-to-standard-task",
        presetId: "standard-task",
        taskClass: "standard",
      });
      assert.equal(contract.presetId, "standard-task");
      assert.equal(contract.taskClass, "standard");
      assert.equal(contract.presetSnapshotDigest, restated.presetSnapshotDigest);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("another retired preset uses the same explicit standard-task disposition", () => {
    const rootDir = fixtureRoot();
    try {
      const taskId = "task_01KX51Z7HJTS56CTSVCTEM1SRF",
        restated = restateTaskContractBody({
          sourceRoot: rootDir,
          sourcePath: `harness/tasks/${taskId}/task-contract.json`,
          body: JSON.stringify({ schema: "task-contract/v1", taskId, taskClass: "standard" }),
          targetTaskId: taskId,
          targetPackagePath: `tasks/${taskId}-library-qianbaner-top`,
          fallback: {
            title: "进展页持续维护（library.qianbaner.top）",
            taskClass: "standard",
            verticalId: "software/coding",
            presetId: "progress-site",
            profileId: "baseline",
            slug: "library-qianbaner-top",
          },
        });
      assert.equal(restated.repair?.disposition, "retired-preset-to-standard-task");
      assert.equal(restated.repair?.presetId, "standard-task");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("preset taskClass requirement overrides the real Attribution sample declaration", () => {
    const rootDir = fixtureRoot();
    try {
      const taskId = "task_01KXAWVMTP3GV0QD7E5570CE4B",
        restated = restateTaskContractBody({
          sourceRoot: rootDir,
          sourcePath: `harness/tasks/${taskId}/task-contract.json`,
          body: JSON.stringify({ schema: "task-contract/v1", taskId, taskClass: "standard" }),
          targetTaskId: taskId,
          targetPackagePath: `tasks/${taskId}-plt-attribution-adr-0028`,
          fallback: {
            title: "PLT-Attribution:双轴归属主干统一切面(ADR-0028)",
            taskClass: "standard",
            verticalId: "software/coding",
            presetId: "create-milestone",
            profileId: "baseline",
            slug: "plt-attribution-adr-0028",
          },
        }),
        contract = JSON.parse(restated.body) as Record<string, unknown>;
      assert.deepEqual(restated.repair, {
        disposition: "preset-task-class-aligned",
        presetId: "create-milestone",
        taskClass: "milestone",
      });
      assert.equal(contract.presetId, "create-milestone");
      assert.equal(contract.taskClass, "milestone");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("unrecognized missing presets remain manual instead of receiving a guessed contract", () => {
    const rootDir = fixtureRoot();
    try {
      assert.throws(
        () =>
          restateTaskContractBody({
            sourceRoot: rootDir,
            sourcePath: "harness/tasks/task-unknown/task-contract.json",
            body: JSON.stringify({
              ...taskContractMetadata(),
              presetId: "unknown-retired-preset",
              presetSnapshotDigest: null,
            }),
            targetTaskId: "task-unknown",
            targetPackagePath: "tasks/task-unknown",
          }),
        /cannot derive presetSnapshotDigest from task contract metadata/u,
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("missing contract synthesis uses the same deterministic retired-preset and taskClass rules", () => {
    const rootDir = fixtureRoot();
    try {
      const retired = compileRestatedTaskContract({
          sourceRoot: rootDir,
          sourcePath: "harness/tasks/task_01KWFQ0285MRXE92BYX7AGF9HD/task-contract.json",
          targetTaskId: "task_01KWFQ0285MRXE92BYX7AGF9HD",
          targetPackagePath: "tasks/task_01KWFQ0285MRXE92BYX7AGF9HD-m3-triadic-kernel",
          fallback: {
            title: "M3 triadic kernel milestone main coordination task",
            taskClass: "standard",
            verticalId: "software/coding",
            presetId: "long-running-task",
            profileId: "baseline",
            slug: "m3-triadic-kernel",
          },
        }),
        conflict = compileRestatedTaskContract({
          sourceRoot: rootDir,
          sourcePath: "harness/tasks/task_01KXAWVMTP3GV0QD7E5570CE4B/task-contract.json",
          targetTaskId: "task_01KXAWVMTP3GV0QD7E5570CE4B",
          targetPackagePath: "tasks/task_01KXAWVMTP3GV0QD7E5570CE4B-plt-attribution-adr-0028",
          fallback: {
            title: "PLT-Attribution:双轴归属主干统一切面(ADR-0028)",
            taskClass: "standard",
            verticalId: "software/coding",
            presetId: "create-milestone",
            profileId: "baseline",
            slug: "plt-attribution-adr-0028",
          },
        });
      assert.equal(retired.repair?.disposition, "retired-preset-to-standard-task");
      assert.equal(conflict.repair?.disposition, "preset-task-class-aligned");
      assert.equal(conflict.repair?.taskClass, "milestone");
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
}
