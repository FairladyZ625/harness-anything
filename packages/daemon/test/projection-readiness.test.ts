// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TaskProjection } from "@harness-anything/kernel";
import { listProjectedTaskDocuments, readProjectedDocument } from "../src/doc-sync-reads.ts";
import { requireCurrentTaskProjection } from "../src/projection-readiness.ts";
import { attestGateWitness } from "../src/repo-cell-witness-adapters.ts";
import { annotateExecution, declareExecutionExecutor } from "../src/repo-cell-action-dispatch.ts";
import { projectionReady, requiredCellText } from "../src/repo-cell-settlement.ts";
import { readTaskCompletion } from "../src/task-completion-read.ts";
import type { RepoCellOperationalContext } from "../src/repo-cell-action-context.ts";
import { runFactAction } from "../src/repo-cell-fact-action.ts";
import { initRepo } from "./task-surface.fixtures.ts";
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

// fact record resolves its observation commit against a real checkout HEAD.
const observationRoot = mkdtempSync(path.join(tmpdir(), "ha-projection-readiness-"));
initRepo(observationRoot);
test.after(() => rmSync(observationRoot, { recursive: true, force: true }));

function factCell(read: TaskRead) {
  const projection = projectionOf(read),
    executed: string[] = [],
    cell = {
      rootDir: observationRoot,
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
        dispatchKey: "lagging-projection",
      },
      binding,
    ),
    (error: unknown) => (error as { readonly code?: unknown }).code === "content_not_ready",
  );
  assert.equal(projection.reads(), 1);
});

test("task-bound runtime dispatch requires an authorization decision", async () => {
  const projection = {
      ...projectionOf(readyTaskRead()),
      currentLease: () => null,
    },
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
        dispatchKey: "missing-authorization",
      },
      binding,
    ),
    (error: unknown) =>
      (error as { readonly code?: unknown }).code === "authorization_missing" &&
      (error as Error).message === "Runtime dispatch requires the center AuthorizationPort decision.",
  );
});

test("runtime dispatch does not replay-check an opId occupied by another canonical event", async () => {
  const repoId = "repository",
    dispatchKey = "occupied-dispatch-op",
    dispatchOpId = "runtime-spawn-occupied-by-another-event",
    reads: string[] = [],
    spawner = makeRuntimeSpawner({
      repoId,
      rootDir: tmpdir(),
      store: () => ({
        readEvent: (opId: string) => {
          reads.push(opId);
          return opId === dispatchOpId ? { type: "task_created", opId } : null;
        },
      }),
      projection: () => ({
        readRuntimeSessions: () => [],
        getEntity: (kind: string, id: string) =>
          kind === "settings" && id === "repository"
            ? { value: { runtime: { allowedInstances: ["worker"] } } }
            : undefined,
      }),
      runtimeInstances: () => [
        {
          instanceId: "worker",
          name: "Worker",
          kindId: "codex",
          models: ["gpt-5.6-sol"],
          defaultModel: "gpt-5.6-sol",
          enabled: true,
          authMode: "subscription",
          authReadiness: { status: "ready", code: null, hint: null },
          permissionMode: "bypass",
        },
      ],
      prepareLaunch: async () => {
        throw new Error("stop at the launch boundary");
      },
      now: () => "2026-09-10T00:00:00.000Z",
    } as unknown as RuntimeSpawnerInput);
  await assert.rejects(
    spawner.spawn(
      {
        runtimeInstanceId: "worker",
        cwd: { scope: "repo-root" },
        prompt: "Inspect",
        taskId: null,
        dispatchKey,
      },
      binding,
    ),
    (error: unknown) => (error as Error).message === "stop at the launch boundary",
  );
  assert.deepEqual(reads, []);
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

// Task-id write commands settle through one judgment: an id absent from both the current
// projection and the canonical event stream answers task_not_found naming the repository that was
// searched — a wrong-directory invocation sees which repository resolved — while a projection
// merely behind, and a snapshot row lost while its canonical events remain, keep each command's
// own content_not_ready readiness answer.
function writeCommandCell(read: TaskRead, taskEventExists = false) {
  return {
    rootDir: "/repos/canonical-checkout",
    input: { repoId: "canonical" },
    projection: { read: () => read, readTaskEventExists: () => taskEventExists },
    projectionReady,
    requiredCellText,
    explicitExecutionId: () => null,
    cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  } as unknown as RepoCellOperationalContext;
}

function writeCommandRuns(cell: RepoCellOperationalContext, taskId: string) {
  return [
    () => attestGateWitness(cell, { kind: "task-attest", taskId, gateId: "signoff", result: "pass" }, binding),
    () => declareExecutionExecutor(cell, { kind: "task-declare-executor", taskId, reason: "reassign" }, binding),
    () => annotateExecution(cell, { kind: "task-annotate", taskId, executionId: "execution_1", note: "note" }, binding),
  ];
}

test("task-id write commands answer a missing id with task_not_found naming the repository", () => {
  const cell = writeCommandCell(missingTaskRead());
  for (const run of writeCommandRuns(cell, "task_missing")) {
    assert.throws(run, (error: unknown) => {
      const coded = error as { readonly code?: unknown; readonly message?: unknown };
      assert.equal(coded.code, "task_not_found");
      assert.equal(
        coded.message,
        "Task task_missing does not exist in the canonical event stream of repository canonical at /repos/canonical-checkout.",
      );
      return true;
    });
  }
});

test("a projection merely behind keeps the write commands' content_not_ready answer", () => {
  const cell = writeCommandCell({ ...readyTaskRead(), status: "pending", watermark: 1, sourceRevision: 2 });
  for (const run of writeCommandRuns(cell, "task_ready")) {
    assert.throws(run, (error: unknown) => (error as { readonly code?: unknown }).code === "content_not_ready");
  }
});

test("a snapshot row lost while its canonical events remain keeps the write commands' content_not_ready answer", () => {
  const cell = writeCommandCell(missingTaskRead(), true);
  for (const run of writeCommandRuns(cell, "task_missing")) {
    assert.throws(run, (error: unknown) => (error as { readonly code?: unknown }).code === "content_not_ready");
  }
});
