// harness-test-tier: integration
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
    writeTaskDocument(rootDir, "task-1", "task_plan.md", "# Task plan\n");
    writeTaskDocument(rootDir, "task-1", "artifacts/research/evidence.md", "# Evidence\n");
    writeTaskDocument(rootDir, "task-1", "artifacts/diagram.png", "not really a png");
    writeAuthoredDocument(rootDir, "adr/ADR-0001.md", "# ADR\n");
    writeAuthoredDocument(rootDir, "artifacts/.gitkeep", "");
    writeDecision(rootDir, "dec_test");
    const writes: string[] = [];
    const markdownArtifactStore = makeMarkdownArtifactStore({ rootDir });
    let authoredDocumentReads = 0;
    const service = makeLocalControllerService({
      rootDir,
      artifactStore: {
        ...markdownArtifactStore,
        readAuthoredDocument: (documentPath) => {
          authoredDocumentReads += 1;
          return markdownArtifactStore.readAuthoredDocument(documentPath);
        }
      },
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
    assert.deepEqual(detail.documents, [
      { path: "artifacts/diagram.png", kind: "attachment" },
      { path: "artifacts/research/evidence.md", kind: "document" },
      { path: "INDEX.md", kind: "document" },
      { path: "task_plan.md", kind: "document" }
    ]);
    assert.deepEqual(await service.getPeripheralDocuments(), {
      ok: true,
      documents: [
        { path: "adr/ADR-0001.md" },
        { path: "decisions/decision-dec_test/decision.md" }
      ]
    });
    assert.deepEqual(await service.getPeripheralDocument({ path: "adr/ADR-0001.md" }), {
      ok: true,
      path: "adr/ADR-0001.md",
      body: "# ADR\n"
    });
    assert.deepEqual(await service.getPeripheralDocument({ path: "tasks/task-1/INDEX.md" }), {
      ok: false,
      error: {
        code: "document_not_found",
        hint: "tasks/task-1/INDEX.md"
      }
    });
    assert.deepEqual(await service.getPeripheralDocument({ path: "../secret.md" }), {
      ok: false,
      error: {
        code: "invalid_payload",
        hint: "portable document path is required."
      }
    });

    const document = await service.getTaskDocument({ taskId: "task-1", path: "INDEX.md" });
    assert.equal(document.ok, true);
    assert.match(document.body ?? "", /Task One/);
    assert.deepEqual(await service.getTaskDocument({ taskId: "task-1", path: "artifacts/diagram.png" }), {
      ok: false,
      error: {
        code: "attachment_not_renderable",
        hint: "artifacts/diagram.png"
      }
    });
    writeTaskFacts(rootDir, "task-1");
    const relationGraph = service.getRelationGraph();
    assert.equal(relationGraph.ok, true);
    assert.deepEqual(relationGraph.factAnchors.map((anchor) => anchor.factRef), ["fact/task-1/F-12345678"]);
    const decisions = service.getDecisions();
    assert.equal(decisions.ok, true);
    assert.deepEqual(decisions.decisions.map((decision) => decision.decisionId), ["dec_test"]);
    assert.deepEqual(decisions.decisions[0]?.attribution, {
      originator: {
        principal: { kind: "person", personId: "ZeyuLi" },
        executor: { kind: "agent", id: "codex" }
      },
      latestActor: {
        principal: { kind: "person", personId: "ZeyuLi" },
        executor: null
      },
      trailCount: 2,
      completeness: "host-only"
    });
    assert.deepEqual(decisions.decisions[0]?.provenance, [{ runtime: "codex", sessionId: "session-1", boundAt: "2026-07-07T00:00:00.000Z" }]);
    const executions = service.getExecutions();
    assert.equal(executions.ok, true);
    assert.deepEqual(executions.executions, []);
    const pendingExecutionEvidence = service.getExecutionEvidencePage({ limit: 40 });
    assert.ok(pendingExecutionEvidence instanceof Promise);
    const executionEvidence = await pendingExecutionEvidence;
    assert.equal(executionEvidence.ok, true);
    assert.deepEqual(executionEvidence.groups, []);
    assert.equal(executionEvidence.stats.totalExecutions, 0);
    assert.equal(executionEvidence.nextCursor, null);
    const decisionDetail = service.getDecisionDetail({ decisionId: "dec_test" });
    assert.equal(decisionDetail.ok, true);
    assert.equal(decisionDetail.decision.title, "Projection Decision");
    const facts = await service.getTaskFacts({ taskId: "task-1" });
    authoredDocumentReads = 0;
    assert.equal(facts.ok, true);
    assert.deepEqual(facts.facts.map((fact) => fact.ref), ["fact/task-1/F-12345678"]);
    assert.deepEqual(facts.facts[0]?.provenance, [{ runtime: "codex", sessionId: "session-1", boundAt: "2026-07-07T00:00:00.000Z" }]);
    const allFacts = await service.getFacts();
    assert.equal(allFacts.ok, true);
    assert.deepEqual(allFacts.facts.map((fact) => fact.ref), ["fact/task-1/F-12345678"]);
    const triadic = await service.getTriadicProjection();
    assert.equal(triadic.ok, true);
    assert.deepEqual(triadic.decisions.map((decision) => decision.decisionId), ["dec_test"]);
    assert.deepEqual(triadic.factAnchors.map((anchor) => anchor.factRef), ["fact/task-1/F-12345678"]);
    assert.deepEqual(triadic.facts.map((fact) => fact.ref), ["fact/task-1/F-12345678"]);
    assert.equal(authoredDocumentReads, 0);
    writeFileSync(path.join(rootDir, "harness/tasks/task-1/facts.md"), [
      "# Facts",
      "",
      "- {fact_id: F-12345678, statement: \"Malformed projection fact\", confidence: high}",
      ""
    ].join("\n"));
    const malformedTriadic = await service.getTriadicProjection();
    assert.deepEqual(malformedTriadic.facts, []);
    assert.equal(malformedTriadic.warnings.some((warning) => warning.code === "source_malformed"), true);
    assert.equal(authoredDocumentReads, 0);
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

test("local controller service delegates evidence pages to an injected projection query", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-app-"));
  try {
    const payloads: unknown[] = [];
    const service = makeLocalControllerService({
      rootDir,
      artifactStore: makeMarkdownArtifactStore({ rootDir }),
      taskWriter: {
        setStatus: (payload) => Effect.succeed({ taskId: payload.taskId, status: payload.status }),
        appendProgress: (payload) => Effect.succeed({ taskId: payload.taskId, path: "progress.md" })
      },
      projectionQueries: {
        getExecutionEvidencePage: async (payload) => {
          payloads.push(payload);
          return {
            ok: true,
            groups: [],
            stats: {
              totalExecutions: 7,
              archivalExecutions: 0,
              realExecutions: 7,
              totalOutputs: 0,
              passingReceiptOutputs: 0,
              tasksWithExecutions: 0
            },
            nextCursor: null
          };
        }
      }
    });

    const result = await service.getExecutionEvidencePage({ limit: 25 });
    assert.equal(result.ok, true);
    assert.equal(result.stats.totalExecutions, 7);
    assert.deepEqual(payloads, [{ limit: 25 }]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("local controller service honors explicit authored root for reads and writes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-app-"));
  const layoutOverrides = { authoredRoot: ".custom-harness" };
  try {
    writeTaskIndex(rootDir, "task-1", "Custom Task", "planned", layoutOverrides.authoredRoot);
    writeAuthoredDocument(rootDir, "adr/custom.md", "# Custom ADR\n", layoutOverrides.authoredRoot);
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
    assert.deepEqual(await service.getPeripheralDocuments(), {
      ok: true,
      documents: [{ path: "adr/custom.md" }]
    });
    assert.deepEqual(await service.getPeripheralDocument({ path: "adr/custom.md" }), {
      ok: true,
      path: "adr/custom.md",
      body: "# Custom ADR\n"
    });
    assert.deepEqual(await service.appendTaskProgress({ taskId: "task-1", text: "custom progress" }), { ok: true });
    assert.match(readFileSync(path.join(rootDir, ".custom-harness/tasks/task-1/progress.md"), "utf8"), /custom progress/);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-1/INDEX.md")), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("local controller service fails loudly when tasks root equals authored root", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-app-"));
  try {
    writeAuthoredDocument(rootDir, "harness.yaml", [
      "schema: harness-anything/v1",
      "layout:",
      "  authoredRoot: harness",
      "tasks:",
      "  root: harness",
      ""
    ].join("\n"));
    writeAuthoredDocument(rootDir, "adr.md", "# ADR\n");
    const service = makeLocalControllerService({
      rootDir,
      artifactStore: makeMarkdownArtifactStore({ rootDir }),
      taskWriter: {
        setStatus: (payload) => Effect.succeed({ taskId: payload.taskId, status: payload.status }),
        appendProgress: (payload) => Effect.succeed({ taskId: payload.taskId, path: "progress.md" })
      }
    });

    assert.deepEqual(await service.getPeripheralDocuments(), {
      ok: false,
      error: {
        code: "invalid_layout",
        hint: "Peripheral documents require tasksRoot to differ from authoredRoot."
      }
    });
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

function writeTaskDocument(rootDir: string, taskId: string, documentPath: string, body: string): void {
  const target = path.join(rootDir, "harness/tasks", taskId, documentPath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}

function writeAuthoredDocument(rootDir: string, documentPath: string, body: string, authoredRoot = "harness"): void {
  const target = path.join(rootDir, authoredRoot, documentPath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
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
    "proposedAt: \"2026-07-07T00:00:00.000Z\"",
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
  writeDecisionAttributionEvents(rootDir, decisionId);
}

function writeDecisionAttributionEvents(rootDir: string, decisionId: string): void {
  const eventsDir = path.join(rootDir, "harness/attribution-events");
  mkdirSync(eventsDir, { recursive: true });
  const base = {
    schema: "attribution-event/v1",
    journalRecordSchema: "write-journal/v2",
    entityId: `decision/${decisionId}`,
    principalSource: { kind: "migration", evidenceRef: "test/local-controller" },
    recordedAt: "2026-07-07T01:00:00.000Z",
    payloadHash: "test-payload-hash",
    payloadRef: { path: "test/local-controller", sha256: "test-payload-sha" }
  } as const;
  writeFileSync(path.join(eventsDir, `${decisionId}-propose.jsonl`), `${JSON.stringify({
    ...base,
    eventId: `evt_${decisionId}_propose`,
    opId: `op_${decisionId}_propose`,
    kind: "decision_propose",
    actor: { principal: { kind: "person", personId: "ZeyuLi" }, executor: { kind: "agent", id: "codex" } },
    executorSource: "client-asserted",
    at: "2026-07-07T00:00:00.000Z"
  })}\n`, "utf8");
  writeFileSync(path.join(eventsDir, `${decisionId}-accept.jsonl`), `${JSON.stringify({
    ...base,
    eventId: `evt_${decisionId}_accept`,
    opId: `op_${decisionId}_accept`,
    kind: "decision_accept",
    actor: { principal: { kind: "person", personId: "ZeyuLi" }, executor: null },
    executorSource: "none",
    at: "2026-07-07T01:00:00.000Z"
  })}\n`, "utf8");
}
