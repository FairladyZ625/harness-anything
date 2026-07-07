import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import type { EngineError, WriteError } from "../../kernel/src/index.ts";
import { makeTaskLifecycleOrchestrator, type TaskLifecycleWriter } from "../src/task-lifecycle-orchestrator.ts";
import { runEffect } from "./effect-test-helpers.ts";

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

function failingWriter(error: EngineError | WriteError): TaskLifecycleWriter {
  return {
    setStatus: () => Effect.fail(error),
    appendProgress: () => Effect.fail(error),
    stageDocument: () => Effect.succeed({ taskId: "task-1", path: "review.md" }),
    stageTaskTree: () => Effect.succeed({ taskId: "task-1", path: "." }),
    taskTreeStatus: () => Effect.succeed({ taskId: "task-1", dirty: false, entries: [] })
  };
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
}

function writeFact(rootDir: string, directoryName: string): void {
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "facts.md"), [
    "# Facts",
    "",
    "- {fact_id: F-DEADBEEF, statement: \"Task has verified evidence.\", source: \"test fixture\", observedAt: \"2026-07-04T00:00:00.000Z\", confidence: high, memoryClass: episodic, memoryTags: [], provenance: [{runtime: \"human\", sessionId: \"human-cli-1783036800000\", boundAt: \"2026-07-04T00:00:00.000Z\"}]}",
    ""
  ].join("\n"), "utf8");
}
