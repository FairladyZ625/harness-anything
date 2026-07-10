import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { makeDecisionWriteService, readDecisionDocument, type DecisionWriteRejected } from "../src/index.ts";
import { deriveRelationId, type DecisionPackage, type EntityRelationRecord, type WriteCoordinator, type WriteOp } from "../../kernel/src/index.ts";
import { runEffect } from "./effect-test-helpers.ts";

test("decision accept blocks zero-evidence decisions without judgment-only rationale", () => {
  const service = makeDecisionWriteService({
    coordinator: fakeCoordinator([]),
    now: () => "2026-07-02T00:00:00Z"
  });
  const proposed = decisionPackage({ state: "proposed" });

  const result = Effect.runSyncExit(service.accept({
    current: proposed,
    arbiter: { kind: "human", id: "ZeyuLi" },
    opIdPrefix: "accept"
  }));

  assert.equal(result._tag, "Failure");
  assert.match(failureReason(result.cause), /requires at least one evidence relation/u);
});

test("decision write service proposes and accepts through WriteCoordinator with evidence", () => {
  const enqueued: WriteOp[] = [];
  const service = makeDecisionWriteService({
    coordinator: fakeCoordinator(enqueued),
    now: () => "2026-07-02T00:00:00Z"
  });
  const proposed = decisionPackage({
    state: "proposed",
    relations: [relationRecord("decision/dec_TEST/C1", "fact/task_01ABC/F-1234ABCD")]
  });

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

test("decision accept emits an append-only body mutation for judgment-only rationale", () => {
  const enqueued: WriteOp[] = [];
  const service = makeDecisionWriteService({
    coordinator: fakeCoordinator(enqueued),
    now: () => "2026-07-02T00:00:00Z"
  });
  const proposed = decisionPackage({ state: "proposed" });

  const result = Effect.runSync(service.accept({
    current: proposed,
    arbiter: { kind: "human", id: "ZeyuLi" },
    judgmentOnlyRationale: "CEO accepted this as a judgment-only policy choice.",
    opIdPrefix: "accept"
  }));

  assert.deepEqual(result, { decisionId: "dec_TEST", state: "active" });
  const payload = enqueued[0]?.payload as {
    readonly body?: string;
    readonly writeMode?: { readonly appendBody?: string };
  };
  assert.equal(payload.body, undefined);
  assert.match(payload.writeMode?.appendBody ?? "", /## Judgment-only acceptance/u);
  assert.match(payload.writeMode?.appendBody ?? "", /CEO accepted this as a judgment-only policy choice/u);
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

test("decision write service preserves supplied relation records", () => {
  const enqueued: WriteOp[] = [];
  const service = makeDecisionWriteService({ coordinator: fakeCoordinator(enqueued) });
  const relation = relationRecord("decision/dec_TEST/C1", "fact/task_01ABC/F-1234ABCD");
  const proposed = decisionPackage({ relations: [relation] });

  Effect.runSync(service.propose({ decision: proposed }));

  const payload = enqueued[0]?.payload as { readonly decision?: DecisionPackage };
  assert.deepEqual(payload.decision?.relations, [relation]);
});

test("decision write service appends relation records through relation-specific op", () => {
  const enqueued: WriteOp[] = [];
  const service = makeDecisionWriteService({ coordinator: fakeCoordinator(enqueued) });
  const current = decisionPackage({ state: "active" });
  const relation = relationRecord("decision/dec_TEST/CH1", "decision/dec_OLD", "supersedes");

  const result = Effect.runSync(service.relate({ current, relation }));

  assert.deepEqual(result, { decisionId: "dec_TEST", state: "active" });
  assert.equal(enqueued[0]?.kind, "decision_relate");
  const payload = enqueued[0]?.payload as {
    readonly decision?: DecisionPackage;
    readonly writeMode?: { readonly kind?: string; readonly relation?: EntityRelationRecord };
  };
  assert.deepEqual(payload.decision?.relations, [relation]);
  assert.equal(payload.writeMode?.kind, "append_relation");
  assert.deepEqual(payload.writeMode?.relation, relation);
});

test("healing writes are not blocked by pre-existing illegal sibling edges", () => {
  // A host carrying two legacy-illegal edges must not deadlock: replacing either edge
  // used to fail whole-doc validation on the other. Delta enforcement lets the
  // migration proceed while still rejecting writes that introduce NEW violations.
  const enqueued: WriteOp[] = [];
  const service = makeDecisionWriteService({ coordinator: fakeCoordinator(enqueued) });
  const illegalA = relationRecord("decision/dec_TEST/CH1", "task/task_01ABC", "implements");
  const illegalB = relationRecord("decision/dec_TEST/CH1", "task/task_01DEF", "implements");
  const current = decisionPackage({ state: "active", relations: [illegalA, illegalB] });
  const replacement = relationRecord("decision/dec_TEST/CH1", "task/task_01ABC", "derives");

  const result = Effect.runSync(service.replaceRelation({
    current,
    relationId: illegalA.relation_id,
    replacement
  }));
  assert.deepEqual(result, { decisionId: "dec_TEST", state: "active" });
  assert.equal(enqueued[0]?.kind, "relation_replace");

  // Introducing a brand-new illegal edge still fails closed even alongside legacy ones.
  const badNew = relationRecord("decision/dec_TEST/CH1", "task/task_01GHI", "supports");
  const relateResult = Effect.runSyncExit(service.relate({ current, relation: badNew }));
  assert.equal(relateResult._tag, "Failure");
  assert.match(failureReason(relateResult.cause), /type supports is not allowed/u);

  // Creates have no pre-state: full fail-closed enforcement is unchanged.
  const proposeResult = Effect.runSyncExit(service.propose({
    decision: decisionPackage({ relations: [illegalA] })
  }));
  assert.equal(proposeResult._tag, "Failure");
  assert.match(failureReason(proposeResult.cause), /type implements is not allowed/u);
});

test("decision write service rejects relation records not hosted by the decision", () => {
  const service = makeDecisionWriteService({ coordinator: fakeCoordinator([]) });
  const relation = relationRecord("decision/dec_OTHER/C1", "fact/task_01ABC/F-1234ABCD");
  const result = Effect.runSyncExit(service.propose({ decision: decisionPackage({ relations: [relation] }) }));

  assert.equal(result._tag, "Failure");
  assert.match(failureReason(result.cause), /hosted by decision\/dec_TEST/u);
});

test("decision amend fails closed for non-amendable field changes", () => {
  const service = makeDecisionWriteService({ coordinator: fakeCoordinator([]) });
  const current = decisionPackage({ state: "active" });
  const immutableChange = Effect.runSyncExit(service.amend({
    current,
    next: { ...current, riskTier: "high" }
  }));
  const lifecycleChange = Effect.runSyncExit(service.amend({
    current,
    next: { ...current, state: "retired" }
  }));

  assert.equal(immutableChange._tag, "Failure");
  assert.match(failureReason(immutableChange.cause), /immutable field riskTier/u);
  assert.equal(lifecycleChange._tag, "Failure");
  assert.match(failureReason(lifecycleChange.cause), /lifecycle field state/u);
});

test("decision amend accepts schema-declared amendable field changes", () => {
  const enqueued: WriteOp[] = [];
  const service = makeDecisionWriteService({ coordinator: fakeCoordinator(enqueued) });
  const current = decisionPackage({ state: "active" });
  const next = {
    ...current,
    chosen: [...current.chosen, { id: "CH2", text: "Amendable option." }]
  };

  const result = Effect.runSync(service.amend({ current, next }));

  assert.deepEqual(result, { decisionId: "dec_TEST", state: "active" });
  assert.equal(enqueued[0]?.kind, "decision_amend");
  const payload = enqueued[0]?.payload as { readonly decision?: DecisionPackage };
  assert.equal(payload.decision?.chosen.length, 2);
});

test("decision document reader accepts block-list frontmatter and rejects unknown provenance runtime", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-reader-"));
  try {
    writeDecisionMarkdown(rootDir, "dec_BLOCK", "codex");

    const read = await runEffect(readDecisionDocument(rootDir, "dec_BLOCK"));

    assert.equal(read.decision.decision_id, "dec_BLOCK");
    assert.deepEqual(read.decision.provenance, [{
      runtime: "codex",
      sessionId: "session-1",
      boundAt: "2026-07-03T00:00:00.000Z"
    }]);
    assert.deepEqual(read.decision.rejected, [{
      id: "RJ1",
      text: "Keep flow-only parser compatibility.",
      why_not: "Block-list YAML is the contract shape humans copy from design docs."
    }]);

    writeDecisionMarkdown(rootDir, "dec_BLOCK", "other-runtime");
    await assert.rejects(() => runEffect(readDecisionDocument(rootDir, "dec_BLOCK")));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
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

function writeDecisionMarkdown(rootDir: string, decisionId: string, runtime: string): void {
  const decisionRoot = path.join(rootDir, "harness/decisions", `decision-${decisionId}`);
  mkdirSync(decisionRoot, { recursive: true });
  writeFileSync(path.join(decisionRoot, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${decisionId}`,
    "_coordinatorWatermark: wm-block",
    "title: Block frontmatter decision",
    "state: active",
    "riskTier: medium",
    "urgency: medium",
    "vertical: software/coding",
    "preset: architecture-decision",
    "applies_to:",
    "  modules: [\"kernel\"]",
    "  productLines: []",
    "proposedBy: { kind: agent, id: writer }",
    "proposedAt: 2026-07-03T00:00:00.000Z",
    "arbiter: { kind: human, id: writer }",
    "decidedAt: 2026-07-03T00:01:00.000Z",
    "provenance:",
    `  - runtime: ${runtime}`,
    "    sessionId: session-1",
    "    boundAt: 2026-07-03T00:00:00.000Z",
    "question: Should the reader accept contract-shaped blocks?",
    "chosen:",
    "  - id: CH1",
    "    text: Parse block-list YAML.",
    "rejected:",
    "  - id: RJ1",
    "    text: Keep flow-only parser compatibility.",
    "    why_not: Block-list YAML is the contract shape humans copy from design docs.",
    "claims:",
    "  - id: C1",
    "    text: Reader compatibility belongs at the read boundary.",
    "relations:",
    "---",
    "",
    "# Block frontmatter decision",
    ""
  ].join("\n"), "utf8");
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

function relationRecord(source: string, target: string, type: EntityRelationRecord["type"] = "supersedes-fact"): EntityRelationRecord {
  const base = {
    source,
    target,
    type,
    strength: "strong",
    direction: "directed",
    origin: "declared",
    rationale: "The linked fact supports the decision claim.",
    state: "active"
  } satisfies Omit<EntityRelationRecord, "relation_id">;
  return {
    relation_id: deriveRelationId(base),
    ...base
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
