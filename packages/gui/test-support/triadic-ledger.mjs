import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function writeTriadicLedger(rootDir) {
  const taskDir = path.join(rootDir, "harness/tasks/task-gui-smoke");
  const decisionDir = path.join(rootDir, "harness/decisions/decision-dec_gui_smoke");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(decisionDir, { recursive: true });
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
  writeFileSync(path.join(taskDir, "facts.md"), [
    "- {fact_id: F-ABCDEFGH, statement: \"The GUI renderer received real triadic rows through the public bridge.\", source: \"GUI E2E\", observedAt: \"2026-07-10T00:30:00.000Z\", confidence: low, memoryClass: semantic, memoryTags: [pattern], provenance: [{runtime: \"codex\", sessionId: \"fg-p1-07-e2e\", boundAt: \"2026-07-10T00:30:00.000Z\"}]}", ""
  ].join("\n"));
  writeFileSync(path.join(decisionDir, "decision.md"), [
    "---", "schema: decision-package/v1", "decision_id: dec_gui_smoke", "_coordinatorWatermark: gui-smoke-watermark",
    "title: \"Expose the triadic projection to the GUI\"", "state: proposed", "riskTier: high", "urgency: high", "vertical: \"software/coding\"",
    "preset: \"architecture-decision\"", "applies_to:", "  modules: [\"gui\"]", "  productLines: []",
    "proposedBy: {kind: \"agent\", id: \"codex\"}", "proposedAt: \"2026-07-10T00:00:00.000Z\"", "arbiter: {kind: \"human\", id: \"ZeyuLi\"}",
    "provenance:", "  - {runtime: \"codex\", sessionId: \"fg-p1-07-e2e\", boundAt: \"2026-07-10T00:00:00.000Z\"}",
    "question: \"Should the GUI consume the public relation graph?\"", "chosen:", "  - {id: \"CH1\", text: \"Use the existing daemon/service bridge\"}",
    "rejected: []", "claims:", "  - {id: \"CH1\", text: \"The public path preserves kernel relation names\", load_bearing: true}", "relations:",
    "  - {relation_id: rel_5287143733cccbd9, source: decision/dec_gui_smoke, target: task/task-gui-smoke, type: derives, strength: strong, direction: directed, origin: declared, rationale: \"Decision derived the GUI task\", state: active}",
    "  - {relation_id: rel_f0e4909f80e86478, source: decision/dec_gui_smoke/CH1, target: fact/task-gui-smoke/F-ABCDEFGH, type: evidenced-by, strength: strong, direction: directed, origin: declared, rationale: \"Fact evidences the public projection\", state: active}",
    "---", ""
  ].join("\n"));
}
