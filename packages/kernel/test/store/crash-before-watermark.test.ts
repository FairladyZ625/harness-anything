import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { decisionEntityId, type DecisionPackage } from "../../src/domain/index.ts";
import { makeJournaledWriteCoordinator } from "../../src/store/index.ts";
import { docWrite, withTempStore } from "./helpers.ts";

test("WriteCoordinator recovers queued journal entries after crash before watermark", () => {
  withTempStore((rootDir) => {
    const firstCoordinator = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(firstCoordinator.enqueue(docWrite("op-1", "task-1", "progress.md", "replayed")));

    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/watermark.json")), false);

    const recoveredCoordinator = makeJournaledWriteCoordinator({ rootDir });
    const report = Effect.runSync(recoveredCoordinator.recover);

    assert.equal(report.replayedOps, 1);
    assert.equal(report.recoveredWatermark, "op-1");
    assert.equal(readFileSync(path.join(rootDir, "harness/planning/tasks/task-1/progress.md"), "utf8"), "replayed");
  });
});

test("WriteCoordinator writes decision documents with per-decision coordinator watermark", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(coordinator.enqueue({
      opId: "op-decision-1",
      entityId: decisionEntityId("dec_TEST"),
      kind: "decision_propose",
      payload: {
        decision: decisionPackage()
      }
    }));
    Effect.runSync(coordinator.flush("explicit"));

    const body = readFileSync(path.join(rootDir, "harness/decisions/decision-dec_TEST/decision.md"), "utf8");
    assert.match(body, /^_coordinatorWatermark: op-decision-1$/mu);
    assert.match(body, /^state: proposed$/mu);
  });
});

function decisionPackage(): DecisionPackage {
  return {
    schema: "decision-package/v1",
    decision_id: "dec_TEST",
    title: "Test decision",
    state: "proposed",
    riskTier: "medium",
    urgency: "medium",
    vertical: "software/coding",
    preset: "architecture-decision",
    applies_to: {
      modules: ["kernel"],
      productLines: []
    },
    proposedBy: { kind: "agent", id: "claude" },
    proposedAt: "2026-07-02T00:00:00Z",
    arbiter: { kind: "human", id: "ZeyuLi" },
    provenance: [{
      runtime: "codex",
      sessionId: "session-1",
      boundAt: "2026-07-02T00:00:00Z"
    }],
    question: "Should this test write a decision?",
    chosen: [{ id: "CH1", text: "Write it through the coordinator." }],
    rejected: [{ id: "RJ1", text: "Write it by hand.", why_not: "Machine-readable decision frontmatter needs a coordinator watermark." }],
    claims: [{ id: "C1", text: "Coordinator writes are auditable." }],
    relations: []
  };
}
