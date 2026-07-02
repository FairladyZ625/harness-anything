import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { makeDecisionWriteService, type DecisionWriteRejected } from "../src/index.ts";
import type { DecisionPackage, WriteCoordinator, WriteOp } from "../../kernel/src/index.ts";

test("decision write service proposes and accepts through WriteCoordinator", () => {
  const enqueued: WriteOp[] = [];
  const service = makeDecisionWriteService({
    coordinator: fakeCoordinator(enqueued),
    now: () => "2026-07-02T00:00:00Z"
  });
  const proposed = decisionPackage({ state: "proposed" });

  const propose = Effect.runSync(service.propose({ decision: proposed, opIdPrefix: "propose" }));
  const accept = Effect.runSync(service.accept({
    current: proposed,
    arbiter: { kind: "human", id: "ZeyuLi" },
    opIdPrefix: "accept"
  }));

  assert.deepEqual(propose, { decisionId: "dec_TEST", state: "proposed" });
  assert.deepEqual(accept, { decisionId: "dec_TEST", state: "active" });
  assert.equal(enqueued[0]?.kind, "decision_propose");
  assert.equal(enqueued[0]?.entityId, "decision/dec_TEST");
  assert.equal(enqueued[1]?.kind, "decision_accept");
  assert.equal((enqueued[1]?.payload as { decision?: DecisionPackage }).decision?.state, "active");
  assert.equal((enqueued[1]?.payload as { decision?: DecisionPackage }).decision?.decidedAt, "2026-07-02T00:00:00Z");
});

test("decision write service rejects invalid arbiter and unsupported transitions", () => {
  const service = makeDecisionWriteService({ coordinator: fakeCoordinator([]) });
  const proposed = decisionPackage({ state: "proposed", arbiter: { kind: "agent", id: "claude" } });
  const rejected = decisionPackage({ state: "rejected" });

  const selfArbiter = Effect.runSyncExit(service.propose({ decision: proposed }));
  const terminalTransition = Effect.runSyncExit(service.accept({
    current: rejected,
    arbiter: { kind: "human", id: "ZeyuLi" }
  }));

  assert.equal(selfArbiter._tag, "Failure");
  assert.match(failureReason(selfArbiter.cause), /arbiter must differ/u);
  assert.equal(terminalTransition._tag, "Failure");
  assert.match(failureReason(terminalTransition.cause), /terminal_state/u);
});

test("decision write service rejects empty rejected alternatives", () => {
  const service = makeDecisionWriteService({ coordinator: fakeCoordinator([]) });
  const invalid = { ...decisionPackage({ state: "proposed" }), rejected: [] } as unknown as DecisionPackage;
  const result = Effect.runSyncExit(service.propose({ decision: invalid }));

  assert.equal(result._tag, "Failure");
  assert.match(failureReason(result.cause), /rejected alternatives/u);
});

function fakeCoordinator(enqueued: WriteOp[]): WriteCoordinator {
  return {
    enqueue: (op) => Effect.sync(() => {
      enqueued.push(op);
      return { opId: op.opId, entityId: op.entityId, accepted: true };
    }),
    flush: () => Effect.succeed({ reason: "explicit", opCount: enqueued.length, committed: true }),
    recover: Effect.succeed({ replayedOps: 0 })
  };
}

function decisionPackage(overrides: Partial<DecisionPackage> = {}): DecisionPackage {
  return {
    schema: "decision-package/v1",
    decision_id: "dec_TEST",
    title: "Test decision",
    state: "proposed",
    riskTier: "medium",
    urgency: "medium",
    vertical: "software/coding",
    preset: "architecture-decision",
    applies_to: {
      modules: ["kernel"],
      productLines: []
    },
    proposedBy: { kind: "agent", id: "claude" },
    proposedAt: "2026-07-02T00:00:00Z",
    arbiter: { kind: "human", id: "ZeyuLi" },
    provenance: [{
      runtime: "codex",
      sessionId: "session-1",
      boundAt: "2026-07-02T00:00:00Z"
    }],
    question: "Should this test write a decision?",
    chosen: [{ id: "CH1", text: "Write it through the coordinator." }],
    rejected: [{ id: "RJ1", text: "Write it by hand.", why_not: "Machine-readable decision frontmatter needs a coordinator watermark." }],
    claims: [{ id: "C1", text: "Coordinator writes are auditable." }],
    relations: [],
    ...overrides
  };
}

function failureReason(cause: unknown): string {
  return JSON.stringify(cause, (_key, value: unknown) => {
    if (value && typeof value === "object" && "_tag" in value && (value as DecisionWriteRejected)._tag === "DecisionWriteRejected") {
      return (value as DecisionWriteRejected).reason;
    }
    return value;
  });
}
