// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeMarkdownArtifactStore, type ArtifactStore, type EngineError, type TaskPackageRead, type VersionControlSystem, type WriteError } from "../../kernel/src/index.ts";
import { makeTaskLifecycleOrchestrator, type TaskLifecycleWriter } from "../src/task-lifecycle-orchestrator.ts";
import { runEffect } from "./effect-test-helpers.ts";

const codeDocSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// Regression: task-complete must surface the underlying kernel writer error code
// rather than the misleading completion_gate_failed. A stub writer forces setStatus
// to fail after every gate passes, covering the kernel tags whose registered CLI
// error code is NOT their raw PascalCase _tag (previously leaked by the default
// branch and then coerced to completion_gate_failed by cliErrorCode).
const writeFailureCases: ReadonlyArray<{ readonly name: string; readonly error: EngineError | WriteError; readonly code: string }> = [
  {
    name: "TerminalReopenRequiresSupersede",
    error: { _tag: "TerminalReopenRequiresSupersede", taskId: "task-1", status: "done" },
    code: "terminal_reopen_requires_supersede"
  },
  {
    name: "StaleSnapshotRefused",
    error: { _tag: "StaleSnapshotRefused", engine: "local", ref: "local:task-1" },
    code: "stale_snapshot_refused"
  },
  {
    name: "GeneratedTaskIdRequired",
    error: { _tag: "GeneratedTaskIdRequired", taskId: "task-1" },
    code: "generated_task_id_required"
  },
  {
    name: "WriteRejected",
    error: { _tag: "WriteRejected", taskId: "task-1", reason: "provenance minItems(1)" },
    code: "write_rejected"
  },
  {
    name: "GlobalWriteConflict",
    error: { _tag: "GlobalWriteConflict", owner: "other-session" },
    code: "write_conflict"
  }
];

for (const { name, error, code } of writeFailureCases) {
  test(`completeTask surfaces the real writer error code for ${name}`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-write-failure-"));
    try {
      writeTaskPackage(rootDir, "task-1", "Complete Task");
      writeFact(rootDir, "task-1");
      const orchestrator = makeTaskLifecycleOrchestrator({
        rootDir,
        taskWriter: failingWriter(error),
        artifactStore: makeMarkdownArtifactStore({ rootDir }),
        completionGateResolver: () => ["ci", "code-doc-reconciliation"],
        codeDocVersionControlSystem: codeDocVersionControlSystem(),
        now: () => "2026-06-13T00:00:00.000Z"
      });

      const result = await runEffect(orchestrator.completeTask({ taskId: "task-1", reviewerId: "reviewer-a", ciGate: "passed" }));

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.error.code, code);
      assert.notEqual(result.error.code, "completion_gate_failed");
      assert.match(result.error.hint, /Completion status update failed\./);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}

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

test("generic preset completes without CI code-doc or Facts when its contract declares no deterministic gates", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-generic-completion-"));
  try {
    writeIndexOnly(rootDir, "task-1", "Writing Task", "in_review", "writing/generic", "writing-task");
    writeCloseout(rootDir, "task-1", ["## Summary", "", "The requested text is complete."]);
    const orchestrator = makeTaskLifecycleOrchestrator({
      rootDir,
      taskWriter: successfulWriter(),
      artifactStore: inMemoryTaskPackageStore("task-1", {
        "review.md": validReview(),
        "closeout.md": "# Closeout\n\n## Summary\n\nThe requested text is complete.\n"
      }),
      completionGateResolver: () => []
    });
    const result = await runEffect(orchestrator.completeTask({ taskId: "task-1", reviewerId: "reviewer-a" }));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.status, "done");
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
      completionGateResolver: () => ["ci", "code-doc-reconciliation"]
    });
    const result = await runEffect(orchestrator.completeTask({ taskId: "task-1", reviewerId: "reviewer-a" }));
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
        closeoutPlaceholderFingerprints: ["Summarize the completed behavior change."]
      },
      codeDocVersionControlSystem: codeDocVersionControlSystem(),
      now: () => "2026-06-13T00:00:00.000Z"
    });

    const result = await runEffect(orchestrator.completeTask({ taskId: "task-1", reviewerId: "reviewer-a", ciGate: "passed" }));

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
        closeoutPlaceholderFingerprints: ["Summarize the completed behavior change."]
      },
      now: () => "2026-06-13T00:00:00.000Z"
    });

    const result = await runEffect(orchestrator.completeTask({ taskId: "task-1", reviewerId: "reviewer-a", ciGate: "passed" }));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "closeout_placeholder");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function failingWriter(error: EngineError | WriteError): TaskLifecycleWriter {
  return {
    setStatus: () => Effect.fail(error),
    appendProgress: () => Effect.fail(error),
    stageDocument: () => Effect.succeed({ taskId: "task-1", path: "review.md" }),
    stageTaskTree: () => Effect.succeed({ taskId: "task-1", path: "." }),
    taskTreeStatus: () => Effect.succeed({ taskId: "task-1", dirty: false, entries: [] })
  };
}

function successfulWriter(): TaskLifecycleWriter {
  return {
    setStatus: (input) => Effect.succeed({ taskId: input.taskId, status: input.status }),
    appendProgress: (input) => Effect.succeed({ taskId: input.taskId, path: "progress.md", appended: input.text }),
    stageDocument: (input) => Effect.succeed({ taskId: input.taskId, path: input.path }),
    stageTaskTree: (input) => Effect.succeed({ taskId: input.taskId, path: "." }),
    taskTreeStatus: (taskId) => Effect.succeed({ taskId, dirty: false, entries: [] })
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

function codeDocVersionControlSystem(): Pick<VersionControlSystem, "commitExists" | "pathExistsAtCommit"> {
  return {
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
