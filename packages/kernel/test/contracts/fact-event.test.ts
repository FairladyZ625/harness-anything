// harness-test-tier: contract
import assert from "node:assert/strict";
import { Schema } from "effect";
import test from "node:test";
import { compileFactWrite, FactEventSchema, parseCanonicalEvent, serializeCanonicalEvent, type FactEventDraftV1 } from "../../src/index.ts";
import { validateFactEvent } from "../../src/domain/fact-event.ts";

const draft: FactEventDraftV1 = { schema: "fact-event/v1", eventId: "event-fact-contract", workspaceRevision: 1, opId: "op-fact-contract",
  taskId: "task-contract", factId: "F-ABCDEFGH", type: "fact_recorded", actor: { principal: { personId: "person-contract" }, executor: null }, source: "local",
  occurredAt: "2026-08-13T00:00:00.000Z", payload: { statement: "Closed Fact payload", evidenceSource: "contract fixture", observedAt: "2026-08-13T00:00:00.000Z",
    confidence: "high", memoryClass: "semantic", memoryTags: ["pattern"], provenance: [{ runtime: "human", sessionId: "session-contract", boundAt: "2026-08-13T00:00:00.000Z" }] } }, event = compileFactWrite({ event: draft, packagePath: "tasks/task-contract-contract", currentFacts: [] }).event;

test("Fact event schema accepts canonical bytes and rejects invalid or unknown fields", () => {
  assert.deepEqual(validateFactEvent(event), []);
  assert.deepEqual(Schema.decodeUnknownSync(FactEventSchema)(event), event);
  assert.deepEqual(parseCanonicalEvent(serializeCanonicalEvent(event)), event);
  for (const invalid of [
    { ...event, unexpected: true },
    { ...event, factId: "F-bad" },
    { ...event, taskId: "task/unsafe" },
    { ...event, occurredAt: "not-a-timestamp" },
    { ...event, payload: { ...event.payload, unexpected: true } },
    { ...event, payload: { ...event.payload, statement: "   " } },
    { ...event, payload: { ...event.payload, observedAt: "not-a-timestamp" } },
    { ...event, payload: { ...event.payload, memoryTags: ["pattern", "pattern"] } },
    { ...event, payload: { ...event.payload, provenance: [{ ...event.payload.provenance[0]!, token: "not allowed" }] } },
    { ...event, payload: { ...event.payload, provenance: [event.payload.provenance[0]!, { ...event.payload.provenance[0]!, boundAt: "2026-08-13T00:00:01.000Z" }] } },
    { ...event, payload: { ...event.payload, supersedes: { factRef: "fact/task-contract/F-12345678", rationale: "x".repeat(200) } } }
  ]) {
    assert.notDeepEqual(validateFactEvent(invalid), [], JSON.stringify(invalid));
    assert.throws(() => Schema.decodeUnknownSync(FactEventSchema)(invalid), JSON.stringify(invalid));
  }
  assert.throws(() => parseCanonicalEvent(`${JSON.stringify({ ...event, schema: "unknown-event/v1" })}\n`), /unknown/u);
});

test("Fact compiler renders the exact machine-owned file and retires superseded history", () => { const first = compileFactWrite({ event: draft, packagePath: "tasks/task-contract-contract", currentFacts: [] }); assert.equal(first.body, "# Facts\n\nManaged by `ha fact record`; hand edits are rejected.\n\n## Records\n\n### F-ABCDEFGH\n\n- Statement: Closed Fact payload\n- Evidence source: contract fixture\n- Observed at: 2026-08-13T00:00:00.000Z\n- Confidence: high\n- State: live\n\n"); const secondDraft: FactEventDraftV1 = { ...draft, eventId: "event-fact-correction", opId: "op-fact-correction", workspaceRevision: 2, factId: "F-BCDEFGHJ", payload: { ...draft.payload, statement: "Corrected payload", supersedes: { factRef: "fact/task-contract/F-ABCDEFGH", rationale: "New evidence" } } }, second = compileFactWrite({ event: secondDraft, packagePath: "tasks/task-contract-contract", currentFacts: [{ factId: draft.factId, statement: draft.payload.statement, evidenceSource: draft.payload.evidenceSource, observedAt: draft.payload.observedAt, confidence: draft.payload.confidence, state: "live", workspaceRevision: draft.workspaceRevision }] }); assert.match(second.body, /### F-ABCDEFGH[\s\S]*State: retired[\s\S]*### F-BCDEFGHJ[\s\S]*State: live/u); });
