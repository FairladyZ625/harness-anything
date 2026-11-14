// harness-test-tier: contract
import type { FactEventDraftV1, FactEventV1 } from "../../src/domain/fact-event.ts";
import type { DecisionEventDraftV1 } from "../../src/domain/decision-event-types.ts";
import type { DecisionEventV1 } from "../../src/domain/decision-event.ts";
import { embeddedRelationEventsForReplay } from "../../src/domain/relation-event.ts";
import { FactEventSchema } from "../../src/schemas/fact-event.ts";
import assert from "node:assert/strict";
import { Schema } from "effect";
import test from "node:test";
import {
  compileDecisionWrite,
  compileFactWrite,
  decisionWritePlan,
  deriveRelationId,
  parseCanonicalEvent,
  serializeCanonicalEvent,
  serializePersistedCanonicalEvent,
} from "../../src/index.ts";
import {
  assertDecisionJudgmentConsent,
  assertDecisionWritePlan,
  decisionMachineDigest,
  type DecisionDocumentState,
} from "../../src/domain/decision-event.ts";
import { DecisionEventSchema } from "../../src/schemas/decision-event.ts";
import { validateCurrentDecisionEvent, validateDecisionEvent } from "../../src/domain/decision-event.ts";
import { validateCurrentFactEvent, validateFactEvent } from "../../src/domain/fact-event.ts";
import { assertFactAdmissionAtCut } from "../../src/domain/fact-admission.ts";
import { assertDecisionAdmissionAtCut } from "../../src/domain/decision-admission.ts";
import {
  activeMaterializationHolds,
  materializationState,
  type MaterializationEntityState,
  type MaterializationRelation,
} from "../../src/domain/entity-relation.ts";

const draft: FactEventDraftV1 = {
    schema: "fact-event/v1",
    eventId: "event-fact-contract",
    workspaceRevision: 1,
    opId: "op-fact-contract",
    taskId: "task-contract",
    factId: "F-ABCDEFGH",
    type: "fact_recorded",
    actor: { principal: { personId: "person-contract" }, executor: null },
    source: "local",
    occurredAt: "2026-08-13T00:00:00.000Z",
    payload: {
      statement: "Closed Fact payload",
      evidenceSource: "contract fixture",
      observedAt: "2026-08-13T00:00:00.000Z",
      confidence: "high",
      domainTypes: ["架构", "bug"],
      memoryClass: "semantic",
      memoryTags: ["pattern"],
      provenance: [
        {
          runtime: "unavailable",
          sessionId: null,
          transcriptReachability: "unavailable",
          boundAt: "2026-08-13T00:00:00.000Z",
        },
      ],
    },
  },
  event = compileFactWrite({
    event: draft,
    packagePath: "tasks/task-contract-contract",
    currentFacts: [],
  }).event;

test("an observed Fact names the commit it was observed against in its managed document", () => {
  const commit = "a".repeat(40),
    anchored = compileFactWrite({
      event: {
        ...draft,
        payload: {
          ...draft.payload,
          observedCommit: commit,
        },
      },
    });
  assert.match(anchored.body, new RegExp(`- Observed commit: ${commit}`));
  assert.deepEqual(validateFactEvent(anchored.event), []);
  // Facts recorded before dec_BB2BCE9F CH4 carry no anchor and render unchanged.
  assert.doesNotMatch(compileFactWrite({ event: draft }).body, /Observed commit/u);
});

test("Fact event reader ignores unknown fields while the current writer stays strict", () => {
  assert.deepEqual(validateFactEvent(event), []);
  assert.deepEqual(Schema.decodeUnknownSync(FactEventSchema)(event), event);
  assert.deepEqual(parseCanonicalEvent(serializeCanonicalEvent(event)), event);
  const additive = [
    { ...event, unexpected: true },
    { ...event, payload: { ...event.payload, unexpected: true } },
    {
      ...event,
      payload: {
        ...event.payload,
        provenance: [{ ...event.payload.provenance[0]!, token: "future field" }],
      },
    },
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
    { ...event, payload: { ...event.payload, observedCommit: "abc" } },
    { ...event, payload: { ...event.payload, observedCommit: 42 } },
    { ...event, payload: { ...event.payload, domainTypes: [" bug "] } },
    { ...event, payload: { ...event.payload, domainTypes: ["x".repeat(65)] } },
    {
      ...event,
      payload: { ...event.payload, memoryTags: ["pattern", "pattern"] },
    },
    {
      ...event,
      payload: {
        ...event.payload,
        provenance: [
          event.payload.provenance[0]!,
          {
            ...event.payload.provenance[0]!,
            boundAt: "2026-08-13T00:00:01.000Z",
          },
        ],
      },
    },
    {
      ...event,
      payload: {
        ...event.payload,
        supersedes: { factRef: "fact/task_some_other_task/F-12345678", rationale: "pre-rekey task-scoped ref" },
      },
    },
    {
      ...event,
      payload: {
        ...event.payload,
        supersedes: {
          factRef: "fact/F-12345678",
          rationale: "x".repeat(200),
        },
      },
    },
  ]) {
    assert.notDeepEqual(validateFactEvent(invalid), [], JSON.stringify(invalid));
    assert.throws(() => Schema.decodeUnknownSync(FactEventSchema)(invalid), JSON.stringify(invalid));
  }
  assert.notDeepEqual(
    validateFactEvent({ ...event, payload: { ...event.payload, memoryTags: ["productization"] } }),
    [],
  );
  assert.throws(() => parseCanonicalEvent(`${JSON.stringify({ ...event, schema: "unknown-event/v1" })}\n`), /unknown/u);
});

test("Fact compiler renders one exact machine-owned document per fact", () => {
  const first = compileFactWrite({
    event: draft,
    packagePath: "tasks/task-contract-contract",
    currentFacts: [],
  });
  assert.equal(
    first.body,
    "# Facts\n\nManaged by `ha fact record`; hand edits are rejected.\n\n## Records\n\n### F-ABCDEFGH\n\n- Statement: Closed Fact payload\n- Evidence source: contract fixture\n- Observed at: 2026-08-13T00:00:00.000Z\n- Confidence: high\n- State: standing\n- Task: task-contract\n\n",
  );
  const secondDraft: FactEventDraftV1 = {
      ...draft,
      eventId: "event-fact-correction",
      opId: "op-fact-correction",
      workspaceRevision: 2,
      factId: "F-BCDEFGHJ",
      payload: {
        ...draft.payload,
        statement: "Corrected payload",
        supersedes: {
          factRef: "fact/F-ABCDEFGH",
          rationale: "New evidence",
        },
      },
    },
    second = compileFactWrite({
      event: secondDraft,
      supersededFact: {
        factId: draft.factId,
        baseDocumentSha256: compileFactWrite({ event: draft }).event.payload.factsDocumentClaim!.sha256,
        taskId: draft.taskId,
        statement: draft.payload.statement,
        evidenceSource: draft.payload.evidenceSource,
        observedAt: draft.payload.observedAt,
        confidence: draft.payload.confidence,
      },
    });
  assert.doesNotMatch(second.body, /### F-ABCDEFGH/u);
  assert.match(second.body, /### F-BCDEFGHJ[\s\S]*State: standing/u);
  assert.doesNotMatch(second.body, /record-time/u);
  assert.equal(second.blobs.length, 2);
  assert.match(second.blobs[1]!.body, /State: superseded_fact/u);
  assert.match(second.blobs[1]!.body, /Superseded by: fact\/F-BCDEFGHJ \(New evidence\)/u);
  assert.equal(second.event.payload.supersededFactsDocumentClaim?.path, "facts/F-ABCDEFGH.md");
  assert.deepEqual(second.event.payload.supersededFactsDocumentRetirement, {
    path: "facts/F-ABCDEFGH.md",
    sha256: compileFactWrite({ event: draft }).event.payload.factsDocumentClaim!.sha256,
  });
  assert.deepEqual(
    second.plan.targets.find((target) => target.path === "facts/F-ABCDEFGH.md"),
    {
      kind: "authored_file_delete",
      path: "facts/F-ABCDEFGH.md",
      operation: "delete",
      baseSha256: second.event.payload.supersededFactsDocumentRetirement?.sha256,
    },
  );
  assert.ok(
    second.plan.targets.some(
      (target) =>
        target.kind === "content_blob" && target.sha256 === second.event.payload.supersededFactsDocumentClaim?.sha256,
    ),
    "superseded Fact bytes remain addressable after the authored file is retired",
  );
  assert.match(second.body, /### F-BCDEFGHJ[\s\S]*- Task: task-contract\n\n/u);
});

test("Fact documents without an owning task omit the Task line", () => {
  const { taskId: _taskId, ...unowned } = draft,
    compiled = compileFactWrite({
      event: unowned,
      packagePath: "tasks/task-contract-contract",
      currentFacts: [],
    });
  assert.equal(_taskId, "task-contract");
  assert.equal(unowned.taskId, undefined);
  assert.doesNotMatch(compiled.body, /- Task:/u);
  assert.equal(validateFactEvent(compiled.event).length, 0);
});

const initialRelationIdentity = {
    source: "decision/dec_CONTRACT/C1",
    target: "decision/dec_CONTRACT/CH1",
    type: "supports" as const,
    direction: "directed" as const,
  },
  initialRelation = {
    relation_id: deriveRelationId(initialRelationIdentity),
    ...initialRelationIdentity,
    strength: "strong" as const,
    origin: "declared" as const,
    rationale: "The claim supports the chosen option.",
    state: "active" as const,
  };
const decisionDraft: DecisionEventDraftV1 = {
    schema: "decision-event/v1",
    eventId: "event-decision-contract",
    workspaceRevision: 1,
    opId: "op-decision-contract",
    decisionId: "dec_CONTRACT",
    type: "decision_proposed",
    actor: { principal: { personId: "person-proposer" }, executor: null },
    source: "local",
    occurredAt: "2026-08-14T00:00:00.000Z",
    payload: {
      title: "Canonical Decision",
      question: "Should the authored document be canonical?",
      riskTier: "medium",
      urgency: "high",
      vertical: "software/coding",
      preset: "standard-task",
      appliesTo: { modules: ["kernel"], productLines: [] },
      decisionClass: "ordinary",
      chosen: [{ id: "CH1", text: "Use the bundle" }],
      rejected: [{ id: "RJ1", text: "Use split files", whyNot: "They drift." }],
      body: "# Canonical Decision\n\n初始正文。\n",
      claims: [{ id: "C1", text: "One bundle is atomic.", loadBearing: true }],
      fulfillments: [{ claimId: "C1", mode: "evidenced" }],
      relations: [initialRelation],
    },
  },
  decision = compileDecisionWrite({
    decisionReviewRequirement: "off",
    event: decisionDraft,
    currentDecision: null,
    currentRelations: [],
    currentDocument: null,
  });

test("Decision event reader ignores additions while the current writer requires its exact authored mutation claim", () => {
  assert.deepEqual(validateDecisionEvent(decision.event), []);
  assert.deepEqual(Schema.decodeUnknownSync(DecisionEventSchema)(decision.event), decision.event);
  assert.deepEqual(parseCanonicalEvent(serializePersistedCanonicalEvent(decision.event)), decision.event);
  for (const future of [
    { ...decision.event, unexpected: true },
    {
      ...decision.event,
      payload: { ...decision.event.payload, unexpected: true },
    },
  ]) {
    assert.deepEqual(validateDecisionEvent(future), [], JSON.stringify(future));
    assert.notDeepEqual(validateCurrentDecisionEvent(future), [], JSON.stringify(future));
  }
  for (const invalid of [
    decisionDraft,
    {
      ...decision.event,
      payload: {
        ...decision.event.payload,
        baseDocumentSha256: "0".repeat(64),
      },
    },
    {
      ...decision.event,
      payload: {
        ...decision.event.payload,
        decisionDocumentClaim: {
          ...decision.event.payload.decisionDocumentClaim,
          path: "decisions/decision-dec_OTHER/decision.md",
        },
      },
    },
    {
      ...decision.event,
      payload: {
        ...decision.event.payload,
        decisionDocumentClaim: {
          ...decision.event.payload.decisionDocumentClaim,
          sha256: "bad",
        },
      },
    },
  ]) {
    assert.notDeepEqual(validateDecisionEvent(invalid), [], JSON.stringify(invalid));
    assert.throws(() => Schema.decodeUnknownSync(DecisionEventSchema)(invalid), JSON.stringify(invalid));
  }
});

test("Decision compiler renders the exact single-file package and frozen write plan", () => {
  assert.equal(decision.path, "decisions/decision-dec_CONTRACT/decision.md");
  assertDecisionWritePlan(decision.event, decision.plan);
  assert.deepEqual(
    decision.plan.targets.map(({ kind }) => kind),
    [
      "event_file",
      "event_head",
      "authored_file",
      "content_blob",
      "projection_invalidation",
      "projection_invalidation",
      "projection_invalidation",
    ],
  );
  assert.deepEqual(decision.blobs[0], {
    sha256: decision.event.payload.decisionDocumentClaim.sha256,
    size: decision.event.payload.decisionDocumentClaim.size,
    mediaType: "text/markdown",
    body: decision.body,
  });
  assert.equal(
    decision.body.includes(
      'claims: [{"fulfillment":"evidenced","id":"C1","loadBearing":true,"text":"One bundle is atomic."}]',
    ),
    true,
  );
  assert.match(decision.body, /^relations: \[/mu);
  assert.equal(decision.body.includes(initialRelation.relation_id), true);
  assert.match(decision.body, /## 关联图谱 \(Causal Graph\)[\s\S]*<!-- harness:relation-neighborhood:end -->\n$/u);
  assert.equal(decision.body.includes("# Canonical Decision\n\n初始正文。"), true);
  assert.throws(
    () =>
      compileDecisionWrite({
        decisionReviewRequirement: "off",
        event: {
          ...decisionDraft,
          type: "decision_accepted",
          payload: { rationale: "No base" },
        },
        currentDecision: null,
        currentRelations: [],
        currentDocument: null,
      }),
    /base must agree/u,
  );
});

test("terminal Decision write plans retire authored Markdown while retaining its content object", () => {
  const terminalEvent = {
      ...decision.event,
      type: "decision_retired",
    } as DecisionEventV1,
    plan = decisionWritePlan(terminalEvent);
  assert.ok(plan.targets.some((target) => target.kind === "authored_file_delete" && target.path === decision.path));
  assert.ok(!plan.targets.some((target) => target.kind === "authored_file" && target.path === decision.path));
  assert.ok(
    plan.targets.some(
      (target) =>
        target.kind === "content_blob" && target.sha256 === decision.event.payload.decisionDocumentClaim.sha256,
    ),
  );
});

test("terminal Fact holds follow only canonical Decision and in-flight Task directions", () => {
  const fact: MaterializationEntityState = { ref: "fact/F-ABCDEFGH", kind: "fact", state: "superseded_fact" },
    decision: MaterializationEntityState = { ref: "decision/dec_HOLDER", kind: "decision", state: "in_effect" },
    task: MaterializationEntityState = { ref: "task/task-holder", kind: "task", state: "active" },
    states = new Map([
      [fact.ref, fact],
      [decision.ref, decision],
      [task.ref, task],
    ]),
    edge = (source: string, target: string, type: string): MaterializationRelation => ({
      source,
      target,
      type: type as never,
      state: "active",
    });
  for (const hold of [
    edge(decision.ref, fact.ref, "evidenced-by"),
    edge(decision.ref, fact.ref, "refuted-by"),
    edge(task.ref, fact.ref, "evidences"),
    edge(task.ref, fact.ref, "produces"),
  ]) {
    assert.equal(activeMaterializationHolds(fact, [hold], states).length, 1);
    assert.equal(materializationState(fact, [hold], states), "materialized");
  }
  assert.equal(activeMaterializationHolds(fact, [edge(decision.ref, fact.ref, "evidences")], states).length, 0);
  assert.equal(activeMaterializationHolds(fact, [edge(decision.ref, fact.ref, "relates")], states).length, 0);
  assert.equal(
    activeMaterializationHolds(
      fact,
      [edge(decision.ref, fact.ref, "evidenced-by")],
      new Map([
        [fact.ref, fact],
        [decision.ref, { ...decision, state: "outcome_retired" }],
      ]),
    ).length,
    0,
  );
  assert.equal(
    activeMaterializationHolds(
      fact,
      [edge(task.ref, fact.ref, "produces")],
      new Map([
        [fact.ref, fact],
        [task.ref, { ...task, state: "done" }],
      ]),
    ).length,
    0,
  );
  assert.equal(materializationState(fact, [], states), "dematerialized_terminal");
});

test("terminal Decision holds normalize clause anchors and preserve only declared strong dependencies", () => {
  const decision: MaterializationEntityState = { ref: "decision/dec_TARGET", kind: "decision", state: "superseded" },
    holder: MaterializationEntityState = { ref: "decision/dec_HOLDER", kind: "decision", state: "proposed" },
    task: MaterializationEntityState = { ref: "task/task-holder", kind: "task", state: "in_review" },
    states = new Map([
      [decision.ref, decision],
      [holder.ref, holder],
      [task.ref, task],
    ]),
    edge = (source: string, target: string, type: string): MaterializationRelation => ({
      source,
      target,
      type: type as never,
      state: "active",
    });
  for (const hold of [
    edge("decision/dec_TARGET/CH1", task.ref, "derives"),
    edge("decision/dec_TARGET/C1", holder.ref, "derives"),
    edge(task.ref, "decision/dec_TARGET/CH1", "implements"),
    edge(holder.ref, "decision/dec_TARGET/C1", "refines"),
    edge(holder.ref, "decision/dec_TARGET/CH1", "narrows"),
    edge(holder.ref, "decision/dec_TARGET/C1", "supports"),
  ])
    assert.equal(activeMaterializationHolds(decision, [hold], states).length, 1, hold.type);
  assert.equal(activeMaterializationHolds(decision, [edge(holder.ref, decision.ref, "relates")], states).length, 0);
  assert.equal(
    activeMaterializationHolds(
      decision,
      [edge("decision/dec_TARGET/CH1", task.ref, "derives")],
      new Map([
        [decision.ref, decision],
        [task.ref, { ...task, state: "done" }],
      ]),
    ).length,
    0,
  );
});

test("cancelled Tasks remain materialized while an active Task depends on them", () => {
  const target: MaterializationEntityState = { ref: "task/task_target", kind: "task", state: "cancelled" },
    holder: MaterializationEntityState = { ref: "task/task_holder", kind: "task", state: "active" },
    states = new Map([
      [target.ref, target],
      [holder.ref, holder],
    ]),
    hold: MaterializationRelation = {
      source: holder.ref,
      target: target.ref,
      type: "depends-on",
      state: "active",
    };
  assert.equal(materializationState(target, [hold], states), "materialized");
  assert.equal(
    materializationState(
      target,
      [hold],
      new Map([
        [target.ref, target],
        [holder.ref, { ...holder, state: "done" }],
      ]),
    ),
    "dematerialized_terminal",
  );
  assert.equal(materializationState({ ...target, state: "done" }, [], states), "materialized");
});

test("active canonical holds defer terminal document retirement without blocking admissions", () => {
  const fact = compileFactWrite({ event: draft }).event,
    archive = {
      ...fact,
      type: "fact_archived",
      payload: {
        ...fact.payload,
        archiveReason: "retirement fixture",
        factsDocumentRetirement: {
          path: `facts/${fact.factId}.md`,
          sha256: fact.payload.factsDocumentClaim!.sha256,
        },
      },
    } as FactEventV1,
    factState = {
      row: { ...fact.payload, taskId: fact.taskId, archived: false },
      domainTypes: [],
      supersededTarget: null,
      relations: [],
    };
  assert.doesNotThrow(() => assertFactAdmissionAtCut(factState, archive));

  const terminalDecision = { ...decision.event, type: "decision_retired" } as DecisionEventV1;
  assert.doesNotThrow(() =>
    assertDecisionAdmissionAtCut(
      {
        document: { state: "in_effect" } as DecisionDocumentState,
        hasSupersedes: false,
        relations: [],
      },
      terminalDecision,
    ),
  );
});

test("Decision review current writer preserves the declared finding metadata and rejects malformed values", () => {
  const finding = {
      findingId: "F1",
      text: "The declared metadata must survive registration.",
      anchor: "claim/C1",
      category: "correctness" as const,
      label: "Important" as const,
      evidenceDigest: `sha256:${"a".repeat(64)}` as const,
      priorFindingRefs: ["review/prior/F1"],
    },
    review = {
      ...decision.event,
      type: "decision_review_recorded" as const,
      payload: {
        baseDocumentSha256: decision.event.payload.decisionDocumentClaim.sha256,
        decisionDocumentClaim: decision.event.payload.decisionDocumentClaim,
        reviewId: "review-metadata",
        reviewContentDigest: `sha256:${"b".repeat(64)}` as const,
        verdict: "changes_requested" as const,
        reason: "One finding requires a correction.",
        findings: [finding],
        evidenceChecked: ["claim/C1"],
        reportRef: null,
      },
    };
  assert.deepEqual(validateCurrentDecisionEvent(review), []);
  assert.deepEqual(parseCanonicalEvent(serializeCanonicalEvent(review)), review);
  assert.deepEqual(validateCurrentDecisionEvent({ ...review, payload: { ...review.payload, findings: [] } }), [
    "decision review payload is invalid",
  ]);
  for (const fields of [
    { category: "invented" },
    { label: "invented" },
    { evidenceDigest: "sha256:short" },
    { evidenceDigest: 42 },
    { priorFindingRefs: [] },
    { priorFindingRefs: [""] },
    { anchor: " " },
    { blocking: true },
    { unexpected: true },
  ]) {
    const invalid = { ...review, payload: { ...review.payload, findings: [{ ...finding, ...fields }] } };
    assert.notDeepEqual(validateCurrentDecisionEvent(invalid), [], JSON.stringify(fields));
    assert.throws(() => serializeCanonicalEvent(invalid as typeof review), JSON.stringify(fields));
  }
  const future = { ...review, payload: { ...review.payload, findings: [{ ...finding, futureField: true }] } };
  assert.deepEqual(validateDecisionEvent(future), [], "historical readers still admit additive fields");
  const historical = {
    ...review,
    payload: { ...review.payload, findings: [{ ...finding, category: "historical-report-category" }] },
  };
  assert.deepEqual(validateDecisionEvent(historical), [], "admitted report metadata is not rewritten or narrowed");
  assert.deepEqual(parseCanonicalEvent(serializePersistedCanonicalEvent(historical as typeof review)), historical);
  assert.notDeepEqual(validateCurrentDecisionEvent(historical), [], "new findings require the current vocabulary");
  assert.throws(() => serializeCanonicalEvent(historical as typeof review), /decision review payload is invalid/u);
  assert.notDeepEqual(
    validateDecisionEvent({ ...review, payload: { ...review.payload, findings: [{ ...finding, anchor: " " }] } }),
    [],
    "historical readers retain the original anchor validation",
  );
  for (const invalid of [
    { ...review, actor: { principal: { personId: "" }, executor: null } },
    { ...review, source: { kind: "node", nodeId: "" } },
    { ...review, payload: { ...review.payload, reviewContentDigest: "sha256:short" } },
  ])
    assert.notDeepEqual(validateCurrentDecisionEvent(invalid), []);
});

test("Decision outcome embeds an independently verifiable machine-content consent", () => {
  const current = {
    decisionId: decisionDraft.decisionId,
    state: "proposed",
    title: decisionDraft.payload.title,
    question: decisionDraft.payload.question,
    riskTier: decisionDraft.payload.riskTier,
    urgency: decisionDraft.payload.urgency,
    vertical: decisionDraft.payload.vertical,
    preset: decisionDraft.payload.preset,
    decisionClass: decisionDraft.payload.decisionClass,
    appliesTo: decisionDraft.payload.appliesTo,
    proposer: decisionDraft.actor,
    arbiter: null,
    proposedAt: decisionDraft.occurredAt,
    decidedAt: null,
    workspaceRevision: 1,
    chosen: decisionDraft.payload.chosen,
    rejected: decisionDraft.payload.rejected,
    claims: [],
    judgmentConsents: [],
    reviews: [],
    reviewResponses: [],
    reviewOverrides: [],
  } satisfies Omit<DecisionDocumentState, "relations">;
  const outcome = {
    ...decisionDraft,
    eventId: "event-decision-accept",
    workspaceRevision: 2,
    opId: "op-decision-accept",
    type: "decision_accepted",
    actor: { principal: { personId: "person-proposer" }, executor: null },
    occurredAt: "2026-08-14T00:01:00.000Z",
    payload: {
      rationale: "CEO judgment.",
      judgmentOnlyRationale: "CEO explicitly judges without evidence.",
    },
  } as const satisfies DecisionEventDraftV1;
  const accepted = compileDecisionWrite({
    decisionReviewRequirement: "off",
    event: outcome,
    currentDecision: current,
    currentRelations: [],
    currentDocument: {
      blobSha256: decision.event.payload.decisionDocumentClaim.sha256,
      body: decision.body,
    },
  });
  const consent = accepted.event.payload.judgmentConsent;
  assert.deepEqual(
    {
      schema: consent.schema,
      decisionId: consent.decisionId,
      action: consent.action,
      targetState: consent.targetState,
      actor: consent.actor,
      source: consent.source,
      consentedAt: consent.consentedAt,
    },
    {
      schema: "decision-judgment-consent/v1",
      decisionId: "dec_CONTRACT",
      action: "accept",
      targetState: "in_effect",
      actor: outcome.actor,
      source: outcome.source,
      consentedAt: outcome.occurredAt,
    },
  );
  assert.equal(consent.machineDigest, decisionMachineDigest({ ...current, relations: [] }));
  assert.match(consent.consentId, /^djc_[0-9a-f]{26}$/u);
  assert.deepEqual(validateDecisionEvent(accepted.event), []);
  assert.match(accepted.body, new RegExp(`judgmentConsents: .*${consent.consentId}`, "u"));
  const nestedFuture = {
    ...accepted.event,
    payload: {
      ...accepted.event.payload,
      judgmentConsent: {
        ...consent,
        actor: { ...consent.actor, futureOptionalField: true },
      },
    },
  };
  assert.deepEqual(validateDecisionEvent(nestedFuture), []);
  assert.notDeepEqual(validateCurrentDecisionEvent(nestedFuture), []);
  const proseOnly = compileDecisionWrite({
    decisionReviewRequirement: "off",
    event: outcome,
    currentDecision: current,
    currentRelations: [],
    currentDocument: {
      blobSha256: decision.event.payload.decisionDocumentClaim.sha256,
      body: decision.body.replace("# Canonical Decision", "# Hand-edited prose"),
    },
  });
  assert.equal(
    proseOnly.event.payload.judgmentConsent.machineDigest,
    consent.machineDigest,
    "prose is outside the machine-content pin",
  );
  for (const invalidConsent of [
    { ...consent, actor: { principal: { personId: "other" }, executor: null } },
    { ...consent, source: "remote_direct" },
  ])
    assert.notDeepEqual(
      validateDecisionEvent({
        ...accepted.event,
        payload: { ...accepted.event.payload, judgmentConsent: invalidConsent },
      }),
      [],
    );
  const digestTampered = {
    ...accepted.event,
    payload: {
      ...accepted.event.payload,
      judgmentConsent: {
        ...consent,
        machineDigest: `sha256:${"0".repeat(64)}` as const,
      },
    },
  };
  assert.throws(
    () => assertDecisionJudgmentConsent({ ...current, relations: [] }, digestTampered),
    /machine content cut/u,
  );
  const { judgmentConsent: _consent, ...legacy } = accepted.event.payload;
  assert.notDeepEqual(validateDecisionEvent({ ...accepted.event, payload: legacy }), []);
  assert.notDeepEqual(
    validateDecisionEvent({
      ...accepted.event,
      payload: { ...legacy, contentPins: [{ digest: consent.machineDigest }] },
    }),
    [],
  );
});

// #1546: the proposal validator answered every shape failure with one sentence, so a rejected packet
// had to be bisected by hand. Each wrong field must now name itself, and several wrong fields at once
// must all be named — while the accept/reject verdict stays exactly what it was.
test("#1546: a rejected Decision proposal names every field that is actually wrong", () => {
  const payload = decision.event.payload,
    event = (next: Record<string, unknown>) => ({
      ...decision.event,
      payload: { ...payload, ...next },
    });
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
    [{ chosen: [{ id: "XX1", text: "Wrong prefix" }] }, /^chosen\[0\]\.id must be a CH id$/u],
    [
      { rejected: [{ id: "RJ1", text: "No reason given", whyNot: "" }] },
      /^rejected\[0\]\.whyNot must be 1\.\.199 code points$/u,
    ],
    [{ claims: [{ id: "C1", text: "Bad flag", loadBearing: "yes" }] }, /^claims\[0\]\.loadBearing must be a boolean$/u],
    [{ fulfillments: [{ claimId: "C1", mode: "wished" }] }, /^fulfillments\[0\]\.mode must be one of/u],
    [{ fulfillments: [{ claimId: "C9", mode: "evidenced" }] }, /^every fulfillment must name a distinct claim/u],
  ] as const) {
    const issues = validateDecisionEvent(event(next as Record<string, unknown>));
    assert.equal(issues.length, 1, `${JSON.stringify(next)} -> ${JSON.stringify(issues)}`);
    assert.match(issues[0]!, pattern, JSON.stringify(next));
  }
  // Several wrong fields at once are all reported, not just the first one the old chain hit.
  const many = validateDecisionEvent(event({ title: "", riskTier: "urgent", body: 7 }));
  assert.equal(many.length, 3, JSON.stringify(many));
  assert.deepEqual([...many].sort(), [
    "body must be a string",
    "riskTier must be low, medium, or high",
    "title must be a non-empty string",
  ]);
  // A wrong field SET still fails closed as one message naming the exact contract.
  const { relations: _relations, ...missing } = payload;
  assert.deepEqual(validateDecisionEvent({ ...decision.event, payload: missing }), [
    "decision proposal requires exactly: title, question, riskTier, urgency, vertical, preset, appliesTo, decisionClass, chosen, rejected, body, claims, fulfillments, relations, provenance",
  ]);
});

test("Fact archival and unarchival never recreate generated owner or supersession relations", () => {
  const event = compileFactWrite({ event: draft }).event;
  assert.equal(embeddedRelationEventsForReplay(event).length, 1);
  for (const type of ["fact_archived", "fact_unarchived"] as const)
    assert.deepEqual(embeddedRelationEventsForReplay({ ...event, type }), []);
});
