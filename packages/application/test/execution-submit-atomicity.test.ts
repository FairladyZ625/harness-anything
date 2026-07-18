// harness-test-tier: integration
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  executionDeclaration,
  makeCoordinatedExecutionAuthoredStore,
  makeJournaledWriteCoordinator,
  taskHolderActor,
  type ExecutionRecord
} from "../src/index.ts";
import { stablePayloadHash, writeDeclaredEntityTransaction } from "../../kernel/src/index.ts";
import { writeAttribution } from "./test-attribution.ts";
import { taskIndex } from "./execution-saga-fixtures.ts";
import { runEffect } from "./effect-test-helpers.ts";

const taskId = "task_01KX19GEKWMEJNGSMRT6JJH6HY";
const executionId = "exe_01KX7H00000000000000000001";
const actor = taskHolderActor({ personId: "alice", displayName: "Alice" }, { kind: "agent", id: "codex" });

test("execution submit transaction leaves both authored documents unchanged at execution, task, and projection killpoints", async () => {
  for (const killpoint of ["execution-write", "task-write", "projection"] as const) {
    const rootDir = mkdtempSync(path.join(tmpdir(), `ha-execution-submit-${killpoint}-`));
    const taskRoot = path.join(rootDir, "harness/tasks", taskId);
    const executionRoot = path.join(taskRoot, "executions");
    try {
      mkdirSync(executionRoot, { recursive: true });
      const active = execution("active");
      const submitted = execution("submitted");
      const executionPath = path.join(executionRoot, `${executionId}.md`);
      const indexPath = path.join(taskRoot, "INDEX.md");
      const activeBody = executionDeclaration.documentCodec.encode(active);
      const activeIndex = taskIndex(taskId, "active");
      writeFileSync(executionPath, activeBody, "utf8");
      writeFileSync(indexPath, activeIndex, "utf8");
      const coordinator = makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "codex") });
      if (killpoint === "execution-write") chmodSync(executionRoot, 0o500);
      if (killpoint === "task-write") chmodSync(taskRoot, 0o500);

      const operation = killpoint === "projection"
        ? projectionFailure(coordinator, rootDir)
        : runEffect(writeDeclaredEntityTransaction(
          coordinator, stablePayloadHash, executionDeclaration, { taskId, executionId }, submitted,
          [{ taskId, path: "INDEX.md", body: activeIndex.replace(/^(  status:\s*).+$/mu, "$1in_review") }]
        ));
      await assert.rejects(operation, killpoint === "projection"
        ? (error: unknown) => String(error).includes("ArtifactReadFailed")
        : /EACCES|permission denied|operation not permitted/iu);

      if (killpoint === "execution-write") chmodSync(executionRoot, 0o700);
      if (killpoint === "task-write") chmodSync(taskRoot, 0o700);
      assert.equal(readFileSync(executionPath, "utf8"), activeBody, killpoint);
      assert.equal(readFileSync(indexPath, "utf8"), activeIndex, killpoint);
    } finally {
      chmodSync(taskRoot, 0o700);
      if (existsSync(executionRoot)) chmodSync(executionRoot, 0o700);
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

function execution(state: "active" | "submitted"): ExecutionRecord {
  return {
    schema: "execution/v2", execution_id: executionId, task_ref: `task/${taskId}`, state,
    primary_actor: actor, claimed_at: "2026-07-11T00:00:00.000Z",
    submitted_at: state === "submitted" ? "2026-07-11T00:01:00.000Z" : null,
    closed_at: null, session_bindings: [], outputs: [],
    submission: state === "submitted" ? {
      completion_claim: "atomic killpoint probe", deliverables: [], evidence_refs: [],
      verification_notes: [], known_gaps: [], residual_risks: []
    } : null
  };
}

function projectionFailure(coordinator: Parameters<typeof makeCoordinatedExecutionAuthoredStore>[0]["coordinator"], rootDir: string) {
  return makeCoordinatedExecutionAuthoredStore({
    rootInput: rootDir,
    coordinator,
    artifactStore: {
      readTaskPackage: () => Effect.fail({
        _tag: "ArtifactReadFailed" as const, path: "projection", cause: new Error("injected projection failure")
      })
    }
  }).submitForReview({
    taskId, executionId, submittedAt: "2026-07-11T00:01:00.000Z",
    submission: { completionClaim: "probe", deliverables: [], evidence: [], verificationNotes: [], knownGaps: [], residualRisks: [] }
  });
}
