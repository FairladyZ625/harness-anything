// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeLocalControllerService } from "../src/index.ts";
import { makeMarkdownArtifactStore } from "../../kernel/src/index.ts";

test("local controller service reads projections and authored documents", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-app-"));
  try {
    writeTaskIndex(rootDir, "task-1", "Task One", "planned");
    writeTaskIndex(rootDir, "task-archived", "Archived Task", "done", "harness", "archived");
    const service = makeLocalControllerService({
      rootDir,
      artifactStore: makeMarkdownArtifactStore({ rootDir })
    });

    const list = service.getTasks();
    assert.equal(list.ok, true);
    assert.equal(list.tasks.length, 1);
    assert.deepEqual(list.tasks.map((task) => task.taskId), ["task-1"]);

    const detail = await service.getTaskDetail({ taskId: "task-1" });
    assert.equal(detail.ok, true);
    assert.deepEqual(detail.documents, [{ path: "INDEX.md" }]);

    const document = await service.getTaskDocument({ taskId: "task-1", path: "INDEX.md" });
    assert.equal(document.ok, true);
    assert.match(document.body ?? "", /Task One/);
    writeTaskFacts(rootDir, "task-1");
    writeDecision(rootDir, "dec_test");
    const relationGraph = service.getRelationGraph();
    assert.equal(relationGraph.ok, true);
    assert.deepEqual(relationGraph.factAnchors.map((anchor) => anchor.factRef), ["fact/task-1/F-12345678"]);
    const decisions = service.getDecisions();
    assert.equal(decisions.ok, true);
    assert.deepEqual(decisions.decisions.map((decision) => decision.decisionId), ["dec_test"]);
    assert.deepEqual(decisions.decisions[0]?.proposedBy, { kind: "agent", id: "codex" });
    assert.deepEqual(decisions.decisions[0]?.arbiter, { kind: "human", id: "ZeyuLi" });
    assert.deepEqual(decisions.decisions[0]?.provenance, [{ runtime: "codex", sessionId: "session-1", boundAt: "2026-07-07T00:00:00.000Z" }]);
    const decisionDetail = service.getDecisionDetail({ decisionId: "dec_test" });
    assert.equal(decisionDetail.ok, true);
    assert.equal(decisionDetail.decision.title, "Projection Decision");
    const facts = await service.getTaskFacts({ taskId: "task-1" });
    assert.equal(facts.ok, true);
    assert.deepEqual(facts.facts.map((fact) => fact.ref), ["fact/task-1/F-12345678"]);
    assert.deepEqual(facts.facts[0]?.provenance, [{ runtime: "codex", sessionId: "session-1", boundAt: "2026-07-07T00:00:00.000Z" }]);
    assert.deepEqual(await service.getTaskDocument({ taskId: "task-1", path: "C:\\Users\\name\\secret.md" }), {
      ok: false,
      error: {
        code: "invalid_payload",
        hint: "portable document path is required."
      }
    });
    assert.deepEqual(await service.getTaskDocument({ taskId: "task-1", path: "notes/../INDEX.md" }), {
      ok: true,
      taskId: "task-1",
      path: "INDEX.md",
      body: document.body
    });

  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("local controller service honors explicit authored root for reads", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-app-"));
  const layoutOverrides = { authoredRoot: ".custom-harness" };
  try {
    writeTaskIndex(rootDir, "task-1", "Custom Task", "planned", layoutOverrides.authoredRoot);
    const service = makeLocalControllerService({
      rootDir,
      layoutOverrides,
      artifactStore: makeMarkdownArtifactStore({ rootDir, layoutOverrides })
    });

    const list = service.getTasks();
    assert.equal(list.ok, true);
    assert.equal(list.tasks.length, 1);
    const document = await service.getTaskDocument({ taskId: "task-1", path: "INDEX.md" });
    assert.equal(document.ok, true);
    assert.match(document.body ?? "", /Custom Task/);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-1/INDEX.md")), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function writeTaskIndex(rootDir: string, taskId: string, title: string, status: string, authoredRoot = "harness", packageDisposition = "active"): void {
  mkdirSync(path.join(rootDir, authoredRoot, "tasks", taskId), { recursive: true });
  writeFileSync(path.join(rootDir, authoredRoot, "tasks", taskId, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    `  status: ${status}`,
    "  ref: ",
    `  titleSnapshot: ${title}`,
    "  url: ",
    "  bindingCreatedAt: 2026-06-12T00:00:00.000Z",
    "  bindingFingerprint: sha256:test",
    `packageDisposition: ${packageDisposition}`,
    "vertical: default",
    "preset: default",
    "---",
    ""
  ].join("\n"), "utf8");
}

function writeTaskFacts(rootDir: string, taskId: string): void {
  writeFileSync(path.join(rootDir, "harness/tasks", taskId, "facts.md"), [
    "- {fact_id: F-12345678, statement: \"Projection fact\", source: \"test\", observedAt: \"2026-07-07T00:00:00.000Z\", confidence: high, memoryClass: semantic, memoryTags: [pattern], provenance: [{runtime: \"codex\", sessionId: \"session-1\", boundAt: \"2026-07-07T00:00:00.000Z\"}]}",
    ""
  ].join("\n"), "utf8");
}

function writeDecision(rootDir: string, decisionId: string): void {
  const decisionDir = path.join(rootDir, "harness/decisions", `decision-${decisionId}`);
  mkdirSync(decisionDir, { recursive: true });
  writeFileSync(path.join(decisionDir, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${decisionId}`,
    "_coordinatorWatermark: test-watermark",
    "title: \"Projection Decision\"",
    "state: active",
    "riskTier: medium",
    "urgency: medium",
    "vertical: \"software/coding\"",
    "preset: \"architecture-decision\"",
    "applies_to:",
    "  modules: [\"gui\"]",
    "  productLines: []",
    "proposedBy: { kind: \"agent\", id: \"codex\" }",
    "proposedAt: \"2026-07-07T00:00:00.000Z\"",
    "arbiter: { kind: \"human\", id: \"ZeyuLi\" }",
    "decidedAt: \"2026-07-07T01:00:00.000Z\"",
    "provenance:",
    "  - { runtime: \"codex\", sessionId: \"session-1\", boundAt: \"2026-07-07T00:00:00.000Z\" }",
    "question: \"Use projection?\"",
    "chosen:",
    "  - { id: \"CH1\", text: \"Use projection\" }",
    "rejected:",
    "  - { id: \"RJ1\", text: \"Parse markdown in GUI\", why_not: \"Projection owns reads\" }",
    "claims:",
    "  - { id: \"C1\", text: \"Projection reads are stable\", load_bearing: false }",
    "relations: []",
    "---",
    "",
    "# Projection Decision",
    ""
  ].join("\n"), "utf8");
}
