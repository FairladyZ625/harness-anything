// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeDecisionService, makeFactService } from "../src/index.ts";
import {
  compileDecisionWrite,
  compileFactWrite,
  deriveRelationId,
  isTaskEvent,
  makeTaskEventStore,
  makeTaskProjection,
  taskLifecycleWritePlan,
  type CanonicalEventStore,
  type CanonicalEventV1,
  type CanonicalWriteBundle,
  type DecisionEventDraftV1,
  type FactEventDraftV1,
  type FactEventV1,
  type TaskProjection,
} from "../../kernel/src/index.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";

import {
  actor,
  bundle,
  code,
  compile,
  compileDecision,
  decisionAt,
  decisionEvent,
  factBacklog,
  factEvent,
  git,
  memoryFactStore,
  recordDecision,
  recordFact,
  relationRecord,
  withDecisionFixture,
  withFixture,
} from "./fact-event-service.fixtures.ts";
test("recorded Fact is durable and immediately searchable through the canonical projection", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-fact-service-"));
  let projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    git(rootDir, "init", "--quiet");
    git(rootDir, "config", "user.name", "Fact Test");
    git(rootDir, "config", "user.email", "fact@example.invalid");
    git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
    const store = makeTaskEventStore({ repoId: "fact-test", rootDir });
    projection = makeTaskProjection({ rootDir, eventStore: store });
    const service = makeFactService({ eventStore: store, projection });
    const draft: FactEventDraftV1 = {
      schema: "fact-event/v1",
      eventId: "event-fact-1",
      workspaceRevision: 1,
      opId: "op-fact-1",
      taskId: "task-fact",
      factId: "F-ABCDEFGH",
      type: "fact_recorded",
      actor,
      source: "local",
      occurredAt: "2026-08-13T00:00:00.000Z",
      payload: {
        statement: "SQLite FTS is the Fact read path.",
        evidenceSource: "integration test",
        observedAt: "2026-08-13T00:00:00.000Z",
        confidence: "high",
        memoryClass: "semantic",
        memoryTags: ["pattern", "abstract_rule"],
        provenance: [
          {
            runtime: "codex",
            sessionId: "session-fact",
            transcriptReachability: "by_session_id",
            boundAt: "2026-08-13T00:00:00.000Z",
          },
          {
            runtime: "human",
            sessionId: "session-review",
            transcriptReachability: "by_session_id",
            boundAt: "2026-08-13T00:00:01.000Z",
          },
        ],
      },
    };

    const event = compile(projection, draft),
      recorded = service.record(event);
    assert.equal(recorded.fact.factId, "F-ABCDEFGH");
    assert.deepEqual(recorded.fact.memoryTags, event.event.payload.memoryTags);
    assert.deepEqual(recorded.fact.provenance, event.event.payload.provenance);
    assert.equal(store.readEvent(event.event.opId)?.schema, "fact-event/v1");
    assert.deepEqual(
      service.search({ query: "SQLite", taskId: "task-fact" }).facts,
      [recorded.fact],
    );
    assert.deepEqual(
      service.show("task-fact", "F-ABCDEFGH").fact,
      recorded.fact,
    );
  } finally {
    projection?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Fact opId replay is byte-idempotent and conflicts on different bytes", () => {
  withFixture(({ service, projection }) => {
    const bundle = compile(projection, factEvent(1, "task-fact", "F-ABCDEFGH"));
    assert.deepEqual(service.record(bundle), service.record(bundle));
    assert.throws(
      () =>
        service.record(
          compile(projection, {
            ...bundle.event,
            payload: { ...bundle.event.payload, statement: "Different bytes" },
          }),
        ),
      (error: unknown) => code(error) === "op_conflict",
    );
  });
});

test("Fact identity is task-local and supersedes only a known live Fact", () => {
  withFixture(({ service, projection }) => {
    recordFact(service, projection, factEvent(1, "task-a", "F-ABCDEFGH"));
    recordFact(service, projection, factEvent(2, "task-b", "F-ABCDEFGH"));
    const correction = recordFact(
      service,
      projection,
      factEvent(3, "task-a", "F-BCDEFGHJ", {
        factRef: "fact/task-a/F-ABCDEFGH",
        rationale: "Corrects the original observation.",
      }),
    );
    assert.equal(
      service.show("task-a", "F-ABCDEFGH").fact.state,
      "superseded_fact",
    );
    assert.equal(correction.fact.state, "standing");
    assert.throws(
      () =>
        recordFact(
          service,
          projection,
          factEvent(4, "task-a", "F-CDEFGHJK", {
            factRef: "fact/task-a/F-ABCDEFGH",
            rationale: "Cannot retire twice.",
          }),
        ),
      (error: unknown) => code(error) === "relation_invalid",
    );
    assert.throws(
      () =>
        recordFact(
          service,
          projection,
          factEvent(4, "task-a", "F-DEFGHJKM", {
            factRef: "fact/task-a/F-12345678",
            rationale: "Missing target.",
          }),
        ),
      (error: unknown) => code(error) === "entity_not_found",
    );
    assert.throws(
      () =>
        recordFact(service, projection, factEvent(4, "task-a", "F-BCDEFGHJ")),
      (error: unknown) => code(error) === "invalid_transition",
    );
    const factsPath = "tasks/task-a-fixture/facts.md",
      before = {
        facts: service.search({ taskId: "task-a" }).facts,
        document: projection.readDocument(factsPath).document,
      };
    projection.close();
    rmSync(projection.path, { force: true });
    projection.rebuild();
    assert.deepEqual(
      {
        facts: service.search({ taskId: "task-a" }).facts,
        document: projection.readDocument(factsPath).document,
      },
      before,
    );
  });
});

test("search catches up a Fact committed to L1 before the projection transaction", () => {
  withFixture(({ store, projection, service }) => {
    const original = compile(
      projection,
      factEvent(1, "task-fact", "F-ABCDEFGH"),
    );
    store.append(original);
    projection.apply(original.event, original.plan);
    const correction = compile(
      projection,
      factEvent(2, "task-fact", "F-BCDEFGHJ", {
        factRef: "fact/task-fact/F-ABCDEFGH",
        rationale: "New observation.",
      }),
    );
    store.append(correction);
    const search = service.search({ query: "Fact", taskId: "task-fact" });
    assert.equal(search.status, "ready");
    assert.equal(search.watermark, 2);
    assert.equal(
      service.show("task-fact", "F-ABCDEFGH").fact.state,
      "superseded_fact",
    );
    assert.deepEqual(
      projection
        .readFactGraph()
        .edges.map((edge) => [edge.sourceRef, edge.targetRef, edge.state]),
      [["fact/task-fact/F-BCDEFGHJ", "fact/task-fact/F-ABCDEFGH", "active"]],
    );
  });
});

test("Fact admission never appends against a projection more than one catch-up round behind", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-fact-backlog-"));
  let projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    const backlog = factBacklog(65, "task-backlog");
    const store = memoryFactStore(backlog);
    projection = makeTaskProjection({ rootDir, eventStore: store });
    const service = makeFactService({ eventStore: store, projection });
    const collision = factEvent(66, "task-backlog", "F-00000065"),
      first = projection.searchFacts({ taskId: "task-backlog" });
    assert.equal(first.status, "pending");
    assert.equal(
      store.readHead()?.revision,
      65,
      "pending admission must not append",
    );
    assert.equal(
      service.show("task-backlog", "F-00000065").fact.factId,
      "F-00000065",
    );
    assert.throws(
      () => service.record(compile(projection, collision)),
      (error: unknown) => code(error) === "invalid_transition",
    );
    assert.equal(
      store.readHead()?.revision,
      65,
      "collision must be found before append",
    );
  } finally {
    projection?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
