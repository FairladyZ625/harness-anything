// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { makeDecisionWriteService } from "../src/index.ts";
import type {
  DecisionPackage,
  UnionAttributionEvent,
  WriteAttribution,
  WriteCoordinator,
  WriteOp
} from "../../kernel/src/index.ts";

const humanAttribution: WriteAttribution = {
  actor: { principal: { kind: "person", personId: "person_zeyu" }, executor: null },
  principalSource: { kind: "migration", evidenceRef: "v2-upgrade-fixture" },
  executorSource: "none"
};

test("a human may judge from an existing V2 propose mutation event", () => {
  const enqueued: WriteOp[] = [];
  const service = serviceForAction("propose", enqueued);

  const result = Effect.runSync(service.accept({
    current: decision(),
    judgmentOnlyRationale: "The existing V2 event proves the proposal origin.",
    opIdPrefix: "accept"
  }));

  assert.deepEqual(result, { decisionId: "dec_TEST", state: "active" });
  assert.equal(enqueued.length, 1);
});

test("V2 judgment does not accept the legacy decision_propose WriteOp kind as a mutation action", () => {
  const result = Effect.runSync(serviceForAction("decision_propose", []).accept({
    current: decision(),
    judgmentOnlyRationale: "Aliases must not widen V2 admission."
  }).pipe(Effect.either));

  assert.equal(result._tag, "Left");
  if (result._tag === "Left") {
    assert.match(result.left.reason, /requires an immutable decision_propose attribution event/u);
  }
});

function serviceForAction(action: string, enqueued: WriteOp[]) {
  const event = {
    schema: "attribution-event/v2",
    actorAxesBinding: { principalPersonId: "person_author", executorAgentId: "claude" },
    mutationSet: {
      mutations: [{ entity: { canonicalRef: "decision/dec_TEST" }, action: { action } }]
    }
  } as unknown as UnionAttributionEvent;
  return makeDecisionWriteService({
    coordinator: coordinator(enqueued),
    attribution: humanAttribution,
    readUnionAttributionEvents: () => [event]
  });
}

function coordinator(enqueued: WriteOp[]): WriteCoordinator {
  return {
    enqueue: (operation) => Effect.sync(() => {
      enqueued.push(operation);
      return { opId: operation.opId, entityId: operation.entityId, accepted: true as const };
    }),
    flush: (reason) => Effect.succeed({ reason, opCount: enqueued.length, committed: true }),
    recover: Effect.succeed({ replayedOps: 0 })
  };
}

function decision(): DecisionPackage {
  return {
    schema: "decision-package/v1",
    decision_id: "dec_TEST",
    title: "V2 attribution vocabulary",
    state: "proposed",
    riskTier: "medium",
    urgency: "medium",
    vertical: "software/coding",
    preset: "architecture-decision",
    applies_to: { modules: ["cli"], productLines: [] },
    proposedAt: "2026-07-18T00:00:00.000Z",
    provenance: [{ runtime: "human", sessionId: "upgrade", boundAt: "2026-07-18T00:00:00.000Z" }],
    question: "Should V2 use semantic actions?",
    chosen: [{ id: "CH1", text: "Use propose" }],
    rejected: [{ id: "RJ1", text: "Use decision_propose", why_not: "That is a V1 WriteOp kind" }],
    claims: [{ id: "C1", text: "The event action is registry-defined" }],
    relations: []
  };
}
