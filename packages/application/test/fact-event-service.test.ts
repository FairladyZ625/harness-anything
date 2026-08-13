// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeFactService } from "../src/index.ts";
import { makeTaskEventStore, makeTaskProjection, type CanonicalEventStore, type FactEventV1 } from "../../kernel/src/index.ts";

const actor = { principal: { personId: "person-fact" }, executor: { kind: "agent", id: "codex" } } as const;

test("recorded Fact is durable and immediately searchable through the canonical projection", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-fact-service-"));
  try {
    git(rootDir, "init", "--quiet");
    git(rootDir, "config", "user.name", "Fact Test");
    git(rootDir, "config", "user.email", "fact@example.invalid");
    git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
    const store = makeTaskEventStore({ repoId: "fact-test", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore: store });
    const service = makeFactService({ eventStore: store, projection });
    const event: FactEventV1 = {
      schema: "fact-event/v1", eventId: "event-fact-1", workspaceRevision: 1, opId: "op-fact-1",
      taskId: "task-fact", factId: "F-ABCDEFGH", type: "fact_recorded", actor, source: "local",
      occurredAt: "2026-08-13T00:00:00.000Z", payload: { statement: "SQLite FTS is the Fact read path.", evidenceSource: "integration test",
        observedAt: "2026-08-13T00:00:00.000Z", confidence: "high", memoryClass: "semantic", memoryTags: ["pattern", "abstract_rule"],
        provenance: [{ runtime: "codex", sessionId: "session-fact", boundAt: "2026-08-13T00:00:00.000Z" },
          { runtime: "human", sessionId: "session-review", boundAt: "2026-08-13T00:00:01.000Z" }] }
    };

    const recorded = service.record(event);
    assert.equal(recorded.fact.factId, "F-ABCDEFGH");
    assert.deepEqual(recorded.fact.memoryTags, event.payload.memoryTags);
    assert.deepEqual(recorded.fact.provenance, event.payload.provenance);
    assert.equal(store.readEvent(event.opId)?.schema, "fact-event/v1");
    assert.deepEqual(service.search({ query: "SQLite", taskId: "task-fact" }).facts, [recorded.fact]);
    assert.deepEqual(service.show("task-fact", "F-ABCDEFGH").fact, recorded.fact);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Fact opId replay is byte-idempotent and conflicts on different bytes", () => {
  withFixture(({ service }) => {
    const event = factEvent(1, "task-fact", "F-ABCDEFGH");
    assert.deepEqual(service.record(event), service.record(event));
    assert.throws(() => service.record({ ...event, payload: { ...event.payload, statement: "Different bytes" } }), (error: unknown) => code(error) === "op_conflict");
  });
});

test("Fact identity is task-local and supersedes only a known live Fact", () => {
  withFixture(({ service }) => {
    service.record(factEvent(1, "task-a", "F-ABCDEFGH"));
    service.record(factEvent(2, "task-b", "F-ABCDEFGH"));
    const correction = service.record(factEvent(3, "task-a", "F-BCDEFGHJ", { factRef: "fact/task-a/F-ABCDEFGH", rationale: "Corrects the original observation." }));
    assert.equal(service.show("task-a", "F-ABCDEFGH").fact.state, "retired");
    assert.equal(correction.fact.state, "live");
    assert.throws(() => service.record(factEvent(4, "task-a", "F-CDEFGHJK", { factRef: "fact/task-a/F-ABCDEFGH", rationale: "Cannot retire twice." })), (error: unknown) => code(error) === "relation_invalid");
    assert.throws(() => service.record(factEvent(4, "task-a", "F-DEFGHJKM", { factRef: "fact/task-a/F-12345678", rationale: "Missing target." })), (error: unknown) => code(error) === "entity_not_found");
    assert.throws(() => service.record(factEvent(4, "task-a", "F-BCDEFGHJ")), (error: unknown) => code(error) === "invalid_transition");
  });
});

test("search catches up a Fact committed to L1 before the projection transaction", () => {
  withFixture(({ store, projection, service }) => {
    const original = factEvent(1, "task-fact", "F-ABCDEFGH"), correction = factEvent(2, "task-fact", "F-BCDEFGHJ", { factRef: "fact/task-fact/F-ABCDEFGH", rationale: "New observation." });
    store.append(original); projection.apply(original); store.append(correction);
    const search = service.search({ query: "Fact", taskId: "task-fact" });
    assert.equal(search.status, "ready"); assert.equal(search.watermark, 2); assert.equal(service.show("task-fact", "F-ABCDEFGH").fact.state, "retired");
    assert.deepEqual(projection.readFactGraph().edges.map((edge) => [edge.sourceRef, edge.targetRef, edge.state]), [["fact/task-fact/F-BCDEFGHJ", "fact/task-fact/F-ABCDEFGH", "active"]]);
  });
});

test("Fact admission never appends against a projection more than one catch-up round behind", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-fact-backlog-"));
  try {
    const backlog = Array.from({ length: 65 }, (_, index) => factEvent(index + 1, "task-backlog", `F-${String(index + 1).padStart(8, "0")}`));
    const store = memoryFactStore(backlog), projection = makeTaskProjection({ rootDir, eventStore: store }), service = makeFactService({ eventStore: store, projection });
    const collision = factEvent(66, "task-backlog", "F-00000065");
    assert.throws(() => service.record(collision), (error: unknown) => code(error) === "content_not_ready");
    assert.equal(store.readHead()?.revision, 65, "pending admission must not append");
    assert.equal(service.show("task-backlog", "F-00000065").fact.factId, "F-00000065");
    assert.throws(() => service.record(collision), (error: unknown) => code(error) === "invalid_transition");
    assert.equal(store.readHead()?.revision, 65, "collision must be found before append");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

function withFixture(run: (fixture: { readonly store: ReturnType<typeof makeTaskEventStore>; readonly projection: ReturnType<typeof makeTaskProjection>; readonly service: ReturnType<typeof makeFactService> }) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-fact-service-"));
  try { git(rootDir, "init", "--quiet"); git(rootDir, "config", "user.name", "Fact Test"); git(rootDir, "config", "user.email", "fact@example.invalid"); git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
    const store = makeTaskEventStore({ repoId: "fact-test", rootDir }), projection = makeTaskProjection({ rootDir, eventStore: store }); run({ store, projection, service: makeFactService({ eventStore: store, projection }) });
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
}
function factEvent(revision: number, taskId: string, factId: string, supersedes?: { readonly factRef: string; readonly rationale: string }): FactEventV1 { return {
  schema: "fact-event/v1", eventId: `event-fact-${revision}`, workspaceRevision: revision, opId: `op-fact-${revision}`, taskId, factId, type: "fact_recorded", actor, source: "local",
  occurredAt: new Date(Date.UTC(2026, 7, 13, 0, 0, revision)).toISOString(), payload: { statement: `Fact observation ${revision}`, evidenceSource: "integration test", observedAt: new Date(Date.UTC(2026, 7, 13, 0, 0, revision)).toISOString(),
    confidence: "high", memoryClass: "semantic", memoryTags: ["pattern"], provenance: [{ runtime: "codex", sessionId: "session-fact", boundAt: "2026-08-13T00:00:00.000Z" }], ...(supersedes ? { supersedes } : {}) }
}; }
function code(error: unknown): string | undefined { return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined; }

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
function memoryFactStore(initial: readonly FactEventV1[]): CanonicalEventStore {
  const events = [...initial];
  return { readHead: () => events.length ? { revision: events.length } : null, readBatch: (cursor: string | null, maxItems: number) => {
    const start = cursor === null ? 0 : Number(cursor), batch = events.slice(start, start + maxItems), next = start + batch.length;
    return { sourceRevision: events.length, events: batch, cursor: String(next), done: next === events.length, accessedItems: batch.length };
  }, readContentBlob: () => null, readEvent: (opId: string) => events.find((event) => event.opId === opId) ?? null,
  append: ((event: FactEventV1) => { events.push(event); return { revision: event.workspaceRevision }; }) } as unknown as CanonicalEventStore;
}
