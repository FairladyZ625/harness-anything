// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { Schema } from "effect";
import {
  computeExecutionConsentPin,
  consentDeclaration,
  entityRegistry,
  type ConsentRecord,
  type ExecutionRecord
} from "../../src/index.ts";

const taskId = "task_01KX7H00000000000000000010";
const executionId = "exe_01KX7H00000000000000000010";
const consentId = "cns_01KX7H00000000000000000010";
const reviewId = "rev_01KX7H00000000000000000010";

test("Consent is a hosted entity with strict channel, scope, and terminal-state invariants", () => {
  const open = consentRecord();
  assert.deepEqual(decode(open), open);
  const locator = entityRegistry.consent.storageLocator;
  assert.equal(locator.status, "ready");
  if (locator.status === "ready") {
    assert.equal(locator.locator.locate({ taskId, consentId }, {}).targets[0]?.path, `tasks/${taskId}/consents/${consentId}.md`);
  }

  assert.deepEqual(decode({
    ...open,
    state: "consumed",
    consumed_by: `review/${taskId}/${reviewId}`,
    consumed_at: "2026-07-15T00:02:00.000Z"
  }).state, "consumed");
  assert.equal(decode({ ...open, state: "expired" }).state, "expired");
  assert.equal(decode({
    ...open,
    channel: { kind: "gui-click", assurance: "authenticated-interaction" },
    response: { kind: "interaction", interaction_ref: "interaction/consent-test", label: "Approve and complete" },
    recorded_by: { ...open.recorded_by, executor: null }
  }).channel.kind, "gui-click");

  assert.throws(() => decode({
    ...open,
    scope: { ...open.scope, actions: ["complete_task"] }
  }), /Predicate refinement failure/u);
  assert.throws(() => decode({ ...open, state: "consumed" }), /consumed_by/u);
  assert.throws(() => decode({
    ...open,
    channel: { kind: "gui-click", assurance: "authenticated-interaction" }
  }), /Predicate refinement failure/u);
  assert.throws(() => decode({
    ...open,
    channel: { kind: "human-cli", assurance: "principal-bound-command" }
  }), /Predicate refinement failure/u);
  assert.throws(() => decode({
    ...open,
    recorded_by: { ...open.recorded_by, principal: { personId: "mallory" } }
  }), /Predicate refinement failure/u);
});

test("Execution consent pin changes before TTL whenever the submitted delivery changes", () => {
  const execution = executionRecord();
  const first = computeExecutionConsentPin(execution);
  assert.match(first, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(computeExecutionConsentPin({ ...execution }), first);
  assert.notEqual(computeExecutionConsentPin({
    ...execution,
    submission: { ...execution.submission!, completion_claim: "changed after consent" }
  }), first);
});

test("legacy consent documents decode as legacy-unrecorded rather than asserted", () => {
  const current = consentRecord();
  const { source: _source, ...legacy } = current;
  const decoded = consentDeclaration.documentCodec.decode(JSON.stringify({ ...legacy, schema: "consent/v1" })) as ConsentRecord;
  assert.equal(decoded.schema, "consent/v2");
  assert.deepEqual(decoded.source, { strength: "legacy-unrecorded" });
});

function decode(value: unknown): ConsentRecord {
  return Schema.decodeUnknownSync(consentDeclaration.schema)(value) as ConsentRecord;
}

function consentRecord(): ConsentRecord {
  return {
    schema: "consent/v2",
    consent_id: consentId,
    task_ref: `task/${taskId}`,
    execution_ref: `execution/${taskId}/${executionId}`,
    principal: { personId: "alice" },
    scope: {
      actions: ["approve_execution", "complete_task"],
      content_pin: { algorithm: "execution-consent-pin/v1", digest: computeExecutionConsentPin(executionRecord()) }
    },
    disclosure: { completion_claim: "ship it", known_gaps: [], residual_risks: [] },
    channel: { kind: "agent-relayed", assurance: "relayed-assertion" },
    response: { kind: "authorization-declaration", source: "asserted" },
    source: { strength: "asserted", rationale: "Approval was received through an external channel." },
    recorded_by: executionRecord().primary_actor,
    granted_at: "2026-07-15T00:01:00.000Z",
    expires_at: "2026-07-16T00:01:00.000Z",
    state: "open",
    consumed_by: null,
    consumed_at: null
  };
}

function executionRecord(): ExecutionRecord {
  return {
    schema: "execution/v2",
    execution_id: executionId,
    task_ref: `task/${taskId}`,
    state: "submitted",
    primary_actor: {
      principal: { personId: "alice" },
      executor: { kind: "agent", id: "worker" },
      responsibleHuman: "alice"
    },
    claimed_at: "2026-07-15T00:00:00.000Z",
    submitted_at: "2026-07-15T00:00:30.000Z",
    closed_at: null,
    session_bindings: [],
    outputs: [],
    submission: {
      completion_claim: "ship it",
      deliverables: ["consent gate"],
      evidence_refs: [],
      verification_notes: ["tests passed"],
      known_gaps: [],
      residual_risks: []
    }
  };
}
