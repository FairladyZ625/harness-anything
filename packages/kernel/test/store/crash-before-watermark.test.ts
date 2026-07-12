// harness-test-tier: integration
import { testWriteAttribution } from "../test-attribution.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { checkTaskProjection, moduleEntityId } from "../../src/index.ts";
import { decisionEntityId, type DecisionPackage } from "../../src/domain/index.ts";
import { serializeDecisionDocument } from "../../src/domain/decision-document.ts";
import { makeJournaledWriteCoordinator } from "../../src/store/index.ts";
import { docWrite, withTempStore } from "./helpers.ts";

test("WriteCoordinator recovers queued journal entries after crash before watermark", () => {
  withTempStore((rootDir) => {
    const firstCoordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
    Effect.runSync(firstCoordinator.enqueue(docWrite("op-1", "task-1", "progress.md", "replayed")));

    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/watermark.json")), false);

    const recoveredCoordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
    const report = Effect.runSync(recoveredCoordinator.recover);

    assert.equal(report.replayedOps, 1);
    assert.equal(report.recoveredWatermark, "op-1");
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-1/progress.md"), "utf8"), "replayed");
  });
});

test("WriteCoordinator writes decision documents with per-decision coordinator watermark", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
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

test("WriteCoordinator recovers queued decision writes after crash before global watermark", () => {
  withTempStore((rootDir) => {
    const firstCoordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
    Effect.runSync(firstCoordinator.enqueue({
      opId: "op-decision-recover",
      entityId: decisionEntityId("dec_RECOVER"),
      kind: "decision_propose",
      payload: {
        decision: decisionPackage({ decision_id: "dec_RECOVER" })
      }
    }));

    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/watermark.json")), false);
    assert.equal(existsSync(path.join(rootDir, "harness/decisions/decision-dec_RECOVER/decision.md")), false);

    const recoveredCoordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
    const report = Effect.runSync(recoveredCoordinator.recover);

    assert.equal(report.replayedOps, 1);
    assert.equal(report.recoveredWatermark, "op-decision-recover");
    const body = readFileSync(path.join(rootDir, "harness/decisions/decision-dec_RECOVER/decision.md"), "utf8");
    assert.match(body, /^_coordinatorWatermark: op-decision-recover$/mu);
    assert.equal(checkTaskProjection({ rootDir, postMerge: true }).warnings.some((warning) => warning.code.startsWith("decision_watermark_")), false);
  });
});

test("incident poison create self-heals and does not block following writes", () => {
  withTempStore((rootDir) => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/incident-write-path-poison.json", import.meta.url), "utf8")) as {
      readonly poisonOpId: string;
      readonly decisionId: string;
      readonly decision: DecisionPackage;
      readonly followingOp: { readonly opId: string; readonly taskId: string; readonly path: string; readonly body: string };
    };
    const crashed = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
    Effect.runSync(crashed.enqueue({
      opId: fixture.poisonOpId,
      entityId: decisionEntityId(fixture.decisionId),
      kind: "decision_propose",
      payload: {
        decision: fixture.decision,
        writeMode: { kind: "snapshot", expectedWatermark: null }
      }
    }));
    Effect.runSync(crashed.enqueue(docWrite(
      fixture.followingOp.opId,
      fixture.followingOp.taskId,
      fixture.followingOp.path,
      fixture.followingOp.body
    )));

    const decisionPath = path.join(rootDir, `harness/decisions/decision-${fixture.decisionId}/decision.md`);
    mkdirSync(path.dirname(decisionPath), { recursive: true });
    writeFileSync(decisionPath, serializeDecisionDocument({ decision: fixture.decision }, fixture.poisonOpId), "utf8");

    const report = Effect.runSync(makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir }).recover);

    assert.equal(report.replayedOps, 2);
    assert.equal(report.recoveredWatermark, fixture.followingOp.opId);
    assert.equal(readFileSync(
      path.join(rootDir, `harness/tasks/${fixture.followingOp.taskId}/${fixture.followingOp.path}`),
      "utf8"
    ), fixture.followingOp.body);
  });
});

test("WriteCoordinator recovers queued provenance session writes without duplicating them", () => {
  withTempStore((rootDir) => {
    const firstCoordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
    Effect.runSync(firstCoordinator.enqueue({
      opId: "session-export-session-1-sha256:queued",
      entityId: moduleEntityId("provenance-session"),
      kind: "machine_artifact_write",
      payload: {
        boundary: "provenance-session",
        path: "harness/sessions/session-1.md",
        body: [
          "schema: provenance-session/v1",
          "sessionId: session-1",
          "runtime: codex",
          "source: runtime",
          ""
        ].join("\n")
      }
    }));

    assert.equal(existsSync(path.join(rootDir, "harness/sessions/session-1.md")), false);

    const recoveredCoordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
    const report = Effect.runSync(recoveredCoordinator.recover);

    assert.equal(report.replayedOps, 1);
    assert.equal(report.recoveredWatermark, "session-export-session-1-sha256:queued");
    assert.equal(readFileSync(path.join(rootDir, "harness/sessions/session-1.md"), "utf8"), [
      "schema: provenance-session/v1",
      "sessionId: session-1",
      "runtime: codex",
      "source: runtime",
      ""
    ].join("\n"));

    const secondReport = Effect.runSync(makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir }).recover);
    assert.equal(secondReport.replayedOps, 0);
    assert.equal(readFileSync(path.join(rootDir, "harness/sessions/session-1.md"), "utf8"), [
      "schema: provenance-session/v1",
      "sessionId: session-1",
      "runtime: codex",
      "source: runtime",
      ""
    ].join("\n"));
  });
});

test("post-merge gate fails closed on half-written decision documents without coordinator op id", () => {
  withTempStore((rootDir) => {
    const decisionRoot = path.join(rootDir, "harness/decisions/decision-dec_HALF_WRITTEN");
    mkdirSync(decisionRoot, { recursive: true });
    writeFileSync(path.join(decisionRoot, "decision.md"), [
      "---",
      "schema: decision-package/v1",
      "decision_id: dec_HALF_WRITTEN",
      "title: Half written decision",
      "state: proposed",
      "---",
      "",
      "# Half written decision",
      ""
    ].join("\n"));

    const result = checkTaskProjection({ rootDir, postMerge: true });

    assert.equal(result.ok, false);
    assert.equal(result.warnings.some((warning) => warning.code === "decision_watermark_missing"), true);
  });
});

function decisionPackage(overrides: Partial<DecisionPackage> = {}): DecisionPackage {
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
    relations: [],
    ...overrides
  };
}
