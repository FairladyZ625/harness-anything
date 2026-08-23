// harness-test-tier: contract
import assert from "node:assert/strict";
import { Schema } from "effect";
import test from "node:test";
import { compileDecisionWrite, compileFactWrite, deriveRelationId, FactEventSchema, parseCanonicalEvent, serializeCanonicalEvent, type DecisionEventDraftV1, type FactEventDraftV1 } from "../../src/index.ts";
import { assertDecisionJudgmentConsent, assertDecisionWritePlan, decisionMachineDigest, type DecisionDocumentState } from "../../src/domain/decision-event.ts";
import { DecisionEventSchema } from "../../src/schemas/decision-event.ts";
import { validateCurrentDecisionEvent, validateDecisionEvent } from "../../src/domain/decision-event.ts";
import { validateCurrentFactEvent, validateFactEvent } from "../../src/domain/fact-event.ts";

const draft: FactEventDraftV1 = { schema: "fact-event/v1", eventId: "event-fact-contract", workspaceRevision: 1, opId: "op-fact-contract",
  taskId: "task-contract", factId: "F-ABCDEFGH", type: "fact_recorded", actor: { principal: { personId: "person-contract" }, executor: null }, source: "local",
  occurredAt: "2026-08-13T00:00:00.000Z", payload: { statement: "Closed Fact payload", evidenceSource: "contract fixture", observedAt: "2026-08-13T00:00:00.000Z",
    confidence: "high", memoryClass: "semantic", memoryTags: ["pattern"], provenance: [{ runtime: "unavailable", sessionId: null, transcriptReachability: "unavailable", boundAt: "2026-08-13T00:00:00.000Z" }] } }, event = compileFactWrite({ event: draft, packagePath: "tasks/task-contract-contract", currentFacts: [] }).event;

test("Fact event reader ignores unknown fields while the current writer stays strict", () => {
  assert.deepEqual(validateFactEvent(event), []);
  assert.deepEqual(Schema.decodeUnknownSync(FactEventSchema)(event), event);
  assert.deepEqual(parseCanonicalEvent(serializeCanonicalEvent(event)), event);
  const additive = [
    { ...event, unexpected: true },
    { ...event, payload: { ...event.payload, unexpected: true } },
    { ...event, payload: { ...event.payload, provenance: [{ ...event.payload.provenance[0]!, token: "future field" }] } }
  ];
  for (const future of additive) {
    assert.deepEqual(validateFactEvent(future), [], JSON.stringify(future));
    assert.notDeepEqual(validateCurrentFactEvent(future), [], JSON.stringify(future));
  }
  for (const invalid of [
    { ...event, factId: "F-bad" },
    { ...event, taskId: "task/unsafe" },
    { ...event, occurredAt: "not-a-timestamp" },
    { ...event, payload: { ...event.payload, statement: "   " } },
    { ...event, payload: { ...event.payload, observedAt: "not-a-timestamp" } },
    { ...event, payload: { ...event.payload, memoryTags: ["pattern", "pattern"] } },
    { ...event, payload: { ...event.payload, provenance: [event.payload.provenance[0]!, { ...event.payload.provenance[0]!, boundAt: "2026-08-13T00:00:01.000Z" }] } },
    { ...event, payload: { ...event.payload, supersedes: { factRef: "fact/task-contract/F-12345678", rationale: "x".repeat(200) } } }
  ]) {
    assert.notDeepEqual(validateFactEvent(invalid), [], JSON.stringify(invalid));
    assert.throws(() => Schema.decodeUnknownSync(FactEventSchema)(invalid), JSON.stringify(invalid));
  }
  assert.throws(() => parseCanonicalEvent(`${JSON.stringify({ ...event, schema: "unknown-event/v1" })}\n`), /unknown/u);
});

test("Fact compiler renders the exact machine-owned file and retires superseded history", () => { const first = compileFactWrite({ event: draft, packagePath: "tasks/task-contract-contract", currentFacts: [] }); assert.equal(first.body, "# Facts\n\nManaged by `ha fact record`; hand edits are rejected.\n\n## Records\n\n### F-ABCDEFGH\n\n- Statement: Closed Fact payload\n- Evidence source: contract fixture\n- Observed at: 2026-08-13T00:00:00.000Z\n- Confidence: high\n- State: standing\n\n"); const secondDraft: FactEventDraftV1 = { ...draft, eventId: "event-fact-correction", opId: "op-fact-correction", workspaceRevision: 2, factId: "F-BCDEFGHJ", payload: { ...draft.payload, statement: "Corrected payload", supersedes: { factRef: "fact/task-contract/F-ABCDEFGH", rationale: "New evidence" } } }, second = compileFactWrite({ event: secondDraft, packagePath: "tasks/task-contract-contract", currentFacts: [{ factId: draft.factId, statement: draft.payload.statement, evidenceSource: draft.payload.evidenceSource, observedAt: draft.payload.observedAt, confidence: draft.payload.confidence, state: "standing", workspaceRevision: draft.workspaceRevision }] }); assert.match(second.body, /### F-ABCDEFGH[\s\S]*State: superseded_fact[\s\S]*### F-BCDEFGHJ[\s\S]*State: standing/u); });

const initialRelationIdentity = { source: "decision/dec_CONTRACT/C1", target: "decision/dec_CONTRACT/CH1", type: "supports" as const, direction: "directed" as const }, initialRelation = { relation_id: deriveRelationId(initialRelationIdentity), ...initialRelationIdentity, strength: "strong" as const, origin: "declared" as const, rationale: "The claim supports the chosen option.", state: "active" as const };
const decisionDraft: DecisionEventDraftV1 = { schema: "decision-event/v1", eventId: "event-decision-contract", workspaceRevision: 1, opId: "op-decision-contract", decisionId: "dec_CONTRACT", type: "decision_proposed", actor: { principal: { personId: "person-proposer" }, executor: null }, source: "local", occurredAt: "2026-08-14T00:00:00.000Z", payload: { title: "Canonical Decision", question: "Should the authored document be canonical?", riskTier: "medium", urgency: "high", vertical: "software/coding", preset: "standard-task", appliesTo: { modules: ["kernel"], productLines: [] }, decisionClass: "ordinary", chosen: [{ id: "CH1", text: "Use the bundle" }], rejected: [{ id: "RJ1", text: "Use split files", whyNot: "They drift." }], body: "# Canonical Decision\n\n初始正文。\n", claims: [{ id: "C1", text: "One bundle is atomic.", loadBearing: true }], fulfillments: [{ claimId: "C1", mode: "evidenced" }], relations: [initialRelation] } }, decision = compileDecisionWrite({ event: decisionDraft, currentDecision: null, currentRelations: [], currentDocument: null });

test("Decision event reader ignores additions while the current writer requires its exact authored mutation claim", () => {
  assert.deepEqual(validateDecisionEvent(decision.event), []); assert.deepEqual(Schema.decodeUnknownSync(DecisionEventSchema)(decision.event), decision.event); assert.deepEqual(parseCanonicalEvent(serializeCanonicalEvent(decision.event)), decision.event);
  for (const future of [{ ...decision.event, unexpected: true }, { ...decision.event, payload: { ...decision.event.payload, unexpected: true } }]) { assert.deepEqual(validateDecisionEvent(future), [], JSON.stringify(future)); assert.notDeepEqual(validateCurrentDecisionEvent(future), [], JSON.stringify(future)); }
  for (const invalid of [decisionDraft, { ...decision.event, payload: { ...decision.event.payload, baseDocumentSha256: "0".repeat(64) } }, { ...decision.event, payload: { ...decision.event.payload, decisionDocumentClaim: { ...decision.event.payload.decisionDocumentClaim, path: "decisions/decision-dec_OTHER/decision.md" } } }, { ...decision.event, payload: { ...decision.event.payload, decisionDocumentClaim: { ...decision.event.payload.decisionDocumentClaim, sha256: "bad" } } }]) { assert.notDeepEqual(validateDecisionEvent(invalid), [], JSON.stringify(invalid)); assert.throws(() => Schema.decodeUnknownSync(DecisionEventSchema)(invalid), JSON.stringify(invalid)); }
});

test("Decision compiler renders the exact single-file package and frozen write plan", () => {
  assert.equal(decision.path, "decisions/decision-dec_CONTRACT/decision.md"); assertDecisionWritePlan(decision.event, decision.plan); assert.deepEqual(decision.plan.targets.map(({ kind }) => kind), ["event_file", "event_head", "authored_file", "content_blob", "projection_invalidation", "projection_invalidation", "projection_invalidation", "local_wal_file", "local_wal_file", "local_wal_file"]); assert.deepEqual(decision.blobs[0], { sha256: decision.event.payload.decisionDocumentClaim.sha256, size: decision.event.payload.decisionDocumentClaim.size, mediaType: "text/markdown", body: decision.body });
  assert.equal(decision.body.includes('claims: [{"fulfillment":"evidenced","id":"C1","loadBearing":true,"text":"One bundle is atomic."}]'), true); assert.match(decision.body, new RegExp(`relations: .*${initialRelation.relation_id}`, "u")); assert.equal(decision.body.endsWith("---\n# Canonical Decision\n\n初始正文。\n"), true);
  assert.throws(() => compileDecisionWrite({ event: { ...decisionDraft, type: "decision_accepted", payload: { rationale: "No base" } }, currentDecision: null, currentRelations: [], currentDocument: null }), /base must agree/u);
});

test("Decision outcome embeds an independently verifiable machine-content consent", () => {
  const current = { decisionId: decisionDraft.decisionId, state: "proposed", title: decisionDraft.payload.title, question: decisionDraft.payload.question, riskTier: decisionDraft.payload.riskTier, urgency: decisionDraft.payload.urgency, vertical: decisionDraft.payload.vertical, preset: decisionDraft.payload.preset, decisionClass: decisionDraft.payload.decisionClass, appliesTo: decisionDraft.payload.appliesTo, proposer: decisionDraft.actor, arbiter: null, proposedAt: decisionDraft.occurredAt, decidedAt: null, workspaceRevision: 1, chosen: decisionDraft.payload.chosen, rejected: decisionDraft.payload.rejected, claims: [], judgmentConsents: [] } satisfies Omit<DecisionDocumentState, "relations">;
  const outcome = { ...decisionDraft, eventId: "event-decision-accept", workspaceRevision: 2, opId: "op-decision-accept", type: "decision_accepted", actor: { principal: { personId: "person-proposer" }, executor: null }, occurredAt: "2026-08-14T00:01:00.000Z", payload: { rationale: "CEO judgment.", judgmentOnlyRationale: "CEO explicitly judges without evidence." } } as const satisfies DecisionEventDraftV1;
  const accepted = compileDecisionWrite({ event: outcome, currentDecision: current, currentRelations: [], currentDocument: { blobSha256: decision.event.payload.decisionDocumentClaim.sha256, body: decision.body } });
  const consent = accepted.event.payload.judgmentConsent;
  assert.deepEqual({ schema: consent.schema, decisionId: consent.decisionId, action: consent.action, targetState: consent.targetState, actor: consent.actor, source: consent.source, consentedAt: consent.consentedAt }, { schema: "decision-judgment-consent/v1", decisionId: "dec_CONTRACT", action: "accept", targetState: "in_effect", actor: outcome.actor, source: outcome.source, consentedAt: outcome.occurredAt });
  assert.equal(consent.machineDigest, decisionMachineDigest({ ...current, relations: [] })); assert.match(consent.consentId, /^djc_[0-9a-f]{26}$/u); assert.deepEqual(validateDecisionEvent(accepted.event), []); assert.match(accepted.body, new RegExp(`judgmentConsents: .*${consent.consentId}`, "u"));
  const nestedFuture = { ...accepted.event, payload: { ...accepted.event.payload, judgmentConsent: { ...consent, actor: { ...consent.actor, futureOptionalField: true } } } };
  assert.deepEqual(validateDecisionEvent(nestedFuture), []); assert.notDeepEqual(validateCurrentDecisionEvent(nestedFuture), []);
  const proseOnly = compileDecisionWrite({ event: outcome, currentDecision: current, currentRelations: [], currentDocument: { blobSha256: decision.event.payload.decisionDocumentClaim.sha256, body: decision.body.replace("# Canonical Decision", "# Hand-edited prose") } });
  assert.equal(proseOnly.event.payload.judgmentConsent.machineDigest, consent.machineDigest, "prose is outside the machine-content pin");
  for (const invalidConsent of [{ ...consent, actor: { principal: { personId: "other" }, executor: null } }, { ...consent, source: "remote_direct" }]) assert.notDeepEqual(validateDecisionEvent({ ...accepted.event, payload: { ...accepted.event.payload, judgmentConsent: invalidConsent } }), []);
  const digestTampered = { ...accepted.event, payload: { ...accepted.event.payload, judgmentConsent: { ...consent, machineDigest: `sha256:${"0".repeat(64)}` as const } } }; assert.throws(() => assertDecisionJudgmentConsent({ ...current, relations: [] }, digestTampered), /machine content cut/u);
  const { judgmentConsent: _consent, ...legacy } = accepted.event.payload;
  assert.notDeepEqual(validateDecisionEvent({ ...accepted.event, payload: legacy }), []); assert.notDeepEqual(validateDecisionEvent({ ...accepted.event, payload: { ...legacy, contentPins: [{ digest: consent.machineDigest }] } }), []);
});

// #1546: the proposal validator answered every shape failure with one sentence, so a rejected packet
// had to be bisected by hand. Each wrong field must now name itself, and several wrong fields at once
// must all be named — while the accept/reject verdict stays exactly what it was.
test("#1546: a rejected Decision proposal names every field that is actually wrong", () => {
  const payload = decision.event.payload, event = (next: Record<string, unknown>) => ({ ...decision.event, payload: { ...payload, ...next } });
  assert.deepEqual(validateDecisionEvent(decision.event), []);
  for (const [next, pattern] of [
    [{ title: "" }, /^title must be a non-empty string$/u],
    [{ question: "" }, /^question must be 1\.\.499 code points$/u],
    [{ riskTier: "urgent" }, /^riskTier must be low, medium, or high$/u],
    [{ urgency: "someday" }, /^urgency must be low, medium, or high$/u],
    [{ vertical: "" }, /^vertical must be a non-empty string$/u],
    [{ decisionClass: "informal" }, /^decisionClass must be ordinary or standing_policy$/u],
    [{ appliesTo: { modules: ["kernel", "kernel"], productLines: [] } }, /^appliesTo must carry exactly/u],
    [{ body: 7 }, /^body must be a string$/u],
    [{ chosen: [] }, /^chosen must be a non-empty array$/u],
    [{ claims: "none" }, /^claims must be an array$/u],
    [{ chosen: [{ id: "XX1", text: "Wrong prefix" }] }, /^every chosen entry needs a CH id/u],
    [{ rejected: [{ id: "RJ1", text: "No reason given", whyNot: "" }] }, /^every rejected entry needs an RJ id/u],
    [{ claims: [{ id: "C1", text: "Bad flag", loadBearing: "yes" }] }, /^every claim needs a C id/u],
    [{ fulfillments: [{ claimId: "C1", mode: "wished" }] }, /^every fulfillment needs a claimId and a mode of/u],
    [{ fulfillments: [{ claimId: "C9", mode: "evidenced" }] }, /^every fulfillment must name a distinct claim/u]
  ] as const) {
    const issues = validateDecisionEvent(event(next as Record<string, unknown>));
    assert.equal(issues.length, 1, `${JSON.stringify(next)} -> ${JSON.stringify(issues)}`);
    assert.match(issues[0]!, pattern, JSON.stringify(next));
  }
  // Several wrong fields at once are all reported, not just the first one the old chain hit.
  const many = validateDecisionEvent(event({ title: "", riskTier: "urgent", body: 7 }));
  assert.equal(many.length, 3, JSON.stringify(many));
  assert.deepEqual([...many].sort(), ["body must be a string", "riskTier must be low, medium, or high", "title must be a non-empty string"]);
  // A wrong field SET still fails closed as one message naming the exact contract.
  const { relations: _relations, ...missing } = payload;
  assert.deepEqual(validateDecisionEvent({ ...decision.event, payload: missing }), ["decision proposal requires exactly: title, question, riskTier, urgency, vertical, preset, appliesTo, decisionClass, chosen, rejected, body, claims, fulfillments, relations, provenance"]);
});
