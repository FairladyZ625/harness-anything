// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  makeCoordinatedExecutionAuthoredStore,
  makeExecutionSagaService,
  makeJournaledWriteCoordinator,
  makeMarkdownArtifactStore,
  makeTaskHolderService,
  taskHolderActor
} from "../src/index.ts";
import { writeContentAddressedBlobWithDisposition, writeSessionEntity } from "../../kernel/src/index.ts";
import { memoryAuthoredStore, taskIndex } from "./execution-saga-fixtures.ts";
import { writeAttribution } from "./test-attribution.ts";

const taskId = "task_01KX19GEKWMEJNGSMRT6JJH6HY";
const executionId = "exe_01KX7H00000000000000000001";
const aliceCodex = taskHolderActor(
  { personId: "alice", displayName: "Alice" },
  { kind: "agent", id: "codex" }
);
const bobCodex = taskHolderActor(
  { personId: "bob", displayName: "Bob" },
  { kind: "agent", id: "codex" }
);
const aliceCodexAttribution = writeAttribution("alice", "codex");

test("Execution claim preserves blocked and in_review Task lifecycle state", async () => {
  for (const status of ["blocked", "in_review"] as const) {
    const rootDir = mkdtempSync(path.join(tmpdir(), `ha-execution-${status}-claim-`));
    try {
      const taskRoot = path.join(rootDir, "harness/tasks", `${taskId}-${status}-claim`);
      mkdirSync(taskRoot, { recursive: true });
      writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex(taskId, status), "utf8");
      const coordinator = makeJournaledWriteCoordinator({ rootDir, attribution: aliceCodexAttribution });
      const primarySession = {
        runtime: "codex" as const,
        sessionId: `codex-${status}-primary`,
        source: "runtime" as const,
        detectedAt: "2026-07-11T00:00:00.000Z"
      };
      const bodyRef = writeContentAddressedBlobWithDisposition(rootDir, `# ${status} session\n`, "text/markdown; charset=utf-8");
      Effect.runSync(writeSessionEntity(coordinator, rootDir, {
        schema: "session-entity/v1",
        sessionId: primarySession.sessionId,
        lifecycle: "sealed",
        archiveStatus: "complete",
        runtime: "codex",
        source: "runtime",
        detectedAt: primarySession.detectedAt,
        exportedAt: "2026-07-11T00:00:01.000Z",
        bodyRef: { store: "authored-cas/v1", ...bodyRef },
        snapshot: {
          capturedAt: "2026-07-11T00:00:01.000Z",
          completeness: "complete",
          captureRange: { messageCount: 1 },
          privacyScan: { scannerVersion: "test", passed: true, findings: [] }
        }
      }));
      const saga = makeExecutionSagaService({
        taskHolderService: makeTaskHolderService({ rootInput: rootDir }),
        authoredStore: makeCoordinatedExecutionAuthoredStore({
          rootInput: rootDir,
          coordinator,
          artifactStore: makeMarkdownArtifactStore({ rootDir })
        }),
        generateExecutionId: () => executionId,
        now: () => "2026-07-11T00:00:00.000Z"
      });

      const claimed = await saga.claim({ taskId, principal: aliceCodex, primarySession });

      assert.equal(claimed.execution.state, "active");
      assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), new RegExp(`^  status: ${status}$`, "mu"));
      if (status === "in_review") {
        await saga.submitForReview({
          taskId,
          executionId,
          principal: aliceCodex,
          submission: {
            completionClaim: "repair legacy review",
            deliverables: [],
            verificationNotes: [],
            knownGaps: [],
            residualRisks: [],
            evidence: []
          }
        });
        assert.equal(JSON.parse(readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8")).state, "submitted");
        assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: in_review$/mu);
      }
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test("the active Execution lease actor can submit without replaying the lease token", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-execution-tokenless-submit-"));
  try {
    const holder = makeTaskHolderService({ rootInput: rootDir });
    const authored = memoryAuthoredStore();
    const saga = makeExecutionSagaService({
      taskHolderService: holder,
      authoredStore: authored,
      generateExecutionId: () => executionId,
      now: () => "2026-07-11T00:00:00.000Z"
    });
    await saga.claim({ taskId, principal: aliceCodex });
    authored.taskStatus = "active";
    const submission = {
      completionClaim: "ready without token replay",
      deliverables: [],
      verificationNotes: [],
      knownGaps: [],
      residualRisks: [],
      evidence: []
    };

    await assert.rejects(saga.submitForReview({
      taskId,
      executionId,
      leaseToken: "0".repeat(64),
      principal: aliceCodex,
      submission
    }), /requires an active lease/u);
    await assert.rejects(saga.submitForReview({
      taskId,
      executionId,
      principal: bobCodex,
      submission
    }), /requires an active lease/u);
    await saga.submitForReview({ taskId, executionId, principal: aliceCodex, submission });

    assert.equal(authored.executions.get(executionId)?.state, "submitted");
    assert.equal((await holder.holder({ taskId })).effectiveHolder, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
