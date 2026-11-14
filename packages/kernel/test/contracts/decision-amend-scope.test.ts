// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertDecisionAdmissionAtCut } from "../../src/domain/decision-admission.ts";
import {
  compileDecisionWrite,
  reduceDecisionDocument,
  validateCurrentDecisionEvent,
  validateDecisionEvent,
  type DecisionAmendableSnapshot,
  type DecisionDocumentState,
  type DecisionEventDraftV1,
} from "../../src/domain/decision-event.ts";

const owner = { principal: { personId: "person-owner" }, executor: null },
  appliesTo = { modules: ["kernel"], productLines: ["harness-anything"] };
function current(): DecisionDocumentState {
  return {
    decisionId: "dec_SCOPE",
    state: "in_effect",
    title: "Govern scope",
    question: "Which modules?",
    riskTier: "low",
    urgency: "medium",
    vertical: "software/coding",
    preset: "standard-task",
    decisionClass: "standing_policy",
    appliesTo,
    proposer: owner,
    arbiter: owner,
    proposedAt: "2026-09-01T00:00:00.000Z",
    decidedAt: "2026-09-01T00:01:00.000Z",
    workspaceRevision: 2,
    chosen: [{ id: "CH1", text: "Declare scope" }],
    rejected: [],
    claims: [],
    relations: [],
    provenance: [],
    judgmentConsents: [],
    reviews: [],
    reviewResponses: [],
    reviewOverrides: [],
  };
}
function compile(withScope: boolean, consent = true) {
  const state = current(),
    previous: DecisionAmendableSnapshot = {
      title: state.title,
      decisionClass: state.decisionClass,
      chosen: state.chosen,
      rejected: state.rejected,
      claims: state.claims,
      ...(withScope ? { appliesTo: state.appliesTo } : {}),
    },
    draft: DecisionEventDraftV1 = {
      schema: "decision-event/v1",
      eventId: "event-scope",
      opId: "op-scope",
      workspaceRevision: 3,
      occurredAt: "2026-09-01T00:02:00.000Z",
      actor: owner,
      source: "local",
      decisionId: state.decisionId,
      type: "decision_amended",
      payload: {
        previous,
        next: {
          ...previous,
          ...(withScope ? { appliesTo: { modules: ["storage"], productLines: [] } } : { title: "Revised title" }),
        },
        fields: withScope ? ["appliesTo"] : ["title"],
        reason: "Correct the scope",
        body: null,
        ...(consent
          ? {
              ownerConsent: {
                consentBy: "person-owner",
                consentAt: "2026-09-01T00:02:00.000Z",
                consentChannel: "cli" as const,
                recordedBy: owner,
              },
            }
          : {}),
      },
    };
  return compileDecisionWrite({
    event: draft,
    currentDecision: state,
    currentRelations: [],
    currentDocument: { blobSha256: "0".repeat(64), body: "---\nschema: decision-package/v1\n---\n\nGovern scope.\n" },
    decisionReviewRequirement: "off",
  });
}
const admission = (event: ReturnType<typeof compile>["event"]) =>
  assertDecisionAdmissionAtCut({ document: current(), relations: [], hasSupersedes: false }, event);

test("audited historical amendment without appliesTo replays without resetting scope", () => {
  const bundle = compile(false);
  assert.deepEqual(validateCurrentDecisionEvent(bundle.event), []);
  assert.doesNotThrow(() => admission(bundle.event));
  assert.deepEqual(reduceDecisionDocument(current(), bundle.event).appliesTo, appliesTo);
  const historical = JSON.parse(
    readFileSync(
      new URL(
        "../../fixtures/canonical-events/decision-event-v1/accepted-decision-amended-edaf8e196353.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(validateDecisionEvent(historical), [], "frozen pre-audit event remains valid");
  assert.deepEqual(reduceDecisionDocument(current(), historical).appliesTo, appliesTo);
});

test("scope amendment records digests and enforces in_effect owner consent", () => {
  const bundle = compile(true);
  assert.deepEqual(validateCurrentDecisionEvent(bundle.event), []);
  assert.doesNotThrow(() => admission(bundle.event));
  assert.throws(() => admission(compile(true, false).event), /requires recorded owner consent/u);
  assert.match(bundle.body, /applies_to: \{"modules":\["storage"\],"productLines":\[\]\}/u);
  assert.equal(bundle.event.type, "decision_amended");
  if (bundle.event.type === "decision_amended") {
    assert.equal(bundle.event.payload.amendment.changes?.[0]?.field, "appliesTo");
    assert.notEqual(
      bundle.event.payload.amendment.changes?.[0]?.beforeDigest,
      bundle.event.payload.amendment.changes?.[0]?.afterDigest,
    );
    const stale = structuredClone(bundle.event);
    Object.assign(stale.payload.previous, { appliesTo: { modules: ["daemon"], productLines: [] } });
    assert.throws(() => admission(stale), /previous snapshot does not match/u);
  }
});

test("malformed appliesTo is rejected by current admission and historical replay validation", () => {
  const bundle = compile(true);
  for (const scope of [
    { modules: [42], productLines: [] },
    { modules: ["", ""], productLines: [] },
    { modules: ["kernel", "kernel"], productLines: [] },
    { modules: [], productLines: [false] },
    { modules: [], productLines: [], extra: true },
  ]) {
    const invalid = structuredClone(bundle.event);
    if (invalid.type !== "decision_amended") throw new Error("expected amendment");
    Object.assign(invalid.payload.next, { appliesTo: scope });
    assert.notDeepEqual(validateCurrentDecisionEvent(invalid), []);
    if (!("extra" in scope)) assert.notDeepEqual(validateDecisionEvent(invalid), []);
  }
});
