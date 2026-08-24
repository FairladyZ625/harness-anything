// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
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
  sha256Text,
  stableStringify,
  taskBootstrapWritePlan,
  taskLifecycleWritePlan,
  type TaskBootstrapBlob,
  type TaskBootstrapEventV1,
  type TaskEventV1,
} from "../../src/index.ts";
import { emptyTaskLifecycleSnapshot } from "../../src/domain/task-lifecycle.contract.ts";
import { validateTaskProgressEvent } from "../../src/domain/task-progress-event.ts";
import type { CanonicalWriteBundle } from "../../src/store/task-event-store.ts";

const actor = {
    principal: { personId: "person-progress" },
    executor: { kind: "agent", id: "codex" },
  } as const,
  source = "local" as const,
  packagePath = "tasks/task-progress-progress",
  progressPath = `${packagePath}/progress.md`;

test("progress compiler rejects invalid evidence, lease mismatches, and stale bases before publication", () => {
  const fixture = domainFixture(),
    before = stableStringify(fixture);
  assert.throws(
    () =>
      compileTaskProgress({
        ...fixture,
        evidence: [{ type: "test", path: "../escape", summary: "bad" }],
      }),
    (error: unknown) => code(error) === "invalid_progress",
  );
  assert.throws(
    () => compileTaskProgress({ ...fixture, activeLease: null }),
    (error: unknown) => code(error) === "progress_lease_required",
  );
  assert.throws(
    () => compileTaskProgress({ ...fixture, executionId: "other" }),
    (error: unknown) => code(error) === "progress_lease_mismatch",
  );
  assert.throws(
    () =>
      compileTaskProgress({
        ...fixture,
        actor: { principal: { personId: "other" }, executor: null },
      }),
    (error: unknown) => code(error) === "progress_lease_mismatch",
  );
  const runtimeActor = {
      principal: fixture.actor.principal,
      executor: { kind: "agent", id: "runtime-session:runtime-progress" },
    } as const,
    runtimeBinding = {
      runtimeSessionId: "runtime-progress",
      taskId: fixture.taskId,
      executionId: fixture.executionId,
    },
    runtime = compileTaskProgress({
      ...fixture,
      actor: runtimeActor,
      runtimeBinding,
    });
  assert.equal(runtime.event.payload.runtimeSessionId, "runtime-progress");
  assert.deepEqual(runtime.event.actor, runtimeActor);
  assert.deepEqual(validateTaskProgressEvent(runtime.event), []);
  assert.throws(
    () => compileTaskProgress({ ...fixture, actor: runtimeActor }),
    (error: unknown) => code(error) === "progress_lease_mismatch",
  );
  assert.throws(
    () =>
      compileTaskProgress({
        ...fixture,
        actor: runtimeActor,
        runtimeBinding: {
          ...runtimeBinding,
          runtimeSessionId: "other-runtime",
        },
      }),
    (error: unknown) => code(error) === "progress_lease_mismatch",
  );
  assert.throws(
    () =>
      compileTaskProgress({
        ...fixture,
        actor: {
          principal: { personId: "other" },
          executor: runtimeActor.executor,
        },
        runtimeBinding,
      }),
    (error: unknown) => code(error) === "progress_lease_mismatch",
  );
  assert.throws(
    () =>
      compileTaskProgress({
        ...fixture,
        currentDocument: {
          path: progressPath,
          blobSha256: "a".repeat(64),
          body: "# old\n",
        },
        expectedBaseSha256: "b".repeat(64),
      }),
    (error: unknown) => code(error) === "stale_progress_base",
  );
  assert.equal(stableStringify(fixture), before);
  const compiled = compileTaskProgress(fixture);
  assert.deepEqual(validateTaskProgressEvent(compiled.event), []);
  assert.notDeepEqual(
    validateTaskProgressEvent({
      ...compiled.event,
      payload: {
        ...compiled.event.payload,
        resultDocumentClaim: {
          ...compiled.event.payload.resultDocumentClaim,
          path: `${packagePath}/facts.md`,
        },
      },
    }),
    [],
  );
});

test("three progress bundles preserve every old byte and ordered duplicate evidence across worktree materialize and L2 rebuild", () => {
  const rootDir = workspace();
  try {
    const { store, projection, start } = bootstrapAndStart(rootDir),
      texts = [
        "First exact entry.",
        "Second exact entry.\nwith another line",
        "Third exact entry.",
      ],
      evidence = [
        { type: "test", path: "reports/check.txt", summary: "same evidence" },
        { type: "test", path: "reports/check.txt", summary: "same evidence" },
      ];
    let previous: string | null = null;
    for (const [index, text] of texts.entries()) {
      const current = projection.readDocument(progressPath).document,
        compiled = compileTaskProgress({
          ...domainFixture(),
          text,
          evidence: index === 1 ? evidence : [],
          eventId: `event-progress-${index + 1}`,
          opId: `op-progress-${index + 1}`,
          workspaceRevision: index + 3,
          occurredAt: `2026-08-13T00:0${index + 2}:00.000Z`,
          expectedBaseSha256: current?.blobSha256 ?? null,
          currentDocument: current
            ? {
                path: progressPath,
                blobSha256: current.blobSha256,
                body: current.body,
              }
            : null,
          activeLease: start.payload.lease,
        });
      assert.equal(
        compiled.body.startsWith(previous ?? "# Progress\n\n## Entries\n\n"),
        true,
      );
      store.append(compiled);
      projection.apply(compiled.event, compiled.plan);
      previous = compiled.body;
    }
    const body = readFileSync(
      path.join(rootDir, "harness", progressPath),
      "utf8",
    );
    assert.equal(body, previous);
    assert.equal(
      texts.every(
        (text, index) =>
          body.indexOf(text) >= (index ? body.indexOf(texts[index - 1]!) : 0),
      ),
      true,
    );
    assert.equal(
      body.match(/Evidence: test:reports\/check\.txt:same evidence/gu)?.length,
      2,
    );
    assert.deepEqual(
      projection
        .readProgress("task-progress")
        .rows.map((event) => event.payload.text),
      texts,
    );
    unlinkSync(path.join(rootDir, "harness", progressPath));
    assert.deepEqual(store.materialize().changed, [progressPath]);
    assert.equal(
      readFileSync(path.join(rootDir, "harness", progressPath), "utf8"),
      body,
    );
    projection.close();
    rmSync(projection.path, { force: true });
    assert.equal(projection.rebuild().watermark, 5);
    assert.equal(projection.readDocument(progressPath).document?.body, body);
    assert.deepEqual(
      projection
        .readProgress("task-progress")
        .rows.map((event) => event.payload.evidence),
      [[], evidence, []],
    );
    projection.close();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("progress publication recovers after prepared HEAD and retry does not duplicate the event or file entry", () => {
  const rootDir = workspace();
  let initialProjection: ReturnType<typeof makeTaskProjection> | undefined,
    replay: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    const initial = bootstrapAndStart(rootDir);
    initialProjection = initial.projection;
    const { start } = initial,
      compiled = compileTaskProgress({
        ...domainFixture(),
        activeLease: start.payload.lease,
      }),
      interrupted = makeTaskEventStore({
        repoId: "progress",
        rootDir,
        killpoint: (point) => {
          if (point === "after_head_write") throw new Error("kill");
        },
      });
    assert.throws(() => interrupted.append(compiled), /kill/u);
    assert.equal(
      makeTaskEventStore({ repoId: "progress", rootDir }).recover().status,
      "committed",
    );
    const resumed = makeTaskEventStore({ repoId: "progress", rootDir }),
      before = resumed.currentCommit();
    assert.deepEqual(resumed.append(compiled).metrics.changedPaths, []);
    assert.deepEqual(resumed.currentCommit(), before);
    replay = makeTaskProjection({ rootDir, eventStore: resumed });
    replay.rebuild();
    assert.equal(replay.readProgress("task-progress").rows.length, 1);
    assert.equal(
      (
        readFileSync(path.join(rootDir, "harness", progressPath), "utf8").match(
          /Exact progress text/gu,
        ) ?? []
      ).length,
      1,
    );
  } finally {
    replay?.close();
    initialProjection?.close();
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
    start: start as Extract<
      TaskEventV1,
      { readonly type: "execution_started" }
    >,
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
          schema: "task/v1",
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
    evidence: [
      { type: "commit", path: "reports/result.txt", summary: "verified" },
    ],
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
function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
