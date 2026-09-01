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
