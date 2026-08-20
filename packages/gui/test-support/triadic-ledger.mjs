import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeDecisionService, makeFactService } from "../../application/src/index.ts";
import { compileDecisionWrite, compileFactWrite, deriveRelationId, makeTaskEventStore, makeTaskProjection } from "../../kernel/src/index.ts";

export function writeTriadicLedger(rootDir) {
  const taskDir = path.join(rootDir, "harness/tasks/task-gui-smoke");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), [
    "schema: harness-anything/v1", "name: gui-triadic-smoke", "layout:", "  authoredRoot: harness", "  localRoot: .harness", ""
  ].join("\n"));
  writeFileSync(path.join(taskDir, "INDEX.md"), [
    "---", "schema: task-package/v2", "task_id: task-gui-smoke", "title: Render the real triadic projection", "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1", "  engine: local", "  status: active", "  ref:",
    "  titleSnapshot: Render the real triadic projection", "  url:", "  bindingCreatedAt: 2026-07-10T00:00:00.000Z",
    "  bindingFingerprint: sha256:gui-smoke", "packageDisposition: active", "vertical: software/coding", "preset: implementation", "relations:",
    "  - {relation_id: rel_bfa32bfd7f399b66, source: task/task-gui-smoke, target: fact/task-gui-smoke/F-ABCDEFGH, type: produces, strength: strong, direction: directed, origin: declared, rationale: \"Task produced the renderer projection evidence\", state: active}",
    "---", ""
  ].join("\n"));
}

export function seedTriadicEvents(rootDir, repoId) {
  const store = makeTaskEventStore({ rootDir, repoId }), projection = makeTaskProjection({ rootDir, eventStore: store }), factService = makeFactService({ eventStore: store, projection }), decisionService = makeDecisionService({ eventStore: store, projection }), actor = { principal: { personId: "person-gui" }, executor: null };
  try {
  const append = (type, decisionId, payload) => { const revision = (store.readHead()?.revision ?? 0) + 1, event = { schema: "decision-event/v1", eventId: `event-${type}-${revision}`, workspaceRevision: revision, opId: `op-${type}-${revision}`, decisionId, type, actor, source: "local", occurredAt: `2026-08-13T00:00:${String(revision).padStart(2, "0")}.000Z`, payload }, read = projection.readDecision(decisionId), path = `decisions/decision-${decisionId}/decision.md`, document = projection.readDocument(path).document, relations = projection.readDecisionGraph().edges.filter((edge) => edge.ownerRef === `decision/${decisionId}`).map((edge) => ({ relation_id: edge.relationId, source: edge.sourceRef, target: edge.targetRef, type: edge.relationType, strength: edge.strength, direction: edge.direction, origin: edge.origin, rationale: edge.rationale, state: edge.state })); decisionService.record(compileDecisionWrite({ event, currentDecision: read.decision, currentRelations: relations, currentDocument: document })); };
  const revision = (store.readHead()?.revision ?? 0) + 1, fact = { schema: "fact-event/v1", eventId: `event-fact-gui-${revision}`, workspaceRevision: revision, opId: `op-fact-gui-${revision}`, taskId: "task-gui-smoke", factId: "F-ABCDEFGH", type: "fact_recorded", actor, source: "local", occurredAt: "2026-08-13T00:00:20.000Z", payload: { statement: "The GUI renderer received event-backed triadic rows.", evidenceSource: "GUI integration", observedAt: "2026-08-13T00:00:20.000Z", confidence: "low", memoryClass: "semantic", memoryTags: ["pattern"], provenance: [{ runtime: "codex", sessionId: "fg-p1-07-e2e", boundAt: "2026-08-13T00:00:20.000Z" }] } };
  const packagePath = projection.read("task-gui-smoke").packagePath;
  if (!packagePath) throw new Error("GUI task package is unavailable");
  factService.record(compileFactWrite({ event: fact, packagePath, currentFacts: [] }));
  append("decision_proposed", "dec_gui_smoke", { title: "Expose the triadic projection to the GUI", question: "Should the GUI consume the public relation graph?", riskTier: "high", urgency: "high", vertical: "software/coding", preset: "architecture-decision", appliesTo: { modules: ["gui"], productLines: [] }, decisionClass: "ordinary", chosen: [{ id: "CH1", text: "Use the existing daemon/service bridge" }], rejected: [{ id: "RJ1", text: "Read Markdown directly", whyNot: "It bypasses canonical projection truth" }], body: "\n# Expose the triadic projection to the GUI\n", claims: [], fulfillments: [], relations: [] });
  append("decision_claim_declared", "dec_gui_smoke", { claimId: "C1", text: "The public path preserves kernel relation names", loadBearing: true });
  for (const relation of [{ source: "decision/dec_gui_smoke", target: "task/task-gui-smoke", type: "derives", rationale: "Decision derived the GUI task" }, { source: "decision/dec_gui_smoke/C1", target: "fact/task-gui-smoke/F-ABCDEFGH", type: "evidenced-by", rationale: "Fact evidences the public projection" }]) {
    const identity = { ...relation, direction: "directed" };
    append("decision_related", "dec_gui_smoke", { relation: { relation_id: deriveRelationId(identity), ...identity, strength: "strong", origin: "declared", state: "active" } });
  }
  } finally {
    projection.close();
    void store.drain();
  }
}
