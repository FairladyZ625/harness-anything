// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { makeDecisionWriteService as makeRawDecisionWriteService, readDecisionDocument, type DecisionWriteRejected, type DecisionWriteServiceOptions } from "../src/index.ts";
import { computeDecisionContentDigest, deriveRelationId, type AttributionEvent, type DecisionPackage, type EntityRelationRecord, type WriteCoordinator, type WriteOp } from "../../kernel/src/index.ts";
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
  assert.deepEqual((enqueued[1]?.payload as { decision?: DecisionPackage }).decision?.contentPins, [{
    action: "accept",
    state: "active",
    decidedAt: "2026-07-02T00:00:00Z",
    arbiter: { kind: "human", id: "ZeyuLi" },
    canonicalization: "decision-content/v1",
    digest: computeDecisionContentDigest(proposed)
  }]);
});

test("every decision judgment transition appends a self-contained content pin", () => {
  const enqueued: WriteOp[] = [];
  const service = makeDecisionWriteService({
    coordinator: fakeCoordinator(enqueued),
    now: () => "2026-07-11T00:01:00.000Z"
  });
  const proposed = decisionPackage({ state: "proposed" });
  const active = decisionPackage({ state: "active" });
  const arbiter = { kind: "human", id: "ZeyuLi" } as const;

  Effect.runSync(service.accept({ current: proposed, arbiter, judgmentOnlyRationale: "Human judgment." }));
  Effect.runSync(service.reject({ current: proposed, arbiter }));
  Effect.runSync(service.defer({ current: proposed, arbiter }));
  Effect.runSync(service.supersede({ current: active, arbiter }));
  Effect.runSync(service.retire({ current: active, arbiter }));

  const pins = enqueued.map((op) => (op.payload as { decision: DecisionPackage }).decision.contentPins?.at(-1));
  assert.deepEqual(pins.map((pin) => [pin?.action, pin?.state]), [
    ["accept", "active"],
    ["reject", "rejected"],
    ["defer", "deferred"],
    ["supersede", "retired"],
    ["retire", "retired"]
  ]);
  for (const pin of pins) {
    assert.equal(pin?.decidedAt, "2026-07-11T00:01:00.000Z");
    assert.deepEqual(pin?.arbiter, arbiter);
    assert.equal(pin?.canonicalization, "decision-content/v1");
  }
});

test("post-sign load-bearing amend preserves history and appends a current content pin", () => {
  const enqueued: WriteOp[] = [];
  const service = makeDecisionWriteService({
    coordinator: fakeCoordinator(enqueued),
    now: () => "2026-07-11T00:01:00.000Z"
  });
  const proposed = decisionPackage({ state: "proposed" });

  Effect.runSync(service.accept({
    current: proposed,
    arbiter: { kind: "human", id: "ZeyuLi" },
    judgmentOnlyRationale: "Human judgment."
  }));
  const signed = (enqueued[0]?.payload as { decision: DecisionPackage }).decision;
  const recordedPin = signed.contentPins?.[0];
  assert.ok(recordedPin);
  const amended = {
    ...signed,
    chosen: [...signed.chosen, { id: "CH2", text: "A post-sign amendment." }],
    claims: [...signed.claims, { id: "C2", text: "This claim was added after signing." }]
  };

  assert.notEqual(computeDecisionContentDigest(amended), recordedPin.digest);
  Effect.runSync(service.amend({ current: signed, next: amended }));
  const persistedAmend = (enqueued[1]?.payload as { decision: DecisionPackage }).decision;

  assert.equal(persistedAmend.contentPins?.length, 2);
  assert.deepEqual(persistedAmend.contentPins?.[0], recordedPin);
  assert.deepEqual(persistedAmend.contentPins?.[1], {
    action: "amend",
    state: "active",
    decidedAt: "2026-07-11T00:01:00.000Z",
    arbiter: { kind: "human", id: "ZeyuLi" },
    canonicalization: "decision-content/v1",
    digest: computeDecisionContentDigest(amended)
  });
});

test("post-sign title-only amend does not append a content pin", () => {
  const enqueued: WriteOp[] = [];
  const service = makeDecisionWriteService({ coordinator: fakeCoordinator(enqueued) });
  const current = decisionPackage({
    state: "active",
    decidedAt: "2026-07-11T00:00:00.000Z",
    contentPins: [{
      action: "accept",
      state: "active",
      decidedAt: "2026-07-11T00:00:00.000Z",
      arbiter: { kind: "human", id: "ZeyuLi" },
      canonicalization: "decision-content/v1",
      digest: computeDecisionContentDigest(decisionPackage())
    }]
  });

  Effect.runSync(service.amend({
    current,
    next: { ...current, title: "A clearer navigation label." }
  }));
  const persistedAmend = (enqueued[0]?.payload as { decision: DecisionPackage }).decision;

  assert.deepEqual(persistedAmend.contentPins, current.contentPins);
});

test("migration re-pin appends a current digest without changing decision content", () => {
  const enqueued: WriteOp[] = [];
  const service = makeDecisionWriteService({
    coordinator: fakeCoordinator(enqueued),
    now: () => "2026-07-14T02:30:00.000Z"
  });
  const originallyPinned = decisionPackage({ state: "active" });
  const stale = decisionPackage({
    state: "active",
    chosen: [...originallyPinned.chosen, { id: "CH2", text: "Historical post-pin amendment." }],
    contentPins: [{
      action: "accept",
      state: "active",
      decidedAt: "2026-07-11T00:00:00.000Z",
      arbiter: { kind: "human", id: "ZeyuLi" },
      canonicalization: "decision-content/v1",
      digest: computeDecisionContentDigest(originallyPinned)
    }]
  });

  Effect.runSync(service.repinForMigration({ current: stale, opIdPrefix: "amend-after-pin" }));
  const persisted = (enqueued[0]?.payload as { decision: DecisionPackage }).decision;

  assert.deepEqual({ ...persisted, contentPins: stale.contentPins }, stale);
  assert.equal(persisted.contentPins?.length, 2);
  assert.deepEqual(persisted.contentPins?.at(-1), {
    action: "amend",
    state: "active",
    decidedAt: "2026-07-14T02:30:00.000Z",
    arbiter: { kind: "human", id: "ZeyuLi" },
    canonicalization: "decision-content/v1",
    digest: computeDecisionContentDigest(stale)
  });
});

test("content re-pin rejects non-migration attribution", () => {
  const service = makeRawDecisionWriteService({
    coordinator: fakeCoordinator([]),
    attribution: {
      ...judgmentAttribution,
      principalSource: { kind: "local-configured", authority: "harness.yaml", authoritySha256: "sha256:test" }
    }
  });
  const current = decisionPackage({
    state: "active",
    contentPins: [{
      action: "accept",
      state: "active",
      decidedAt: "2026-07-11T00:00:00.000Z",
      arbiter: { kind: "human", id: "ZeyuLi" },
      canonicalization: "decision-content/v1",
      digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }]
  });

  const result = Effect.runSyncExit(service.repinForMigration({ current }));

  assert.equal(result._tag, "Failure");
  assert.match(failureReason(result.cause), /requires migration principalSource/u);
});

test("retire preserves the accept pin and appends a distinct retirement pin", () => {
  const enqueued: WriteOp[] = [];
  const service = makeDecisionWriteService({ coordinator: fakeCoordinator(enqueued) });
  const accepted = decisionPackage({
    state: "active",
    decidedAt: "2026-07-11T00:01:00.000Z",
    contentPins: [{
      action: "accept",
      state: "active",
      decidedAt: "2026-07-11T00:01:00.000Z",
      arbiter: { kind: "human", id: "ZeyuLi" },
      canonicalization: "decision-content/v1",
      digest: computeDecisionContentDigest(decisionPackage())
    }]
  });

  Effect.runSync(service.retire({
    current: accepted,
    arbiter: { kind: "human", id: "ZeyuLi" },
    decidedAt: "2026-07-11T00:02:00.000Z"
  }));
  const retired = (enqueued[0]?.payload as { decision: DecisionPackage }).decision;

  assert.equal(retired.contentPins?.length, 2);
  assert.deepEqual(retired.contentPins?.[0], accepted.contentPins?.[0]);
  assert.equal(retired.contentPins?.[1]?.action, "retire");
  assert.equal(retired.contentPins?.[1]?.state, "retired");
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

test("an agent may not judge the decision it proposed, and terminal transitions stay rejected", () => {
  const service = makeRawDecisionWriteService({
    coordinator: fakeCoordinator([]),
    attribution: proposerAttribution, // executor = agent:claude — the same agent that proposed
    readAttributionEvents: () => [proposeAttributionEvent]
  });
  const proposed = decisionPackage({ state: "proposed" });
  const rejected = decisionPackage({ state: "rejected" });

  const selfArbiter = Effect.runSyncExit(service.accept({ current: proposed, judgmentOnlyRationale: "Agent self judgment must still be rejected." }));
  const terminalTransition = Effect.runSyncExit(service.accept({
    current: rejected
  }));

  assert.equal(selfArbiter._tag, "Failure");
  assert.match(failureReason(selfArbiter.cause), /an agent may not judge the decision it proposed/u);
  assert.equal(terminalTransition._tag, "Failure");
  assert.match(failureReason(terminalTransition.cause), /terminal_state/u);
});

// dec_01KXCHW9MFV8E3QGZJJW91YNDS:分离不变量防的是 agent 自我签字,不是人自我签字。
test("a human judging directly may accept the decision they proposed themselves", () => {
  const humanProposeEvent = {
    ...proposeAttributionEvent,
    ...humanDirectAttribution // propose 也是这个人直接做的,没有 executor
  } as AttributionEvent;
  const enqueued: WriteOp[] = [];
  const service = makeRawDecisionWriteService({
    coordinator: fakeCoordinator(enqueued),
    attribution: humanDirectAttribution, // 判定者:同一个人,直接操作,无 executor
    readAttributionEvents: () => [humanProposeEvent]
  });

  const result = Effect.runSync(service.accept({
    current: decisionPackage({ state: "proposed" }),
    judgmentOnlyRationale: "A solo operator is both the only proposer and the only authority.",
    opIdPrefix: "accept"
  }));

  assert.deepEqual(result, { decisionId: "dec_TEST", state: "active" });
  assert.equal(enqueued.length, 1);
});

test("a human judging directly may also accept a decision an agent proposed", () => {
  const enqueued: WriteOp[] = [];
  const service = makeRawDecisionWriteService({
    coordinator: fakeCoordinator(enqueued),
    attribution: humanDirectAttribution, // 人直接判定
    readAttributionEvents: () => [proposeAttributionEvent] // agent:claude 提的
  });

  const result = Effect.runSync(service.accept({
    current: decisionPackage({ state: "proposed" }),
    judgmentOnlyRationale: "Human signoff on an agent-proposed decision.",
    opIdPrefix: "accept"
  }));

  assert.deepEqual(result, { decisionId: "dec_TEST", state: "active" });
  assert.equal(enqueued.length, 1);
});

test("decision judgment fails closed when the immutable propose attribution event is missing", () => {
  const service = makeRawDecisionWriteService({
    coordinator: fakeCoordinator([]),
    attribution: judgmentAttribution,
    readAttributionEvents: () => []
  });

  const result = Effect.runSyncExit(service.accept({
    current: decisionPackage({ state: "proposed" }),
    judgmentOnlyRationale: "The missing origin event must block this write."
  }));

  assert.equal(result._tag, "Failure");
  assert.match(failureReason(result.cause), /requires an immutable decision_propose attribution event/u);
});

test("decision write service rejects empty rejected alternatives", () => {
  const service = makeDecisionWriteService({ coordinator: fakeCoordinator([]) });
  const invalid = { ...decisionPackage({ state: "proposed" }), rejected: [] } as unknown as DecisionPackage;
  const result = Effect.runSyncExit(service.propose({ decision: invalid }));

  assert.equal(result._tag, "Failure");
  assert.match(failureReason(result.cause), /rejected alternatives/u);
});

test("decision propose rejects caller-supplied lifecycle content pins", () => {
  const service = makeDecisionWriteService({ coordinator: fakeCoordinator([]) });
  const result = Effect.runSyncExit(service.propose({
    decision: decisionPackage({ contentPins: [] })
  }));

  assert.equal(result._tag, "Failure");
  assert.match(failureReason(result.cause), /cannot supply lifecycle-owned contentPins/u);
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
  const pinChange = Effect.runSyncExit(service.amend({
    current,
    next: { ...current, contentPins: [] }
  }));

  assert.equal(immutableChange._tag, "Failure");
  assert.match(failureReason(immutableChange.cause), /immutable field riskTier/u);
  assert.equal(lifecycleChange._tag, "Failure");
  assert.match(failureReason(lifecycleChange.cause), /lifecycle field state/u);
  assert.equal(pinChange._tag, "Failure");
  assert.match(failureReason(pinChange.cause), /lifecycle field contentPins/u);
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
  assert.equal(payload.decision?.contentPins, undefined);
});

test("decision document reader accepts block-list frontmatter and rejects unknown provenance runtime", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-reader-"));
  try {
    writeDecisionMarkdown(rootDir, "dec_BLOCK", "codex");

    const read = await runEffect(readDecisionDocument(rootDir, "dec_BLOCK"));

    assert.equal(read.decision.decision_id, "dec_BLOCK");
    assert.equal(read.decision.contentPins, undefined);
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

test("decision document reader preserves decisionClass so standing-policy transitions survive the daemon field-change validator", async () => {
  // Regression: the reader previously used a hand-copied frontmatter parser that
  // lacked decisionClass. The CLI-built `next` document then dropped the field,
  // and the daemon (parsing the same file with the kernel parser) rejected every
  // non-accept transition of a standing-policy decision as
  // DECISION_STATE_FIELD_INVALID:decisionClass — making standing policies
  // impossible to supersede or retire.
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-reader-class-"));
  try {
    writeDecisionMarkdown(rootDir, "dec_CLASS", "codex", "standing-policy");

    const read = await runEffect(readDecisionDocument(rootDir, "dec_CLASS"));

    assert.equal(read.decision.decisionClass, "standing-policy");
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

function writeDecisionMarkdown(rootDir: string, decisionId: string, runtime: string, decisionClass?: string): void {
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
    ...(decisionClass ? [`decisionClass: ${decisionClass}`] : []),
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
    proposedAt: "2026-07-02T00:00:00Z",
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

const proposerAttribution = {
  actor: {
    principal: { kind: "person", personId: "ZeyuLi" },
    executor: { kind: "agent", id: "claude" }
  },
  principalSource: { kind: "migration", evidenceRef: "test/proposer" },
  executorSource: "client-asserted"
} as const;

const judgmentAttribution = {
  actor: {
    principal: { kind: "person", personId: "ZeyuLi" },
    executor: null
  },
  principalSource: { kind: "migration", evidenceRef: "test/judgment" },
  executorSource: "none"
} as const;

// 人在直接操作:principal 是人,executor 为空(没有 agent 在代跑)。判定动作长这样时
// 分离校验整条豁免(dec_01KXCHW9MFV8E3QGZJJW91YNDS)。
const humanDirectAttribution = judgmentAttribution;

const proposeAttributionEvent = {
  schema: "attribution-event/v1",
  eventId: "evt_propose",
  opId: "op_propose",
  journalRecordSchema: "write-journal/v2",
  entityId: "decision/dec_TEST",
  kind: "decision_propose",
  ...proposerAttribution,
  at: "2026-07-02T00:00:00Z",
  recordedAt: "2026-07-02T00:00:00Z",
  payloadHash: "hash",
  payloadRef: { kind: "inline", value: "payload" }
} as AttributionEvent;

function makeDecisionWriteService(options: DecisionWriteServiceOptions) {
  return makeRawDecisionWriteService({
    attribution: judgmentAttribution,
    readAttributionEvents: () => [proposeAttributionEvent],
    ...options
  });
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
