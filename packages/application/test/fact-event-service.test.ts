// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeDecisionService, makeFactService } from "../src/index.ts";
import { canonicalEventWritePlan, compileFactWrite, deriveRelationId, isTaskEvent, makeTaskEventStore, makeTaskProjection, taskLifecycleWritePlan, type CanonicalEventStore, type CanonicalEventV1, type CanonicalWriteBundle, type DecisionEventV1, type FactEventDraftV1, type FactEventV1, type TaskProjection } from "../../kernel/src/index.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";

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
    const draft: FactEventDraftV1 = {
      schema: "fact-event/v1", eventId: "event-fact-1", workspaceRevision: 1, opId: "op-fact-1",
      taskId: "task-fact", factId: "F-ABCDEFGH", type: "fact_recorded", actor, source: "local",
      occurredAt: "2026-08-13T00:00:00.000Z", payload: { statement: "SQLite FTS is the Fact read path.", evidenceSource: "integration test",
        observedAt: "2026-08-13T00:00:00.000Z", confidence: "high", memoryClass: "semantic", memoryTags: ["pattern", "abstract_rule"],
        provenance: [{ runtime: "codex", sessionId: "session-fact", boundAt: "2026-08-13T00:00:00.000Z" },
          { runtime: "human", sessionId: "session-review", boundAt: "2026-08-13T00:00:01.000Z" }] }
    };

    const event = compile(projection, draft), recorded = service.record(event);
    assert.equal(recorded.fact.factId, "F-ABCDEFGH");
    assert.deepEqual(recorded.fact.memoryTags, event.event.payload.memoryTags);
    assert.deepEqual(recorded.fact.provenance, event.event.payload.provenance);
    assert.equal(store.readEvent(event.event.opId)?.schema, "fact-event/v1");
    assert.deepEqual(service.search({ query: "SQLite", taskId: "task-fact" }).facts, [recorded.fact]);
    assert.deepEqual(service.show("task-fact", "F-ABCDEFGH").fact, recorded.fact);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Fact opId replay is byte-idempotent and conflicts on different bytes", () => {
  withFixture(({ service, projection }) => {
    const bundle = compile(projection, factEvent(1, "task-fact", "F-ABCDEFGH"));
    assert.deepEqual(service.record(bundle), service.record(bundle));
    assert.throws(() => service.record(compile(projection, { ...bundle.event, payload: { ...bundle.event.payload, statement: "Different bytes" } })), (error: unknown) => code(error) === "op_conflict");
  });
});

test("Fact identity is task-local and supersedes only a known live Fact", () => {
  withFixture(({ service, projection }) => {
    recordFact(service, projection, factEvent(1, "task-a", "F-ABCDEFGH"));
    recordFact(service, projection, factEvent(2, "task-b", "F-ABCDEFGH"));
    const correction = recordFact(service, projection, factEvent(3, "task-a", "F-BCDEFGHJ", { factRef: "fact/task-a/F-ABCDEFGH", rationale: "Corrects the original observation." }));
    assert.equal(service.show("task-a", "F-ABCDEFGH").fact.state, "retired");
    assert.equal(correction.fact.state, "live");
    assert.throws(() => recordFact(service, projection, factEvent(4, "task-a", "F-CDEFGHJK", { factRef: "fact/task-a/F-ABCDEFGH", rationale: "Cannot retire twice." })), (error: unknown) => code(error) === "relation_invalid");
    assert.throws(() => recordFact(service, projection, factEvent(4, "task-a", "F-DEFGHJKM", { factRef: "fact/task-a/F-12345678", rationale: "Missing target." })), (error: unknown) => code(error) === "entity_not_found");
    assert.throws(() => recordFact(service, projection, factEvent(4, "task-a", "F-BCDEFGHJ")), (error: unknown) => code(error) === "invalid_transition");
    const factsPath = "tasks/task-a-fixture/facts.md", before = { facts: service.search({ taskId: "task-a" }).facts, document: projection.readDocument(factsPath).document }; rmSync(projection.path, { force: true }); projection.rebuild(); assert.deepEqual({ facts: service.search({ taskId: "task-a" }).facts, document: projection.readDocument(factsPath).document }, before);
  });
});

test("search catches up a Fact committed to L1 before the projection transaction", () => {
  withFixture(({ store, projection, service }) => {
    const original = compile(projection, factEvent(1, "task-fact", "F-ABCDEFGH")); store.append(original); projection.apply(original.event, original.plan); const correction = compile(projection, factEvent(2, "task-fact", "F-BCDEFGHJ", { factRef: "fact/task-fact/F-ABCDEFGH", rationale: "New observation." })); store.append(correction);
    const search = service.search({ query: "Fact", taskId: "task-fact" });
    assert.equal(search.status, "ready"); assert.equal(search.watermark, 2); assert.equal(service.show("task-fact", "F-ABCDEFGH").fact.state, "retired");
    assert.deepEqual(projection.readFactGraph().edges.map((edge) => [edge.sourceRef, edge.targetRef, edge.state]), [["fact/task-fact/F-BCDEFGHJ", "fact/task-fact/F-ABCDEFGH", "active"]]);
  });
});

test("Fact admission never appends against a projection more than one catch-up round behind", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-fact-backlog-"));
  try {
    const backlog = factBacklog(65, "task-backlog");
    const store = memoryFactStore(backlog), projection = makeTaskProjection({ rootDir, eventStore: store }), service = makeFactService({ eventStore: store, projection });
    const collision = factEvent(66, "task-backlog", "F-00000065"), first = projection.searchFacts({ taskId: "task-backlog" });
    assert.equal(first.status, "pending");
    assert.equal(store.readHead()?.revision, 65, "pending admission must not append");
    assert.equal(service.show("task-backlog", "F-00000065").fact.factId, "F-00000065");
    assert.throws(() => service.record(compile(projection, collision)), (error: unknown) => code(error) === "invalid_transition");
    assert.equal(store.readHead()?.revision, 65, "collision must be found before append");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("Decision transition matrix, independent arbiter, claims, relation retirement, and replay are canonical", () => {
  withDecisionFixture(({ service, projection }) => { const proposed = decisionEvent(1, "decision_proposed"); assert.deepEqual(service.record(proposed), service.record(proposed));
    const rejectsRelation = (relation: ReturnType<typeof relationRecord>, expected: string) => assert.throws(() => service.record(decisionEvent(2, "decision_related", undefined, relation)), (error: unknown) => code(error) === expected);
    rejectsRelation(relationRecord("decision/dec_OTHER/CH1", "decision/dec_FIXTURE/CH1", "supports"), "relation_invalid");
    rejectsRelation(relationRecord("decision/dec_FIXTURE/C404", "decision/dec_FIXTURE/CH1", "supports"), "anchor_not_found");
    rejectsRelation(relationRecord("decision/dec_FIXTURE/CH1", "fact/task-fact/F-12345678", "evidenced-by"), "entity_not_found");
    rejectsRelation(relationRecord("decision/dec_FIXTURE/CH1", "decision/dec_FIXTURE/RJ1", "produces"), "relation_invalid");
    rejectsRelation({ ...relationRecord("decision/dec_FIXTURE/CH1", "decision/dec_FIXTURE/RJ1", "supports"), relation_id: "rel_0000000000000000" }, "relation_invalid");
    assert.throws(() => service.record(decisionEvent(2, "decision_accepted", actor)), (error: unknown) => code(error) === "invalid_transition"); const accepted = service.record(decisionEvent(2, "decision_accepted")); assert.equal(accepted.decision.state, "accepted");
    service.record(decisionEvent(3, "decision_claim_declared")); service.record(decisionEvent(4, "decision_claim_fulfillment_declared")); assert.deepEqual(projection.readDecisionGraph().decisionAnchors[0]?.anchorRefs, ["decision/dec_FIXTURE", "decision/dec_FIXTURE/C1", "decision/dec_FIXTURE/CH1", "decision/dec_FIXTURE/RJ1"]); const relation = relationRecord("decision/dec_FIXTURE/C1", "decision/dec_FIXTURE/CH1", "supports"), relationId = relation.relation_id; service.record(decisionEvent(5, "decision_related", undefined, relation)); service.record(decisionEvent(6, "decision_relation_retired", undefined, relationId));
    const edge = projection.readDecisionGraph().edges[0]!; assert.equal(edge.state, "retired"); assert.equal(edge.retiredRevision, 6); assert.equal(service.record(decisionEvent(7, "decision_retired")).decision.state, "retired"); assert.throws(() => service.record(decisionEvent(8, "decision_deferred")), (error: unknown) => code(error) === "invalid_transition");
    const before = { decision: service.show("dec_FIXTURE").decision, graph: projection.readDecisionGraph() }; rmSync(projection.path, { force: true }); projection.rebuild(); assert.deepEqual({ decision: service.show("dec_FIXTURE").decision, graph: projection.readDecisionGraph() }, before);
  });
  for (const terminal of ["decision_rejected", "decision_deferred"] as const) withDecisionFixture(({ service }) => { service.record(decisionEvent(1, "decision_proposed")); assert.equal(service.record(decisionEvent(2, terminal)).decision.state, terminal.slice(9)); });
});

test("Decision read catches up an L1-only proposal and exposes the explicit body-null crash window", () => {
  withDecisionFixture(({ store, service }) => { const proposed = decisionEvent(1, "decision_proposed"); store.append(bundle(proposed)); const searched = service.search({ query: "Canonical" }); assert.equal(searched.status, "ready"); assert.equal(searched.watermark, 1); assert.equal(searched.decisions[0]?.body, null); assert.equal(service.show("dec_FIXTURE").decision.body, null); });
});

test("Decision coverage replays all fulfillment modes, refutation, and exact task_completed basis", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-coverage-"));
  try {
    git(rootDir, "init", "--quiet"); git(rootDir, "config", "user.name", "Coverage Test"); git(rootDir, "config", "user.email", "coverage@example.invalid"); git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
    const store = makeTaskEventStore({ repoId: "coverage-test", rootDir }), projection = makeTaskProjection({ rootDir, eventStore: store });
    for (const event of lifecycleFixture().events) { const compiled = bundle(event); store.append(compiled); projection.apply(event, compiled.plan); }
    const factService = makeFactService({ eventStore: store, projection }), decisionService = makeDecisionService({ eventStore: store, projection });
    recordFact(factService, projection, factEvent(7, "task-1", "F-ABCDEFGH")); recordFact(factService, projection, factEvent(8, "task-1", "F-BCDEFGHJ"));
    let revision = 9;
    const record = (decisionId: string, type: DecisionEventV1["type"], payload: unknown, eventActor = type === "decision_proposed" ? actor : { principal: { personId: "person-arbiter" }, executor: null } as const) => decisionService.record(decisionAt(revision++, decisionId, type, payload, eventActor));
    const propose = (decisionId: string, decisionClass: "ordinary" | "standing_policy" = "ordinary") => record(decisionId, "decision_proposed", { title: decisionId, question: `Should ${decisionId} hold?`, riskTier: "medium", urgency: "medium", vertical: "default", preset: "default", appliesTo: { modules: ["kernel"], productLines: [] }, decisionClass, chosen: [{ id: "CH1", text: "Proceed" }], rejected: [{ id: "RJ1", text: "Stop", whyNot: "Evidence supports proceeding" }] });
    const claim = (decisionId: string, mode: "evidenced" | "delivered" | "standing_policy") => { record(decisionId, "decision_claim_declared", { claimId: "C1", text: `${decisionId} is fulfilled`, loadBearing: true }); record(decisionId, "decision_claim_fulfillment_declared", { claimId: "C1", mode }); };
    const relate = (decisionId: string, source: string, target: string, type: "derives" | "evidenced-by" | "refuted-by") => { const identity = { source, target, type, direction: "directed" as const }; record(decisionId, "decision_related", { relation: { relation_id: deriveRelationId(identity), ...identity, strength: "strong", origin: "declared", rationale: "Canonical coverage evidence", state: "active" } }); };
    propose("dec_STANDING", "standing_policy"); record("dec_STANDING", "decision_accepted", { rationale: "Independent acceptance" }); claim("dec_STANDING", "standing_policy");
    propose("dec_DELIVERED"); record("dec_DELIVERED", "decision_accepted", { rationale: "Independent acceptance" }); claim("dec_DELIVERED", "delivered"); relate("dec_DELIVERED", "decision/dec_DELIVERED/C1", "task/task-1", "derives");
    propose("dec_EVIDENCED"); record("dec_EVIDENCED", "decision_accepted", { rationale: "Independent acceptance" }); claim("dec_EVIDENCED", "evidenced"); relate("dec_EVIDENCED", "decision/dec_EVIDENCED/C1", "fact/task-1/F-ABCDEFGH", "evidenced-by"); relate("dec_EVIDENCED", "decision/dec_EVIDENCED/C1", "fact/task-1/F-BCDEFGHJ", "refuted-by");
    const graph = decisionService.graph(); assert.equal(graph.status, "ready"); assert.equal(graph.watermark, revision - 1);
    const byDecision = new Map(graph.coverageRows.map((row) => [row.decisionRef, row]));
    assert.equal(byDecision.get("decision/dec_STANDING")?.status, "covered"); assert.equal(byDecision.get("decision/dec_STANDING")?.fulfillment, "standing_policy");
    assert.equal(byDecision.get("decision/dec_DELIVERED")?.status, "covered", "task_completed is the delivered truth source"); assert.equal(byDecision.get("decision/dec_DELIVERED")?.fulfillment, "delivered");
    assert.equal(byDecision.get("decision/dec_EVIDENCED")?.status, "uncovered"); assert.deepEqual(byDecision.get("decision/dec_EVIDENCED")?.refutingFactRefs, ["fact/task-1/F-BCDEFGHJ"]);
    assert.equal(graph.coverageRows.every((row) => row.basisRevision === graph.watermark), true);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

function withFixture(run: (fixture: { readonly store: ReturnType<typeof makeTaskEventStore>; readonly projection: ReturnType<typeof makeTaskProjection>; readonly service: ReturnType<typeof makeFactService> }) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-fact-service-"));
  try { git(rootDir, "init", "--quiet"); git(rootDir, "config", "user.name", "Fact Test"); git(rootDir, "config", "user.email", "fact@example.invalid"); git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
    const store = makeTaskEventStore({ repoId: "fact-test", rootDir }), projection = makeTaskProjection({ rootDir, eventStore: store }); run({ store, projection, service: makeFactService({ eventStore: store, projection }) });
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
}
function withDecisionFixture(run: (fixture: { readonly store: ReturnType<typeof makeTaskEventStore>; readonly projection: ReturnType<typeof makeTaskProjection>; readonly service: ReturnType<typeof makeDecisionService> }) => void): void { const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-service-")); try { git(rootDir, "init", "--quiet"); git(rootDir, "config", "user.name", "Decision Test"); git(rootDir, "config", "user.email", "decision@example.invalid"); git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base"); const store = makeTaskEventStore({ repoId: "decision-test", rootDir }), projection = makeTaskProjection({ rootDir, eventStore: store }); run({ store, projection, service: makeDecisionService({ eventStore: store, projection }) }); } finally { rmSync(rootDir, { recursive: true, force: true }); } }
function decisionEvent(revision: number, type: DecisionEventV1["type"], eventActor = { principal: { personId: "person-arbiter" }, executor: null } as const, extra?: unknown): DecisionEventV1 { const base = { schema: "decision-event/v1" as const, eventId: `event-decision-${revision}`, workspaceRevision: revision, opId: `op-decision-${revision}`, decisionId: "dec_FIXTURE", actor: type === "decision_proposed" ? actor : eventActor, source: "local" as const, occurredAt: new Date(Date.UTC(2026, 7, 13, 1, 0, revision)).toISOString() }; if (type === "decision_proposed") return { ...base, type, payload: { title: "Canonical Decision", question: "Should this Decision be event-backed?", riskTier: "medium", urgency: "medium", vertical: "default", preset: "default", appliesTo: { modules: ["kernel"], productLines: [] }, decisionClass: "ordinary", chosen: [{ id: "CH1", text: "Use events", rationale: "Replayable" }], rejected: [{ id: "RJ1", text: "Use markdown", whyNot: "Not canonical" }] } }; if (type === "decision_accepted") return { ...base, type, payload: { rationale: "Independent approval." } }; if (type === "decision_rejected" || type === "decision_deferred" || type === "decision_retired") return { ...base, type, payload: { reason: "Recorded outcome." } }; if (type === "decision_claim_declared") return { ...base, type, payload: { claimId: "C1", text: "The event is deterministic.", loadBearing: true } }; if (type === "decision_claim_fulfillment_declared") return { ...base, type, payload: { claimId: "C1", mode: "evidenced" } }; if (type === "decision_related") return { ...base, type, payload: { relation: extra as never } }; return { ...base, type, payload: { relationId: String(extra), reason: "The edge is no longer current." } }; }
function decisionAt(revision: number, decisionId: string, type: DecisionEventV1["type"], payload: unknown, eventActor: DecisionEventV1["actor"]): DecisionEventV1 { return { schema: "decision-event/v1", eventId: `event-${decisionId}-${revision}`, workspaceRevision: revision, opId: `op-${decisionId}-${revision}`, decisionId, type, actor: eventActor, source: "local", occurredAt: new Date(Date.UTC(2026, 7, 13, 2, 0, revision)).toISOString(), payload } as DecisionEventV1; }
function relationRecord(source: string, target: string, type: "supports" | "produces" | "evidenced-by") { const identity = { source, target, type, direction: "directed" as const }; return { relation_id: deriveRelationId(identity), ...identity, strength: "strong" as const, origin: "declared" as const, rationale: "Canonical Decision relation.", state: "active" as const }; }
function factEvent(revision: number, taskId: string, factId: string, supersedes?: { readonly factRef: string; readonly rationale: string }): FactEventDraftV1 { return {
  schema: "fact-event/v1", eventId: `event-fact-${revision}`, workspaceRevision: revision, opId: `op-fact-${revision}`, taskId, factId, type: "fact_recorded", actor, source: "local",
  occurredAt: new Date(Date.UTC(2026, 7, 13, 0, 0, revision)).toISOString(), payload: { statement: `Fact observation ${revision}`, evidenceSource: "integration test", observedAt: new Date(Date.UTC(2026, 7, 13, 0, 0, revision)).toISOString(),
    confidence: "high", memoryClass: "semantic", memoryTags: ["pattern"], provenance: [{ runtime: "codex", sessionId: "session-fact", boundAt: "2026-08-13T00:00:00.000Z" }], ...(supersedes ? { supersedes } : {}) }
}; }
function compile(projection: Pick<TaskProjection, "searchFacts">, draft: FactEventDraftV1) { return compileFactWrite({ event: draft, packagePath: `tasks/${draft.taskId}-fixture`, currentFacts: projection.searchFacts({ taskId: draft.taskId }).facts }); }
function recordFact(service: ReturnType<typeof makeFactService>, projection: Pick<TaskProjection, "searchFacts">, draft: FactEventDraftV1) { return service.record(compile(projection, draft)); }
function factBacklog(count: number, taskId: string) { const events: FactEventV1[] = [], records: Parameters<typeof compileFactWrite>[0]["currentFacts"][number][] = [], contents = new Map<string, Uint8Array>(); for (let index = 0; index < count; index += 1) { const compiled = compileFactWrite({ event: factEvent(index + 1, taskId, `F-${String(index + 1).padStart(8, "0")}`), packagePath: `tasks/${taskId}-fixture`, currentFacts: records }); events.push(compiled.event); contents.set(compiled.event.payload.factsDocumentClaim.sha256, Buffer.from(compiled.body)); records.push({ factId: compiled.event.factId, statement: compiled.event.payload.statement, evidenceSource: compiled.event.payload.evidenceSource, observedAt: compiled.event.payload.observedAt, confidence: compiled.event.payload.confidence, state: "live", workspaceRevision: compiled.event.workspaceRevision }); } return { events, contents }; }
function code(error: unknown): string | undefined { return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined; }
function bundle(event: CanonicalEventV1): CanonicalWriteBundle { return { event, plan: isTaskEvent(event) ? taskLifecycleWritePlan(event) : canonicalEventWritePlan(event, "test/v1", event.opId), blobs: [] }; }

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
function memoryFactStore(initial: ReturnType<typeof factBacklog>): CanonicalEventStore {
  const events = [...initial.events], contents = new Map(initial.contents);
  return { readHead: () => events.length ? { revision: events.length } : null, readBatch: (cursor: string | null, maxItems: number) => {
    const start = cursor === null ? 0 : Number(cursor), batch = events.slice(start, start + maxItems), next = start + batch.length;
    return { sourceRevision: events.length, events: batch, cursor: String(next), done: next === events.length, accessedItems: batch.length };
  }, readContentBlob: (sha256: string) => contents.get(sha256) ?? null, readEvent: (opId: string) => events.find((event) => event.opId === opId) ?? null,
  append: ((bundleValue: CanonicalWriteBundle) => { const event = bundleValue.event as FactEventV1; events.push(event); for (const blob of bundleValue.blobs) contents.set(blob.sha256, Buffer.from(blob.body)); return { revision: event.workspaceRevision, commitSha: { sha: "0".repeat(40) } }; }) } as unknown as CanonicalEventStore;
}
