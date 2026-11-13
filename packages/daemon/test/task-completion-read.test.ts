// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  type TaskProjection,
  emptyTaskLifecycleSnapshot,
  reduceTaskEvent,
  taskCompletionNext,
} from "@harness-anything/kernel";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { readTaskCompletion } from "../src/task-completion-read.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";
import { readyCut } from "./task-query-read.fixtures.ts";

test("single-task completion read carries the canonical next and validates its read cut", () => {
  const snapshot = reduceTaskEvent(
      {
        revision: 0,
        task: null,
        executions: [],
        reviews: [],
        consents: [],
        gateWitnesses: [],
        edgesTaken: [],
        lease: null,
      },
      lifecycleFixture().events[0]!,
    ),
    taskId = snapshot.task!.taskId,
    reads: string[] = [],
    projection = {
      read: (id: string) => {
        reads.push(id);
        return { ...readyCut, snapshot, packagePath: "tasks/task-1" };
      },
      readPresetSnapshot: () => ({ snapshot: null, status: "ready" }),
      readTaskChildCounts: () => ({}),
      getEntity: () => null,
      readDocument: (documentPath: string) => ({
        ...readyCut,
        document: {
          body: documentPath.endsWith("task-contract.json")
            ? JSON.stringify({
                documents: [
                  {
                    slot: "task.closeout",
                    path: "closeout.md",
                    templateRef: "template://planning/closeout@1",
                    locale: "en-US",
                  },
                ],
              })
            : "",
        },
      }),
      readRelationQuery: () => ({ ...readyCut, rows: [] }),
    } as unknown as TaskProjection,
    result = readTaskCompletion(projection, taskId);
  const canonical = taskCompletionNext(snapshot, {
    closeout: "ready",
    closeoutPath: "tasks/task-1/closeout.md",
    eligibleDirtyPaths: [],
    projectionStatus: "ready",
  });
  assert.ok(reads.length > 0);
  assert.ok(
    reads.every((id) => id === taskId),
    "only the selected task is read",
  );
  assert.deepEqual(result.completionNext, canonical.next);
  assert.deepEqual(
    result.completionBlocker,
    canonical.blocker === null ? null : { code: canonical.blocker.code, gate: canonical.blocker.gate },
  );
  assert.equal(result.completionNext?.action, `ha task start ${taskId}`);
  assert.deepEqual(parseDaemonGuiReadResult("repo.tasks.completion.read", result), result);
  assert.throws(
    () =>
      parseDaemonGuiReadResult("repo.tasks.completion.read", {
        ...result,
        completionNext: { ...result.completionNext, readCut: { revision: "wrong" } },
      }),
    /completionNext/,
  );
  assert.throws(
    () =>
      parseDaemonGuiReadResult("repo.tasks.completion.read", {
        ...result,
        completionBlocker: { code: "review_pending" },
      }),
    /completionBlocker/,
  );
  assert.throws(
    () => parseDaemonGuiReadResult("repo.tasks.completion.read", { ...result, completionNext: null }),
    /completionBlocker/,
  );
  assert.throws(() => parseDaemonGuiReadResult("repo.tasks.completion.read", { ok: true, taskId }));
  assert.deepEqual(
    parseDaemonGuiReadResult("repo.tasks.completion.read", {
      ok: true,
      taskId,
      completionNext: null,
      completionBlocker: null,
      factRetirement: null,
    }),
    { ok: true, taskId, completionNext: null, completionBlocker: null, factRetirement: null },
  );
  const legacy = { ok: true, taskId, completionNext: null, completionBlocker: null };
  assert.deepEqual(parseDaemonGuiReadResult("repo.tasks.completion.read", legacy), legacy);
  assert.throws(
    () =>
      parseDaemonGuiReadResult("repo.tasks.completion.read", {
        ...legacy,
        factRetirement: { undischarged: [{ factRef: 1 }] },
      }),
    /factRetirement/,
  );
});

test("a ready submitted low-risk cut exposes ha task complete instead of a null next", () => {
  const submitted = lifecycleFixture({
      closeoutGates: { review: false, consent: false, factDisposition: false },
    })
      .events.slice(0, 3)
      .reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot()),
    snapshot = {
      ...submitted,
      executions: submitted.executions.map((execution) =>
        execution.submission ? { ...execution, submission: { ...execution.submission, commitSha: null } } : execution,
      ),
    },
    taskId = snapshot.task!.taskId,
    projection = {
      read: () => ({ ...readyCut, snapshot, packagePath: "tasks/task-1" }),
      readPresetSnapshot: () => ({ snapshot: null, status: "ready" }),
      readTaskChildCounts: () => ({}),
      getEntity: () => null,
      readDocument: (documentPath: string) => ({
        ...readyCut,
        document: {
          body: documentPath.endsWith("task-contract.json")
            ? JSON.stringify({
                documents: [
                  {
                    slot: "task.closeout",
                    path: "closeout.md",
                    templateRef: "template://planning/closeout@1",
                    locale: "en-US",
                  },
                ],
              })
            : "",
        },
      }),
      readRelationQuery: () => ({ ...readyCut, rows: [] }),
    } as unknown as TaskProjection,
    result = readTaskCompletion(projection, taskId);
  assert.equal(result.completionBlocker, null);
  assert.equal(result.completionNext?.action, `ha task complete ${taskId}`);
  assert.match(result.completionNext?.reason ?? "", /lifted independent review and consent/u);
  assert.deepEqual(parseDaemonGuiReadResult("repo.tasks.completion.read", result), result);
});
