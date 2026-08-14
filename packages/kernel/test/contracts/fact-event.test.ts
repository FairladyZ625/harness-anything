// harness-test-tier: contract
import assert from "node:assert/strict";
import { Schema } from "effect";
import test from "node:test";
import { compileDecisionWrite, compileFactWrite, FactEventSchema, parseCanonicalEvent, serializeCanonicalEvent, type DecisionEventDraftV1, type FactEventDraftV1 } from "../../src/index.ts";
import { assertDecisionWritePlan } from "../../src/domain/fact-event.ts";
import { DecisionEventSchema } from "../../src/schemas/fact-event.ts";
import { validateDecisionEvent, validateFactEvent } from "../../src/domain/fact-event.ts";

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

const decisionDraft: DecisionEventDraftV1 = { schema: "decision-event/v1", eventId: "event-decision-contract", workspaceRevision: 1, opId: "op-decision-contract", decisionId: "dec_CONTRACT", type: "decision_proposed", actor: { principal: { personId: "person-proposer" }, executor: null }, source: "local", occurredAt: "2026-08-14T00:00:00.000Z", payload: { title: "Canonical Decision", question: "Should the authored document be canonical?", riskTier: "medium", urgency: "high", vertical: "software/coding", preset: "standard-task", appliesTo: { modules: ["kernel"], productLines: [] }, decisionClass: "ordinary", chosen: [{ id: "CH1", text: "Use the bundle" }], rejected: [{ id: "RJ1", text: "Use split files", whyNot: "They drift." }] } }, decision = compileDecisionWrite({ event: decisionDraft, currentDecision: null, currentRelations: [], currentDocument: null });

test("Decision event schema requires the exact authored mutation claim", () => {
  assert.deepEqual(validateDecisionEvent(decision.event), []); assert.deepEqual(Schema.decodeUnknownSync(DecisionEventSchema)(decision.event), decision.event); assert.deepEqual(parseCanonicalEvent(serializeCanonicalEvent(decision.event)), decision.event);
  for (const invalid of [decisionDraft, { ...decision.event, unexpected: true }, { ...decision.event, payload: { ...decision.event.payload, unexpected: true } }, { ...decision.event, payload: { ...decision.event.payload, baseDocumentSha256: "0".repeat(64) } }, { ...decision.event, payload: { ...decision.event.payload, decisionDocumentClaim: { ...decision.event.payload.decisionDocumentClaim, path: "decisions/decision-dec_OTHER/decision.md" } } }, { ...decision.event, payload: { ...decision.event.payload, decisionDocumentClaim: { ...decision.event.payload.decisionDocumentClaim, sha256: "bad" } } }]) { assert.notDeepEqual(validateDecisionEvent(invalid), [], JSON.stringify(invalid)); assert.throws(() => Schema.decodeUnknownSync(DecisionEventSchema)(invalid), JSON.stringify(invalid)); }
});

test("Decision compiler renders the exact single-file package and frozen write plan", () => {
  assert.equal(decision.path, "decisions/decision-dec_CONTRACT/decision.md"); assertDecisionWritePlan(decision.event, decision.plan); assert.deepEqual(decision.plan.targets.map(({ kind }) => kind), ["event_file", "event_head", "authored_file", "content_blob", "projection_invalidation", "projection_invalidation"]); assert.deepEqual(decision.blobs[0], { sha256: decision.event.payload.decisionDocumentClaim.sha256, size: decision.event.payload.decisionDocumentClaim.size, mediaType: "text/markdown", body: decision.body });
  assert.equal(decision.body, `---\nschema: decision-package/v1\ndecision_id: dec_CONTRACT\nworkspaceRevision: 1\ntitle: "Canonical Decision"\nstate: proposed\nriskTier: medium\nurgency: high\nvertical: "software/coding"\npreset: "standard-task"\ndecisionClass: ordinary\napplies_to: {"modules":["kernel"],"productLines":[]}\nproposer: {"executor":null,"principal":{"personId":"person-proposer"}}\narbiter: null\nproposedAt: "2026-08-14T00:00:00.000Z"\ndecidedAt: null\nquestion: "Should the authored document be canonical?"\nchosen: [{"id":"CH1","text":"Use the bundle"}]\nrejected: [{"id":"RJ1","text":"Use split files","whyNot":"They drift."}]\nclaims: []\nrelations: []\n---\n\n# Canonical Decision\n`);
  assert.throws(() => compileDecisionWrite({ event: { ...decisionDraft, type: "decision_accepted", payload: { rationale: "No base" } }, currentDecision: null, currentRelations: [], currentDocument: null }), /base must agree/u);
});
