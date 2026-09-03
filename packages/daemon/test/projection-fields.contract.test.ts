// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { decisionCapabilities, decisionClaimsOpen } from "../../kernel/src/domain/decision-board-projection.ts";
import { relationIsCurrent, type DecisionState } from "../../kernel/src/index.ts";
import { validateDaemonDecisionList, validateDaemonRelationGraph } from "../src/protocol/daemon-protocol.contract.ts";

test("decision full rows carry kernel capabilities while summary rows stay narrow", () => {
  const state: DecisionState = "proposed";
  const row = {
    schema: "decision-row/v1",
    decisionId: "dec_contract",
    path: "decisions/decision-dec_contract/decision.md",
    state,
    title: "Projection contract",
    question: "Which layer owns the judgment?",
    riskTier: "medium",
    urgency: "medium",
    vertical: "software/coding",
    preset: "docs-task",
    decisionClass: "ordinary",
    appliesTo: { modules: [], productLines: [] },
    proposer: { principal: { personId: "person-owner" }, executor: null },
    arbiter: null,
    proposedAt: "2026-09-03T00:00:00.000Z",
    decidedAt: null,
    workspaceRevision: 1,
    chosen: [],
    rejected: [],
    claims: [],
    judgmentConsents: [],
    body: null,
    capabilities: decisionCapabilities(state),
    claimsOpen: decisionClaimsOpen(state),
  } as const;
  const full = { ok: true, projection: "full", decisions: [row], warnings: [] } as const;
  assert.deepEqual(validateDaemonDecisionList(full), []);
  assert.notDeepEqual(
    validateDaemonDecisionList({
      ...full,
      decisions: [{ ...row, capabilities: [{ id: "accept", available: false, reason: "free text" }] }],
    }),
    [],
  );
  assert.deepEqual(
    validateDaemonDecisionList({
      ok: true,
      projection: "summary",
      decisions: [{ decisionId: row.decisionId, title: row.title, state, appliesTo: row.appliesTo }],
      warnings: [],
    }),
    [],
  );
});

test("relation and coverage booleans equal the kernel judgments and reject malformed wire rows", () => {
  const currentEdge = edge({ freshness: "current" }),
    refusedEdge = edge({ relationId: "rel_refused", freshness: "suspect" }),
    coverage = {
      decisionRef: "decision/dec_contract",
      claimRef: "decision/dec_contract/C1",
      status: "covered",
      covered: true,
      fulfillment: "evidenced",
      relationPath: [currentEdge.relationId],
    } as const,
    payload = {
      ok: true,
      status: "ready",
      watermark: 1,
      sourceRevision: 1,
      edges: [
        { ...currentEdge, current: relationIsCurrent(currentEdge) },
        { ...refusedEdge, current: relationIsCurrent(refusedEdge) },
      ],
      coverageRows: [coverage],
      factAnchors: [],
      facts: [],
      warnings: [],
    } as const;
  assert.deepEqual(validateDaemonRelationGraph(payload), []);
  assert.equal(payload.edges[0].current, true);
  assert.equal(payload.edges[1].current, false, "active strong suspect is the intentional renderer divergence");
  assert.notDeepEqual(validateDaemonRelationGraph({ ...payload, coverageRows: [{ ...coverage, covered: "yes" }] }), []);
  assert.notDeepEqual(
    validateDaemonRelationGraph({ ...payload, edges: [{ ...payload.edges[0], current: "yes" }] }),
    [],
  );
});

function edge(overrides: Readonly<Record<string, unknown>>) {
  return {
    relationId: "rel_current",
    sourceRef: "decision/dec_contract/C1",
    targetRef: "fact/F-CONTRACT",
    relationType: "evidenced-by" as const,
    direction: "directed" as const,
    strength: "strong" as const,
    origin: "declared" as const,
    state: "active" as const,
    targetObservedVersion: 1,
    currentTargetVersion: 1,
    freshness: "current" as const,
    rationale: "Projection fixture",
    ownerRef: "decision/dec_contract",
    sourcePath: "decisions/decision-dec_contract/decision.md",
    recordIndex: 0,
    ...overrides,
  };
}
