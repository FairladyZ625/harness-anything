// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeMarkdownArtifactStore, type ArtifactStore, type TaskPackageRead, type VersionControlSystem } from "../../kernel/src/index.ts";
import { makeTaskLifecycleOrchestrator, type TaskLifecycleWriter } from "../src/task-lifecycle-orchestrator.ts";
import { runEffect } from "./effect-test-helpers.ts";

const codeDocSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("completeTask surfaces an Execution transaction failure without falling back to generic status write", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-write-failure-"));
  try {
    let statusWriteCount = 0;
    writeTaskPackage(rootDir, "task-1", "Complete Task");
    writeFact(rootDir, "task-1");
    const orchestrator = makeTaskLifecycleOrchestrator({
      rootDir,
      taskWriter: {
        ...successfulWriter(),
        setStatus: (input) => {
          statusWriteCount += 1;
          return Effect.succeed({ taskId: input.taskId, status: input.status });
        }
      },
      artifactStore: makeMarkdownArtifactStore({ rootDir }),
      completionGateResolver: () => ["ci", "code-doc-reconciliation"],
      codeDocVersionControlSystem: codeDocVersionControlSystem(),
      executionCompletionService: {
        completeTaskExecution: async () => { throw new Error("atomic Execution completion write rejected"); }
      }
    });

    const result = await runEffect(orchestrator.completeTask({
      taskId: "task-1",
      reviewerId: "reviewer-a",
      ciGate: "passed",
      actor: completionActor()
    }));

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "write_rejected");
      assert.match(result.error.hint, /atomic Execution completion write rejected/u);
    }
    assert.equal(statusWriteCount, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
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
    assert.equal(result.error.code, "execution_submission_required");
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
    if (!result.ok) assert.equal(result.error.code, "execution_review_required");
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

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.reviewContract.schema, "verifier-backed-review/v1");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a valid legacy review cannot complete a task without a submitted Execution", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-generic-completion-"));
  try {
    let statusWriteCount = 0;
    writeIndexOnly(rootDir, "task-1", "Writing Task", "in_review", "writing/generic", "writing-task");
    writeCloseout(rootDir, "task-1", ["## Summary", "", "The requested text is complete."]);
    const orchestrator = makeTaskLifecycleOrchestrator({
      rootDir,
      taskWriter: {
        ...successfulWriter(),
        setStatus: (input) => {
          statusWriteCount += 1;
          return Effect.succeed({ taskId: input.taskId, status: input.status });
        }
      },
      artifactStore: inMemoryTaskPackageStore("task-1", {
        "review.md": validReview(),
        "closeout.md": "# Closeout\n\n## Summary\n\nThe requested text is complete.\n"
      }),
      completionGateResolver: () => [],
      executionCompletionService: { completeTaskExecution: async () => null }
    });
    const result = await runEffect(orchestrator.completeTask({
      taskId: "task-1",
      reviewerId: "reviewer-a",
      actor: {
        principal: { personId: "reviewer-a" },
        executor: { kind: "agent", id: "reviewer-agent" },
        responsibleHuman: "person:reviewer-a"
      }
    }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "execution_completion_required");
    assert.equal(statusWriteCount, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("software preset contract continues to require CI", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-software-completion-"));
  try {
    writeTaskPackage(rootDir, "task-1", "Coding Task");
    const orchestrator = makeTaskLifecycleOrchestrator({
      rootDir,
      taskWriter: successfulWriter(),
      artifactStore: makeMarkdownArtifactStore({ rootDir }),
      codeDocVersionControlSystem: codeDocVersionControlSystem(),
      completionGateResolver: () => ["ci", "code-doc-reconciliation"],
      executionCompletionService: successfulExecutionCompletionService()
    });
    const result = await runEffect(orchestrator.completeTask({ taskId: "task-1", reviewerId: "reviewer-a", actor: completionActor() }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "missing_ci_gate");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("completeTask evaluates closeout and review placeholders through ArtifactStore", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-artifact-store-"));
  try {
    writeIndexOnly(rootDir, "task-1", "Complete Task", "in_review");
    writeCloseout(rootDir, "task-1", [
      "## Summary",
      "",
      "Summarize the completed behavior change."
    ]);
    const writer = successfulWriter();
    const orchestrator = makeTaskLifecycleOrchestrator({
      rootDir,
      taskWriter: writer,
      artifactStore: inMemoryTaskPackageStore("task-1", {
        "review.md": validReview(),
        "facts.md": validFact(),
        "code-doc-anchors.json": validCodeDocAnchors(),
        "closeout.md": [
          "# Closeout",
          "",
          "## Summary",
          "",
          "Implemented the task lifecycle ArtifactStore contract.",
          ""
        ].join("\n")
      }),
      completionGateResolver: () => ["ci", "code-doc-reconciliation"],
      documentPlaceholderPolicy: {
        closeoutPlaceholderFingerprints: ["Summarize the completed behavior change."],
        taskPlanPlaceholderFingerprintSets: [],
        visualMapPlaceholderFingerprintSets: [],
        lessonCandidatesPlaceholderFingerprintSets: []
      },
      codeDocVersionControlSystem: codeDocVersionControlSystem(),
      executionCompletionService: successfulExecutionCompletionService(),
      now: () => "2026-06-13T00:00:00.000Z"
    });

    const result = await runEffect(orchestrator.completeTask({ taskId: "task-1", reviewerId: "reviewer-a", ciGate: "passed", actor: completionActor() }));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.status, "done");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("completeTask rejects ArtifactStore closeout placeholders", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-artifact-store-"));
  try {
    writeIndexOnly(rootDir, "task-1", "Complete Task", "in_review");
    const orchestrator = makeTaskLifecycleOrchestrator({
      rootDir,
      taskWriter: successfulWriter(),
      artifactStore: inMemoryTaskPackageStore("task-1", {
        "review.md": validReview(),
        "facts.md": validFact(),
        "closeout.md": [
          "# Closeout",
          "",
          "## Summary",
          "",
          "Summarize the completed behavior change.",
          ""
        ].join("\n")
      }),
      completionGateResolver: () => ["ci", "code-doc-reconciliation"],
      documentPlaceholderPolicy: {
        closeoutPlaceholderFingerprints: ["Summarize the completed behavior change."],
        taskPlanPlaceholderFingerprintSets: [],
        visualMapPlaceholderFingerprintSets: [],
        lessonCandidatesPlaceholderFingerprintSets: []
      },
      executionCompletionService: successfulExecutionCompletionService(),
      now: () => "2026-06-13T00:00:00.000Z"
    });

    const result = await runEffect(orchestrator.completeTask({ taskId: "task-1", reviewerId: "reviewer-a", ciGate: "passed", actor: completionActor() }));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "closeout_placeholder");
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

function successfulExecutionCompletionService() {
  return { completeTaskExecution: async () => ({ executionId: "exe_01KX7H00000000000000000001" }) };
}

function completionActor() {
  return {
    principal: { personId: "reviewer-a" },
    executor: { kind: "agent" as const, id: "reviewer-agent" },
    responsibleHuman: "person:reviewer-a"
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

function validFact(): string {
  return [
    "# Facts",
    "",
    "- {fact_id: F-DEADBEEF, statement: \"Task has verified evidence.\", source: \"test fixture\", observedAt: \"2026-07-04T00:00:00.000Z\", confidence: high, memoryClass: episodic, memoryTags: [], provenance: [{runtime: \"human\", sessionId: \"human-cli-1783036800000\", boundAt: \"2026-07-04T00:00:00.000Z\"}]}",
    ""
  ].join("\n");
}

function validCodeDocAnchors(): string {
  return `${JSON.stringify({
    schema: "code-doc-reconciliation/v1",
    taskId: "task-1",
    records: [{
      id: "A4-001",
      ledgerPath: "closeout.md",
      kind: "closeout",
      anchors: [{ kind: "commit", sha: codeDocSha }]
    }]
  }, null, 2)}\n`;
}

function codeDocVersionControlSystem(): Pick<VersionControlSystem, "normalizePath" | "topLevel" | "commitExists" | "pathExistsAtCommit"> {
  return {
    normalizePath: (inputPath) => inputPath,
    topLevel: (inputPath) => inputPath,
    commitExists: (_repoRoot, sha) => sha === codeDocSha,
    pathExistsAtCommit: () => true
  };
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
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${directoryName}`,
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
  ].join("\n"), "utf8");
}

function writeCloseout(rootDir: string, directoryName: string, lines: ReadonlyArray<string>): void {
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "closeout.md"), ["# Closeout", "", ...lines, ""].join("\n"), "utf8");
}

function writeTaskPackage(rootDir: string, directoryName: string, title: string): void {
  mkdirSync(path.join(rootDir, "harness/tasks", directoryName), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${directoryName}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: in_review",
    "  ref: ",
    `  titleSnapshot: ${title}`,
    "  url: ",
    "  bindingCreatedAt: 2026-06-12T00:00:00.000Z",
    "  bindingFingerprint: sha256:4d1771ef6e83619eb8a82f1593bf118383084665fc58f634072d379178d525d7",
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "provenance:",
    "  - {runtime: \"human\", sessionId: \"human-cli-1783036800000\", boundAt: \"2026-06-12T00:00:00.000Z\"}",
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"), "utf8");
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "review.md"), [
    "# Review",
    "",
    "| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ""
  ].join("\n"), "utf8");
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "closeout.md"), [
    "# Closeout",
    "",
    "## Summary",
    "",
    "Implemented the task lifecycle write-failure passthrough.",
    "",
    "## Verification",
    "",
    "npm run check passed.",
    "",
    "## Residual Risk",
    "",
    "No residual risk accepted.",
    ""
  ].join("\n"), "utf8");
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "code-doc-anchors.json"), validCodeDocAnchors(), "utf8");
}

function writeFact(rootDir: string, directoryName: string): void {
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "facts.md"), [
    "# Facts",
    "",
    "- {fact_id: F-DEADBEEF, statement: \"Task has verified evidence.\", source: \"test fixture\", observedAt: \"2026-07-04T00:00:00.000Z\", confidence: high, memoryClass: episodic, memoryTags: [], provenance: [{runtime: \"human\", sessionId: \"human-cli-1783036800000\", boundAt: \"2026-07-04T00:00:00.000Z\"}]}",
    ""
  ].join("\n"), "utf8");
}
