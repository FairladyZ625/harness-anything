import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeLocalControllerService } from "../src/index.ts";
import { makeMarkdownArtifactStore } from "../../kernel/src/index.ts";

test("local controller service reads projection and writes through injected task writer", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-app-"));
  try {
    writeTaskIndex(rootDir, "task-1", "Task One", "planned");
    writeTaskIndex(rootDir, "task-archived", "Archived Task", "done", "harness", "archived");
    const writes: string[] = [];
    const service = makeLocalControllerService({
      rootDir,
      artifactStore: makeMarkdownArtifactStore({ rootDir }),
      taskWriter: {
        setStatus: (payload) => Effect.sync(() => {
          writes.push(`status:${payload.taskId}:${payload.status}`);
          patchTaskStatus(rootDir, payload.taskId, payload.status);
          return { taskId: payload.taskId, status: payload.status };
        }),
        appendProgress: (payload) => Effect.sync(() => {
          writes.push(`progress:${payload.taskId}:${payload.text}`);
          const progressPath = path.join(rootDir, "harness/tasks", payload.taskId, "progress.md");
          writeFileSync(progressPath, `${payload.text}\n`, "utf8");
          return { taskId: payload.taskId, path: "progress.md" };
        })
      }
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

    assert.deepEqual(await service.setTaskStatus({ taskId: "task-1", status: "active" }), { ok: true });
    assert.deepEqual(writes, ["status:task-1:active"]);
    assert.deepEqual(await service.setTaskStatus({ taskId: "task-1", status: "done" }), {
      ok: false,
      error: {
        code: "terminal_status_requires_task_complete",
        hint: "Use task-complete after review, CI, and closeout gates pass."
      }
    });
    assert.deepEqual(await service.setTaskStatus({ taskId: "task-1", status: "cancelled" }), {
      ok: false,
      error: {
        code: "terminal_status_requires_task_complete",
        hint: "Terminal cancellation requires an audited recovery path."
      }
    });
    assert.match(readFileSync(path.join(rootDir, "harness/tasks/task-1/INDEX.md"), "utf8"), /status: active/);
    assert.deepEqual(await service.appendTaskProgress({ taskId: "task-1", text: "GUI update" }), { ok: true });
    assert.deepEqual(writes, ["status:task-1:active", "progress:task-1:GUI update"]);
    assert.match(readFileSync(path.join(rootDir, "harness/tasks/task-1/progress.md"), "utf8"), /GUI update/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("local controller service honors explicit authored root for reads and writes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-app-"));
  const layoutOverrides = { authoredRoot: ".custom-harness" };
  try {
    writeTaskIndex(rootDir, "task-1", "Custom Task", "planned", layoutOverrides.authoredRoot);
    const service = makeLocalControllerService({
      rootDir,
      layoutOverrides,
      artifactStore: makeMarkdownArtifactStore({ rootDir, layoutOverrides }),
      taskWriter: {
        setStatus: (payload) => Effect.sync(() => ({ taskId: payload.taskId, status: payload.status })),
        appendProgress: (payload) => Effect.sync(() => {
          const progressPath = path.join(rootDir, layoutOverrides.authoredRoot, "tasks", payload.taskId, "progress.md");
          writeFileSync(progressPath, `${payload.text}\n`, "utf8");
          return { taskId: payload.taskId, path: "progress.md" };
        })
      }
    });

    const list = service.getTasks();
    assert.equal(list.ok, true);
    assert.equal(list.tasks.length, 1);
    const document = await service.getTaskDocument({ taskId: "task-1", path: "INDEX.md" });
    assert.equal(document.ok, true);
    assert.match(document.body ?? "", /Custom Task/);
    assert.deepEqual(await service.appendTaskProgress({ taskId: "task-1", text: "custom progress" }), { ok: true });
    assert.match(readFileSync(path.join(rootDir, ".custom-harness/tasks/task-1/progress.md"), "utf8"), /custom progress/);
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

function patchTaskStatus(rootDir: string, taskId: string, status: string): void {
  const indexPath = path.join(rootDir, "harness/tasks", taskId, "INDEX.md");
  const index = readFileSync(indexPath, "utf8");
  writeFileSync(indexPath, index.replace(/^  status: .+$/m, `  status: ${status}`), "utf8");
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
