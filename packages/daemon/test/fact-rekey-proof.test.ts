// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  decisionMachineDigest,
  reduceDecisionDocument,
  reviewDigest,
  type DecisionDocumentState,
  type DecisionEventV1,
  type TaskEventV1,
} from "../../kernel/src/index.ts";
import { rekeyDecisionProofs, rekeyReviewConsentProof, rekeySupersededLegacyEntityClaim } from "../src/fact-rekey.ts";

const actor = {
  principal: { personId: "person-rekey" },
  executor: { kind: "agent", id: "codex" },
} as const;

test("fact rekey repins decision outcome content to its projected state", () => {
  const current: DecisionDocumentState = {
    decisionId: "dec_REKEY",
    state: "proposed",
    title: "Rekey decision",
    question: "Does the pin follow the outcome?",
    riskTier: "low",
    urgency: "low",
    vertical: "software/coding",
    preset: "standard-task",
    decisionClass: "ordinary",
    appliesTo: { modules: [], productLines: [] },
    proposer: actor,
    arbiter: null,
    proposedAt: "2026-08-28T00:00:00.000Z",
    decidedAt: null,
    workspaceRevision: 1,
    chosen: [{ id: "CH1", text: "Keep the pin current" }],
    rejected: [{ id: "RJ1", text: "Keep the old state", whyNot: "It contradicts the outcome" }],
    claims: [],
    relations: [],
    provenance: [],
    judgmentConsents: [],
  };
  const event = {
    schema: "decision-event/v1",
    eventId: "event-rekey-accepted",
    workspaceRevision: 2,
    opId: "op-rekey-accepted",
    type: "decision_accepted",
    actor,
    source: "local",
    occurredAt: "2026-08-28T00:01:00.000Z",
    decisionId: current.decisionId,
    payload: {
      rationale: "The outcome is accepted.",
      judgmentOnlyRationale: null,
      fulfillments: [],
      standingPolicy: false,
      judgmentConsent: {
        schema: "decision-judgment-consent/v1",
        consentId: "djc_00000000000000000000000000",
        decisionId: current.decisionId,
        action: "accept",
        targetState: "in_effect",
        machineDigest: decisionMachineDigest(current),
        actor,
        source: "local",
        consentedAt: "2026-08-28T00:01:00.000Z",
      },
      contentPin: {
        schema: "decision-content-pin/v1",
        pinId: "dcp_00000000000000000000000000",
        action: "accept",
        state: "proposed",
        pinnedAt: "2026-08-28T00:01:00.000Z",
        evidence: "historical pin",
        actor,
        digest: decisionMachineDigest(current),
      },
      baseDocumentSha256: "base-document",
      decisionDocumentClaim: {
        path: "decisions/decision-dec_REKEY/decision.md",
        sha256: "document-sha",
        size: 0,
        mediaType: "text/markdown",
        policyId: "markdown-body-replaceable/v1",
      },
    },
  } as unknown as DecisionEventV1;
  const rewritten = rekeyDecisionProofs(event, current),
    reduced = reduceDecisionDocument(current, event);
  assert.equal(rewritten.payload.contentPin?.state, reduced.state);
  assert.equal(rewritten.payload.contentPin?.digest, decisionMachineDigest(reduced));
  assert.equal(rewritten.payload.judgmentConsent?.machineDigest, decisionMachineDigest(current));
  assert.notDeepEqual(rewritten.payload.contentPin, event.payload.contentPin);
});

test("fact rekey repins review consent after evidence refs change", () => {
  const legacyReview = {
      schema: "review/v1",
      reviewId: "review-rekey",
      taskId: "task-rekey",
      executionId: "execution-rekey",
      verdict: "approved",
      actor,
      capabilityRef: "transport-reviewer:person-rekey",
      reason: "The migrated fact supports the result.",
      evidenceChecked: ["fact/task-rekey/F-ABCDEFGH"],
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      iteration: 0,
      contentDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      reviewedAt: "2026-08-28T00:01:00.000Z",
    } as const,
    review = { ...legacyReview, evidenceChecked: ["fact/F-ABCDEFGH"] },
    event = {
      schema: "task-event/v1",
      type: "review_consent_recorded",
      payload: {
        review,
        consent: {
          reviewDigest: reviewDigest(legacyReview),
        },
      },
    } as unknown as Extract<TaskEventV1, { readonly type: "review_consent_recorded" }>;
  const rewritten = rekeyReviewConsentProof(event);
  assert.equal(rewritten.payload.consent.reviewDigest, reviewDigest(review));
  assert.notEqual(rewritten.payload.consent.reviewDigest, event.payload.consent.reviewDigest);
});

test("fact rekey repoints superseded legacy squad claims to the current declaration", () => {
  const legacy = {
      schema: "agent-entity-event/v1" as const,
      payload: {
        entityKind: "squad",
        entityId: "core-squad",
        declarationDocumentClaim: {
          path: "squads/core-squad.json",
          sha256: "legacy-sha",
          size: 100,
          mediaType: "application/json",
          policyId: "typed-agent-entity/v1",
        },
      },
    },
    currentClaim = {
      path: "squads/core-squad.json",
      sha256: "current-sha",
      size: 120,
      mediaType: "application/json",
      policyId: "typed-entity/v1",
    };
  const rewritten = rekeySupersededLegacyEntityClaim(legacy, currentClaim);
  assert.deepEqual(rewritten.payload.declarationDocumentClaim, currentClaim);
  assert.deepEqual(legacy.payload.declarationDocumentClaim, {
    path: "squads/core-squad.json",
    sha256: "legacy-sha",
    size: 100,
    mediaType: "application/json",
    policyId: "typed-agent-entity/v1",
  });
});
