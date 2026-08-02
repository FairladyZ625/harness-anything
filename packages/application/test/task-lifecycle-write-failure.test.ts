// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  type ArtifactStore,
  type TaskPackageRead
} from "../../kernel/src/index.ts";
import { makeTaskLifecycleOrchestrator, type TaskLifecycleWriter } from "../src/task-lifecycle-orchestrator.ts";
import { runEffect } from "./effect-test-helpers.ts";

test("task lifecycle orchestrator exposes no completion mutation authority", () => {
  const orchestrator = makeTaskLifecycleOrchestrator({
    rootDir: "/unused",
    taskWriter: successfulWriter(),
    artifactStore: inMemoryTaskPackageStore("task-1", {})
  });

  assert.equal("completeTask" in orchestrator, false);
});

test("setTaskStatus rejects a scaffold task plan before writing active status", async () => {
  let statusWriteCount = 0;
  const writer: TaskLifecycleWriter = {
    ...successfulWriter(),
    setStatus: (input) => {
      statusWriteCount += 1;
      return Effect.succeed({ taskId: input.taskId, status: input.status });
    }
  };
  const orchestrator = makeTaskLifecycleOrchestrator({
    rootDir: "/unused",
    taskWriter: writer,
    artifactStore: inMemoryTaskPackageStore("task-1", {
      "task_plan.md": "# Plan\n\n## Goal\n\nDescribe the result.\n\n## Verification\n\nList the checks.\n"
    }),
    documentPlaceholderPolicy: placeholderPolicy([[
      { anchor: "## Goal", body: "Describe the result." },
      { anchor: "## Verification", body: "List the checks." }
    ]])
  });

  const result = await runEffect(orchestrator.setTaskStatus({ taskId: "task-1", status: "active" }));

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "task_plan_placeholder");
    assert.match(result.error.hint, /task_plan\.md/u);
  }
  assert.equal(statusWriteCount, 0);
});

test("setTaskStatus rejects a generic in_review transition without an Execution submission", async () => {
  let statusWriteCount = 0;
  const writer: TaskLifecycleWriter = {
    ...successfulWriter(),
    setStatus: (input) => {
      statusWriteCount += 1;
      return Effect.succeed({ taskId: input.taskId, status: input.status });
    }
  };
  const orchestrator = makeTaskLifecycleOrchestrator({
    rootDir: "/unused",
    taskWriter: writer,
    artifactStore: inMemoryTaskPackageStore("task-1", {
      "task_plan.md": "# Plan\n\n## Goal\n\nDescribe the result.\n\n## Verification\n\nList the checks.\n"
    }),
    documentPlaceholderPolicy: placeholderPolicy([[
      { anchor: "## Goal", body: "Describe the result." },
      { anchor: "## Verification", body: "List the checks." }
    ]])
  });

  const result = await runEffect(orchestrator.setTaskStatus({ taskId: "task-1", status: "in_review" }));

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_transition");
    assert.match(result.error.hint, /Execution.*submit/iu);
  }
  assert.equal(statusWriteCount, 0);
});

test("setTaskStatus rejects a generic exit from in_review without an Execution Review", async () => {
  let statusWriteCount = 0;
  const writer: TaskLifecycleWriter = {
    ...successfulWriter(),
    setStatus: (input) => {
      statusWriteCount += 1;
      return Effect.succeed({ taskId: input.taskId, status: input.status });
    }
  };
  const orchestrator = makeTaskLifecycleOrchestrator({
    rootDir: "/unused",
    taskWriter: writer,
    artifactStore: inMemoryTaskPackageStore("task-1", {
      "INDEX.md": [
        "---",
        "lifecycle:",
        "  engine: local",
        "  status: in_review",
        "---",
        ""
      ].join("\n"),
      "task_plan.md": "# Plan\n\n## Goal\n\nShip the mandatory Execution Review path.\n"
    })
  });

  for (const status of ["active", "blocked"] as const) {
    const result = await runEffect(orchestrator.setTaskStatus({ taskId: "task-1", status }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "invalid_transition");
  }
  assert.equal(statusWriteCount, 0);
});

test("startTaskReview cannot create in_review outside the Execution submission transaction", async () => {
  let statusWriteCount = 0;
  const writer: TaskLifecycleWriter = {
    ...successfulWriter(),
    setStatus: (input) => {
      statusWriteCount += 1;
      return Effect.succeed({ taskId: input.taskId, status: input.status });
    }
  };
  const orchestrator = makeTaskLifecycleOrchestrator({
    rootDir: "/unused",
    taskWriter: writer,
    artifactStore: inMemoryTaskPackageStore("task-1", {})
  });

  const result = await runEffect(orchestrator.startTaskReview({ taskId: "task-1" }));

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "execution_submission_required");
    assert.match(result.error.hint, /Execution.*submit/iu);
  }
  assert.equal(statusWriteCount, 0);
});

test("setTaskStatus accepts active when a scaffold section contains substantive additions", async () => {
  const orchestrator = makeTaskLifecycleOrchestrator({
    rootDir: "/unused",
    taskWriter: successfulWriter(),
    artifactStore: inMemoryTaskPackageStore("task-1", {
      "task_plan.md": "# Plan\n\n## Goal\n\nDescribe the result.\nShip the active transition gate.\n\n## Verification\n\nList the checks.\n"
    }),
    documentPlaceholderPolicy: placeholderPolicy([[
      { anchor: "## Goal", body: "Describe the result." },
      { anchor: "## Verification", body: "List the checks." }
    ]])
  });

  const result = await runEffect(orchestrator.setTaskStatus({ taskId: "task-1", status: "active" }));

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.status, "active");
});

test("reviewTask accepts zero Facts through ArtifactStore under dec_mrg3z1we/CH4", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-artifact-store-"));
  try {
    writeIndexOnly(rootDir, "task-1", "Review Task", "in_review");
    const orchestrator = makeTaskLifecycleOrchestrator({
      rootDir,
      taskWriter: successfulWriter(),
      artifactStore: inMemoryTaskPackageStore("task-1", {
        // dec_mrg3z1we/CH4: review reads its contract without imposing a Fact quantity gate.
        "review.md": validReview()
      }),
      now: () => "2026-06-13T00:00:00.000Z"
    });

    const result = await runEffect(orchestrator.reviewTask({ taskId: "task-1", reviewerId: "reviewer-a" }));

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.reviewContract.schema, "verifier-backed-review/v1");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function successfulWriter(): TaskLifecycleWriter {
  return {
    setStatus: (input) => Effect.succeed({ taskId: input.taskId, status: input.status }),
    appendProgress: (input) => Effect.succeed({ taskId: input.taskId, path: "progress.md", appended: input.text }),
    stageDocument: (input) => Effect.succeed({ taskId: input.taskId, path: input.path }),
    stageTaskTree: (input) => Effect.succeed({ taskId: input.taskId, path: "." }),
    taskTreeStatus: (taskId) => Effect.succeed({ taskId, dirty: false, entries: [] })
  };
}

function placeholderPolicy(taskPlanPlaceholderFingerprintSets: ReadonlyArray<ReadonlyArray<{ readonly anchor: string; readonly body: string }>>) {
  return {
    closeoutPlaceholderFingerprints: [],
    taskPlanPlaceholderFingerprintSets,
    visualMapPlaceholderFingerprintSets: [],
    lessonCandidatesPlaceholderFingerprintSets: []
  };
}

function inMemoryTaskPackageStore(taskId: string, documents: Record<string, string>): Pick<ArtifactStore, "readTaskPackage"> {
  const taskPackage = {
    taskId,
    disposition: "active",
    documents: Object.entries(documents).map(([documentPath, body]) => ({
      path: documentPath,
      body,
      sha256: `sha256:${documentPath}`
    }))
  } satisfies TaskPackageRead;
  return {
    readTaskPackage: (requestedTaskId) => requestedTaskId === taskId
      ? Effect.succeed(taskPackage)
      : Effect.fail({ _tag: "TaskPackageNotFound", taskId: requestedTaskId })
  };
}

function validReview(): string {
  return [
    "# Review",
    "",
    "| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ""
  ].join("\n");
}

function writeIndexOnly(
  rootDir: string,
  directoryName: string,
  title: string,
  status: string,
  vertical = "default",
  preset = "default"
): void {
  mkdirSync(path.join(rootDir, "harness/tasks", directoryName), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness/tasks", directoryName, "INDEX.md"),
    taskIndexBody(directoryName, title, status, vertical, preset),
    "utf8"
  );
}

function taskIndexBody(
  taskId: string,
  title: string,
  status: string,
  vertical = "default",
  preset = "default"
): string {
  return [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    `  status: ${status}`,
    "  ref: ",
    `  titleSnapshot: ${title}`,
    "  url: ",
    "  bindingCreatedAt: 2026-06-12T00:00:00.000Z",
    "  bindingFingerprint: sha256:4d1771ef6e83619eb8a82f1593bf118383084665fc58f634072d379178d525d7",
    "packageDisposition: active",
    `vertical: ${vertical}`,
    `preset: ${preset}`,
    "provenance:",
    "  - {runtime: \"human\", sessionId: \"human-cli-1783036800000\", boundAt: \"2026-06-12T00:00:00.000Z\"}",
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n");
}
