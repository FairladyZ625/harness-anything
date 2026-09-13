// harness-test-tier: fast
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import type { TaskProjection } from "../../kernel/src/index.ts";
import { listProjectedTaskDocuments, readProjectedDocument } from "../src/doc-sync-reads.ts";
import { requireCurrentTaskProjection } from "../src/projection-readiness.ts";
import { readTaskCompletion } from "../src/task-completion-read.ts";
import type { RepoCellOperationalContext } from "../src/repo-cell-action-context.ts";
import { runFactAction } from "../src/repo-cell-fact-action.ts";
import type { RepoCellBinding } from "../src/repo-cell-types.ts";
import type { RuntimeSpawnerInput } from "../src/runtime-spawn-types.ts";
import { makeRuntimeSpawner } from "../src/runtime-spawner.ts";

type TaskRead = ReturnType<TaskProjection["read"]>;

const binding: RepoCellBinding = {
  actor: { principal: { personId: "person-owner" }, executor: null },
  source: "local",
};

function projectionOf(read: TaskRead): Pick<TaskProjection, "read"> & { readonly reads: () => number } {
  let reads = 0;
  return {
    read: () => {
      reads += 1;
      return read;
    },
    reads: () => reads,
  };
}

function factCell(read: TaskRead) {
  const projection = projectionOf(read),
    executed: string[] = [],
    cell = {
      input: { repoId: "repository" },
      projection: {
        read: projection.read,
        searchFacts: () => assert.fail("fact record must not search facts to gate its write"),
      },
      store: { readHead: () => ({ revision: 9 }) },
      operationId: (_action: unknown, _binding: unknown, _repoId: string, revision: number) => `op-${revision}`,
      entityActionExecutor: {
        run: async (_action: unknown, _binding: unknown, opId: string) => {
          executed.push(opId);
          return { outcome: "applied", opId };
        },
      },
    } as unknown as RepoCellOperationalContext;
  return { cell, executed, reads: projection.reads };
}

test("fact record checks its linked task projection once and never polls", async () => {
  const current = factCell(readyTaskRead());
  assert.equal(
    (await runFactAction(current.cell, { kind: "fact-record", taskId: "task_ready" }, binding)).opId,
    "op-2",
  );
  assert.deepEqual(current.executed, ["op-2"]);
  assert.equal(current.reads(), 1);

  const lagging = factCell({ ...readyTaskRead(), status: "pending", watermark: 1, sourceRevision: 2 });
  await assert.rejects(
    runFactAction(lagging.cell, { kind: "fact-record", taskId: "task_ready" }, binding),
    (error: unknown) => (error as { readonly code?: unknown }).code === "content_not_ready",
  );
  assert.deepEqual(lagging.executed, []);
  assert.equal(lagging.reads(), 1);

  const unlinked = factCell(readyTaskRead());
  assert.equal((await runFactAction(unlinked.cell, { kind: "fact-record" }, binding)).opId, "op-9");
  assert.equal(unlinked.reads(), 0);
});

test("runtime.run rejects a lagging task projection from a single read", async () => {
  const projection = projectionOf({ ...readyTaskRead(), status: "pending", watermark: 1, sourceRevision: 2 }),
    spawner = makeRuntimeSpawner({
      repoId: "repository",
      rootDir: tmpdir(),
      store: () => ({}),
      projection: () => projection,
      now: () => "2026-09-10T00:00:00.000Z",
    } as unknown as RuntimeSpawnerInput);
  await assert.rejects(
    spawner.spawn(
      {
        runtimeInstanceId: "worker",
        cwd: { scope: "repo-root" },
        prompt: "Inspect",
        taskId: "task_ready",
        idempotencyKey: "lagging-projection",
      },
      binding,
    ),
    (error: unknown) => (error as { readonly code?: unknown }).code === "content_not_ready",
  );
  assert.equal(projection.reads(), 1);
});

test("a current task projection is returned from a single read", () => {
  const projection = projectionOf(readyTaskRead());
  assert.equal(requireCurrentTaskProjection(projection, "task_ready", "unit test").packagePath, "tasks/task_ready");
  assert.equal(projection.reads(), 1);
});

test("a lagging projection is rejected with its cut instead of being polled", () => {
  const projection = projectionOf({ ...readyTaskRead(), status: "pending", watermark: 1, sourceRevision: 2 });
  assert.throws(
    () => requireCurrentTaskProjection(projection, "task_ready", "unit test"),
    (error: unknown) => {
      const record = error as Record<string, unknown>;
      assert.equal(record.code, "content_not_ready");
      assert.equal(record.watermark, 1);
      assert.equal(record.sourceRevision, 2);
      assert.match(String(record.message), /behind the canonical event stream: watermark 1, source revision 2\./u);
      return true;
    },
  );
  assert.equal(projection.reads(), 1);
});

test("a task absent from a current projection is not found", () => {
  const projection = projectionOf({
    ...readyTaskRead(),
    snapshot: { revision: 0, task: null, lease: null, executions: [] },
    packagePath: null,
  } as unknown as TaskRead);
  assert.throws(
    () => requireCurrentTaskProjection(projection, "task_missing", "unit test"),
    (error: unknown) => (error as { readonly code?: unknown }).code === "task_not_found",
  );
  assert.equal(projection.reads(), 1);
});

test("a projected task without a package is not ready", () => {
  const projection = projectionOf({ ...readyTaskRead(), packagePath: null });
  assert.throws(
    () => requireCurrentTaskProjection(projection, "task_ready", "unit test"),
    (error: unknown) =>
      (error as { readonly code?: unknown }).code === "content_not_ready" &&
      /has a canonical event but no projected package for unit test/u.test(String((error as Error).message)),
  );
});

function missingTaskRead(): TaskRead {
  return {
    ...readyTaskRead(),
    snapshot: { revision: 0, task: null, lease: null, executions: [] },
    packagePath: null,
  } as unknown as TaskRead;
}

function guiDocumentReadContext(projection: Pick<TaskProjection, "read">) {
  return {
    rootDir: tmpdir(),
    projection: projection as unknown as TaskProjection,
    store: { readContentBlob: () => null },
  };
}

// The GUI document read faces must settle absence the same way task show and dispatches do:
// a lagging cut is not an answer about the task, a current cut without the task is a not-found
// naming the id, and a task without a package is a not-ready — never a not-found for a task
// that does exist.
test("task document read settles lagging, absent, and unpackaged tasks via the shared judgment", () => {
  assert.throws(
    () =>
      readProjectedDocument(
        guiDocumentReadContext(
          projectionOf({ ...readyTaskRead(), status: "pending", watermark: 1, sourceRevision: 2 }),
        ),
        { taskId: "task_ready", path: "task_plan.md" },
      ),
    (error: unknown) => (error as { readonly code?: unknown }).code === "content_not_ready",
  );
  assert.throws(
    () =>
      readProjectedDocument(guiDocumentReadContext(projectionOf(missingTaskRead())), {
        taskId: "task_missing",
        path: "task_plan.md",
      }),
    (error: unknown) => (error as { readonly code?: unknown }).code === "task_not_found",
  );
  assert.throws(
    () =>
      readProjectedDocument(guiDocumentReadContext(projectionOf({ ...readyTaskRead(), packagePath: null })), {
        taskId: "task_ready",
        path: "task_plan.md",
      }),
    (error: unknown) => (error as { readonly code?: unknown }).code === "content_not_ready",
  );
});

test("task documents list settles lagging, absent, and unpackaged tasks via the shared judgment", () => {
  assert.throws(
    () =>
      listProjectedTaskDocuments(
        tmpdir(),
        projectionOf({
          ...readyTaskRead(),
          status: "pending",
          watermark: 1,
          sourceRevision: 2,
        }) as unknown as TaskProjection,
        { taskId: "task_ready" },
      ),
    (error: unknown) => (error as { readonly code?: unknown }).code === "content_not_ready",
  );
  assert.throws(
    () =>
      listProjectedTaskDocuments(tmpdir(), projectionOf(missingTaskRead()) as unknown as TaskProjection, {
        taskId: "task_missing",
      }),
    (error: unknown) => (error as { readonly code?: unknown }).code === "task_not_found",
  );
  assert.throws(
    () =>
      listProjectedTaskDocuments(
        tmpdir(),
        projectionOf({ ...readyTaskRead(), packagePath: null }) as unknown as TaskProjection,
        { taskId: "task_ready" },
      ),
    (error: unknown) => (error as { readonly code?: unknown }).code === "content_not_ready",
  );
});

function readyTaskRead(): TaskRead {
  return {
    status: "ready",
    snapshot: { revision: 2, task: {}, lease: null, executions: [] },
    packagePath: "tasks/task_ready",
    watermark: 2,
    sourceRevision: 2,
    warnings: [],
    catchUp: { maxItems: 1, reducedItems: 1, sqliteTransactions: 1 },
  } as unknown as TaskRead;
}

test("task completion read settles lagging, absent, and unpackaged tasks via the shared judgment", () => {
  assert.throws(
    () =>
      readTaskCompletion(
        projectionOf({ ...readyTaskRead(), status: "pending", watermark: 1, sourceRevision: 2 }),
        "task_ready",
      ),
    (error: unknown) => (error as { readonly code?: unknown }).code === "content_not_ready",
  );
  assert.throws(
    () => readTaskCompletion(projectionOf(missingTaskRead()), "task_missing"),
    (error: unknown) => (error as { readonly code?: unknown }).code === "task_not_found",
  );
  assert.throws(
    () => readTaskCompletion(projectionOf({ ...readyTaskRead(), packagePath: null }), "task_ready"),
    (error: unknown) => (error as { readonly code?: unknown }).code === "content_not_ready",
  );
});
