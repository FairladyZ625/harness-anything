// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  REPLAY_TASK_GRAPH,
  applyTransition,
  compileTaskProgress,
  makeTaskEventStore,
  makeTaskProjection,
  normalizeTaskLifecycleCommand,
  parseCanonicalEvent,
  sha256Text,
  stableStringify,
  taskBootstrapWritePlan,
  taskLifecycleWritePlan,
  type TaskBootstrapBlob,
  type TaskBootstrapEventV1,
  type TaskEventV1,
} from "../../src/index.ts";
import { emptyTaskLifecycleSnapshot } from "../../src/domain/task-lifecycle.contract.ts";
import type { CanonicalWriteBundle } from "../../src/store/task-event-store.ts";

const actor = {
    principal: { personId: "person-progress" },
    executor: { kind: "agent", id: "codex" },
  } as const,
  source = "local" as const,
  packagePath = "tasks/task-progress-progress";

import { withDatabase } from "../../src/projection/rebuildable-task-projection-database.ts";
import { projectProgress } from "../../src/projection/rebuildable-task-projection-write-model.ts";

test("historically accepted delegated progress remains replayable", async () => {
  const rootDir = workspace(),
    { store, projection, start } = bootstrapAndStart(rootDir);
  try {
    const runtimeActor = {
      principal: actor.principal,
      executor: { kind: "agent", id: "runtime-session:runtime-progress" },
    } as const;
    const runtimeBinding = {
      runtimeSessionId: "runtime-progress",
      taskId: start.taskId,
      executionId: start.payload.lease.executionId,
    };
    // Construct the already-accepted event shape. The persisted lease remains coordinator-held,
    // as accepted before command admission required the runtime to hold the lease itself.
    const compiled = compileTaskProgress({
      ...domainFixture(),
      actor: runtimeActor,
      activeLease: { ...start.payload.lease, actor: runtimeActor },
      runtimeBinding,
    });
    withDatabase(
      projection.path,
      () => store.readHead(),
      (db) => {
        db.prepare("INSERT INTO runtime_session(runtime_session_id,workspace_revision,value_json) VALUES (?,?,?)").run(
          runtimeBinding.runtimeSessionId,
          2,
          JSON.stringify({ runtimeSessionId: runtimeBinding.runtimeSessionId, taskBindings: [runtimeBinding] }),
        );
        const readBlob = (sha: string) => {
          const blob = compiled.blobs.find((entry) => entry.sha256 === sha);
          return blob ? new TextEncoder().encode(blob.body) : null;
        };
        const replay = (event: typeof compiled.event) => projectProgress(db, event, JSON.stringify(event), readBlob);
        assert.deepEqual(parseCanonicalEvent(JSON.stringify(compiled.event)), compiled.event);
        assert.throws(
          () =>
            parseCanonicalEvent(
              JSON.stringify({
                ...compiled.event,
                actor,
              }),
            ),
          /invalid/u,
          "runtime actor must still match the event runtime identity",
        );
        for (const payload of [
          { ...compiled.event.payload, executionId: "missing-execution" },
          { ...compiled.event.payload, taskId: "missing-task" },
          { ...compiled.event.payload, runtimeSessionId: "missing-runtime" },
          {
            ...compiled.event.payload,
            resultDocumentClaim: {
              ...compiled.event.payload.resultDocumentClaim,
              path: "tasks/task-progress-other/progress.md",
            },
          },
        ])
          assert.throws(() => replay({ ...compiled.event, payload }), /reference mismatch/u);
        assert.throws(
          () =>
            replay({
              ...compiled.event,
              payload: {
                ...compiled.event.payload,
                baseDocumentSha256: "a".repeat(64),
              },
            }),
          /base or blob mismatch/u,
        );
        assert.throws(
          () => projectProgress(db, compiled.event, JSON.stringify(compiled.event), () => null),
          /base or blob mismatch/u,
        );
        assert.throws(
          () => projectProgress(db, compiled.event, JSON.stringify(compiled.event), () => new Uint8Array(1)),
          /base or blob mismatch/u,
        );
        assert.doesNotThrow(() => replay(compiled.event));
        const document = db.prepare("SELECT value_json FROM document WHERE path = ?").get(compiled.path);
        assert.equal(JSON.parse(String(document?.value_json)).body, compiled.body);
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_progress").get()?.count, 1);
      },
    );
  } finally {
    projection.close();
    await store.drain();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
function bootstrapAndStart(rootDir: string) {
  const store = makeTaskEventStore({ repoId: "progress", rootDir }),
    projection = makeTaskProjection({ rootDir, eventStore: store }),
    { event, blobs } = bootstrap();
  store.append({ event, plan: taskBootstrapWritePlan(event), blobs });
  projection.apply(event, taskBootstrapWritePlan(event));
  const snapshot = {
      ...emptyTaskLifecycleSnapshot(1),
      task: event.payload.task,
    },
    command = {
      ...normalizeTaskLifecycleCommand(
        { workspaceId: "progress", actor, source, expectedRevision: 1 },
        {
          type: "StartExecution",
          taskId: event.taskId,
          executionId: "execution-progress",
        },
      ),
      eventId: "event-start",
      workspaceRevision: 2,
      occurredAt: "2026-08-13T00:01:00.000Z",
    },
    start = applyTransition(snapshot, command, {
      actorBinding: actor,
      deliveryBaseline: { kind: "commit", commitSha: "0".repeat(40) },
      reservation: {
        taskId: event.taskId,
        executionId: "execution-progress",
        expiresAt: "2026-08-13T01:00:00.000Z",
        ttlMs: 1_800_000,
        previousHolder: null,
        reason: "initial_claim",
        version: 0,
      },
    }).event;
  store.append(taskBundle(start));
  projection.apply(start);
  return {
    store,
    projection,
    start: start as Extract<TaskEventV1, { readonly type: "execution_started" }>,
  };
}
function bootstrap(): {
  readonly event: TaskBootstrapEventV1;
  readonly blobs: readonly TaskBootstrapBlob[];
} {
  const snapshot = { schema: "preset-snapshot/v1", id: "progress" },
    digest = `sha256:${sha256Text(stableStringify(snapshot))}` as const,
    snapshotBody = `${stableStringify({ ...snapshot, digest })}\n`,
    snapshotSha = sha256Text(snapshotBody),
    planBody = "# Plan\n",
    planSha = sha256Text(planBody),
    event: TaskBootstrapEventV1 = {
      schema: "task-bootstrap-event/v1",
      eventId: "event-bootstrap",
      workspaceRevision: 1,
      opId: "op-bootstrap",
      taskId: "task-progress",
      type: "task_bootstrapped",
      actor,
      source,
      occurredAt: "2026-08-13T00:00:00.000Z",
      payload: {
        task: {
          schema: "task/v2",
          taskId: "task-progress",
          title: "Progress",
          taskClass: "standard",
          status: "planned",
          graph: REPLAY_TASK_GRAPH,
          currentNode: "implementation",
          iteration: 0,
          createdBy: actor,
          completionGateIds: [],
          presetSnapshotDigest: digest,
          pinned: false,
        },
        presetSnapshotClaim: {
          digest,
          sha256: snapshotSha,
          size: Buffer.byteLength(snapshotBody),
          mediaType: "application/json",
        },
        initialDocumentClaims: [
          {
            path: `${packagePath}/task_plan.md`,
            sha256: planSha,
            size: Buffer.byteLength(planBody),
            mediaType: "text/markdown",
            owner: "doc-sync",
            policyId: "markdown-body-replaceable/v1",
          },
        ],
      },
    };
  return {
    event,
    blobs: [
      { ...event.payload.presetSnapshotClaim, body: snapshotBody },
      { ...event.payload.initialDocumentClaims[0]!, body: planBody },
    ],
  };
}
function domainFixture() {
  return {
    taskId: "task-progress",
    executionId: "execution-progress",
    packagePath,
    text: "Exact progress text.",
    evidence: [{ type: "commit", path: "reports/result.txt", summary: "verified" }],
    expectedBaseSha256: null,
    currentDocument: null,
    activeLease: {
      schema: "lease/v1",
      taskId: "task-progress",
      executionId: "execution-progress",
      actor,
      source,
      phase: "held",
      expiresAt: "2026-08-13T01:00:00.000Z",
      ttlMs: 1_800_000,
      version: 0,
    } as const,
    startRecoveryAvailable: true,
    actor,
    source,
    eventId: "event-progress",
    opId: "op-progress",
    workspaceRevision: 3,
    occurredAt: "2026-08-13T00:02:00.000Z",
  };
}
function taskBundle(event: TaskEventV1): CanonicalWriteBundle {
  return { event, plan: taskLifecycleWritePlan(event), blobs: [] };
}
function workspace(): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-progress-"));
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Progress Test");
  git(rootDir, "config", "user.email", "progress@example.invalid");
  git(rootDir, "commit", "--allow-empty", "-qm", "base");
  return rootDir;
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
  }).trim();
}
