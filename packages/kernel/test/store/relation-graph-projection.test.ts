// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  checkTaskProjection,
  deriveRelationId,
  evaluateEntityDisposition,
  formatRelationFlowRecord,
  makeTaskProjection,
  readEntityCascadeImpact,
  readRelationGraphProjection,
  rebuildTaskProjection,
  type EntityRelationRecord,
  type FactAnchorRow,
  type FactEventV1
} from "../../src/index.ts";
import { withTempStore } from "./helpers.ts";

test("triadic authored relations resolve event-backed Fact anchors without facts.md", () => {
  withTempStore((rootDir) => {
    const anchor = factAnchor("task-coverage", "F-DEADBEEF"), relation = relationRecord({
      source: "decision/dec_COVER/C1", target: anchor.factRef, type: "evidenced-by"
    });
    projectFactAnchor(rootDir, anchor); writeDecision(rootDir, "dec_COVER", "wm-cover", [relation]);

    const checked = checkTaskProjection({ rootDir, postMerge: true });
    assert.equal(checked.ok, true, JSON.stringify(checked.warnings));
    assert.equal(checked.warnings.some(({ code }) => code === "relation_endpoint_unknown"), false);
  });
});

test("event-backed Fact anchors reject unknown authored endpoints", () => {
  withTempStore((rootDir) => {
    projectFactAnchor(rootDir, factAnchor("task-known", "F-AAAAAAAA"));
    writeDecision(rootDir, "dec_UNKNOWN", "wm-unknown", [relationRecord({
      source: "decision/dec_UNKNOWN/C1", target: "fact/task-missing/F-DEADBEEF", type: "evidenced-by"
    })]);
    const checked = checkTaskProjection({ rootDir, postMerge: true });
    assert.equal(checked.ok, false);
    assert.equal(checked.warnings.some(({ code }) => code === "relation_endpoint_unknown"), true);
  });
});

test("relation graph projection preserves task/decision edges and auto-rebuilds", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-before", "Task Before"); writeIndex(rootDir, "task-after", "Task After");
    const before = relationRecord({ source: "decision/dec_STALE/C1", target: "task/task-before", type: "derives" });
    writeDecision(rootDir, "dec_STALE", "wm-stale", [before]); rebuildTaskProjection({ rootDir });
    const after = relationRecord({ source: "decision/dec_STALE/C1", target: "task/task-after", type: "derives" });
    writeDecision(rootDir, "dec_STALE", "wm-stale", [after]);
    const graph = readRelationGraphProjection({ rootDir });
    assert.equal(graph.warnings.some(({ code }) => code === "projection_stale"), true);
    assert.deepEqual(graph.edges.map(({ relationId }) => relationId), [after.relation_id]);
  });
});

test("chosen decision anchors remain valid relation sources", () => {
  withTempStore((rootDir) => {
    writeDecision(rootDir, "dec_OLD", "wm-old", []);
    const relation = relationRecord({ source: "decision/dec_NEW/O1", target: "decision/dec_OLD", type: "supersedes" });
    writeDecision(rootDir, "dec_NEW", "wm-new", [relation]); rebuildTaskProjection({ rootDir });
    assert.equal(readRelationGraphProjection({ rootDir }).edges.some(({ relationId }) => relationId === relation.relation_id), true);
  });
});

test("post-merge validation rejects unknown decision anchors and relation id drift", () => {
  withTempStore((rootDir) => {
    writeDecision(rootDir, "dec_TARGET", "wm-target", []);
    writeDecisionLines(rootDir, "dec_BAD", "wm-bad", [
      "- {relation_id: rel_0000000000000000, source: decision/dec_BAD/CH404, target: decision/dec_TARGET, type: relates, strength: strong, direction: directed, origin: declared, rationale: \"Fixture\", state: active}"
    ]);
    const result = checkTaskProjection({ rootDir, postMerge: true }), codes = result.warnings.map(({ code }) => code);
    assert.equal(result.ok, false); assert.equal(codes.includes("relation_endpoint_unknown"), true); assert.equal(codes.includes("relation_id_mismatch"), true);
  });
});

test("duplicate relation ids converge only when their bytes agree", () => {
  withTempStore((rootDir) => {
    writeDecision(rootDir, "dec_TARGET", "wm-target", []);
    const relation = relationRecord({ source: "decision/dec_DUP/C1", target: "decision/dec_TARGET", type: "relates" });
    writeDecision(rootDir, "dec_DUP", "wm-dup", [relation, relation]);
    assert.equal(checkTaskProjection({ rootDir, postMerge: true }).ok, true);
    writeDecision(rootDir, "dec_DUP", "wm-dup", [relation, { ...relation, rationale: "Divergent bytes" }]);
    assert.equal(checkTaskProjection({ rootDir, postMerge: true }).warnings.some(({ code }) => code === "duplicate_relation_id"), true);
  });
});

test("entity disposition and cascade preserve active incoming relation lower bounds", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-blocked", "Task Blocked");
    const relation = relationRecord({ source: "decision/dec_BLOCK/C1", target: "task/task-blocked", type: "derives" });
    writeDecision(rootDir, "dec_BLOCK", "wm-block", [relation]); rebuildTaskProjection({ rootDir });
    const disposition = evaluateEntityDisposition({ rootDir, entityRef: "task/task-blocked", action: "hard-delete" });
    const impact = readEntityCascadeImpact({ rootDir, entityRef: "task/task-blocked" });
    assert.equal(disposition.allowed, false); assert.equal(disposition.lowerBound.activeIncomingCount, 1);
    assert.deepEqual(impact.incoming.map(({ relationId }) => relationId), [relation.relation_id]);
  });
});

function factAnchor(taskId: string, factId: string): FactAnchorRow {
  return { factRef: `fact/${taskId}/${factId}`, taskId, factId, sourcePath: "event:op-fact-anchor" };
}

function projectFactAnchor(rootDir: string, anchor: FactAnchorRow): void {
  const emptyStore = { readHead: () => null, readBatch: () => ({ sourceRevision: 0, events: [], cursor: null, done: true, accessedItems: 0 }), readContentBlob: () => null };
  const event: FactEventV1 = { schema: "fact-event/v1", eventId: `event-${anchor.factId}`, workspaceRevision: 1, opId: "op-fact-anchor", taskId: anchor.taskId, factId: anchor.factId,
    type: "fact_recorded", actor: { principal: { personId: "tester" }, executor: null }, source: "local", occurredAt: "2026-08-13T00:00:00.000Z", payload: { statement: "Projected Fact anchor", evidenceSource: "integration fixture", observedAt: "2026-08-13T00:00:00.000Z", confidence: "high", memoryClass: "semantic", memoryTags: [], provenance: [{ runtime: "human", sessionId: "post-merge-fixture", boundAt: "2026-08-13T00:00:00.000Z" }] } };
  makeTaskProjection({ rootDir, eventStore: emptyStore }).apply(event);
}

function writeIndex(rootDir: string, taskId: string, title: string): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId); mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), ["---", "schema: task-package/v2", `task_id: ${taskId}`, `title: ${title}`, "lifecycle:", "  engine: local",
    "  status: active", "packageDisposition: active", "vertical: default", "preset: default", "---", "", `# ${title}`, ""].join("\n"));
}

function writeDecision(rootDir: string, decisionId: string, watermark: string, relations: readonly EntityRelationRecord[]): void {
  writeDecisionLines(rootDir, decisionId, watermark, relations.map(formatRelationFlowRecord));
}

function writeDecisionLines(rootDir: string, decisionId: string, watermark: string, relationLines: readonly string[]): void {
  const decisionRoot = path.join(rootDir, "harness/decisions", `decision-${decisionId}`); mkdirSync(decisionRoot, { recursive: true });
  writeFileSync(path.join(decisionRoot, "decision.md"), ["---", "schema: decision-package/v1", `decision_id: ${decisionId}`, `_coordinatorWatermark: ${watermark}`,
    `title: ${decisionId}`, "state: active", "riskTier: low", "urgency: medium", "vertical: test", "preset: default", "applies_to:", "  modules: [\"test\"]",
    "  productLines: []", "proposedBy: { kind: \"human\", id: \"tester\" }", "proposedAt: \"2026-07-03T00:00:00.000Z\"",
    "arbiter: { kind: \"human\", id: \"arbiter\" }", "question: Fixture", "chosen:", "  - { id: \"O1\", title: \"Chosen\", rationale: \"Fixture\" }",
    "rejected:", "  - { id: \"O2\", title: \"Rejected\", rationale: \"Fixture\" }", "claims:", "  - { id: \"C1\", statement: \"Fixture claim\", required: true }",
    "relations:", ...relationLines, "---", "", `# ${decisionId}`, ""].join("\n"));
}

function relationRecord(input: { readonly source: string; readonly target: string; readonly type: EntityRelationRecord["type"] }): EntityRelationRecord {
  const identity = { source: input.source, target: input.target, type: input.type, direction: "directed" as const };
  return { relation_id: deriveRelationId(identity), ...identity, strength: "strong", origin: "declared", rationale: "Fixture relation", state: "active" };
}
