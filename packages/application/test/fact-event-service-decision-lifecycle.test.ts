// harness-test-tier: integration
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { authorizationPort, currentActionEnvelopeVersion, type DecisionEventDraftV1 } from "../../kernel/src/index.ts";

import {
  actor,
  code,
  compileDecision,
  decisionAt,
  decisionEvent,
  recordDecision,
  relationRecord,
  withDecisionFixture,
} from "./fact-event-service.fixtures.ts";
test("Decision transition matrix, transport arbiter, claims, relation retirement, and replay are canonical", () => {
  withDecisionFixture(({ service, projection, store }) => {
    const proposed = compileDecision(projection, decisionEvent(1, "decision_proposed")),
      first = service.record(proposed);
    assert.deepEqual(first, service.record(proposed));
    assert.equal(first.path, "decisions/decision-dec_FIXTURE/decision.md");
    assert.equal(first.documentSha256, proposed.event.payload.decisionDocumentClaim.sha256);
    assert.equal(Buffer.from(store.readContentBlob(first.documentSha256)!).toString("utf8"), proposed.body);
    assert.equal(projection.readDocument(first.path).document?.workspaceRevision, first.revision);
    const rejectsRelation = (relation: ReturnType<typeof relationRecord>, expected: string) =>
      assert.throws(
        () => recordDecision(service, projection, decisionEvent(2, "decision_related", undefined, relation)),
        (error: unknown) => code(error) === expected,
      );
    rejectsRelation(
      relationRecord("decision/dec_OTHER/CH1", "decision/dec_FIXTURE/CH1", "supports"),
      "relation_invalid",
    );
    rejectsRelation(
      relationRecord("decision/dec_FIXTURE/C404", "decision/dec_FIXTURE/CH1", "supports"),
      "anchor_not_found",
    );
    rejectsRelation(
      relationRecord("decision/dec_FIXTURE/CH1", "fact/task-fact/F-12345678", "evidenced-by"),
      "entity_not_found",
    );
    rejectsRelation(
      relationRecord("decision/dec_FIXTURE/CH1", "decision/dec_FIXTURE/RJ1", "produces"),
      "relation_invalid",
    );
    rejectsRelation(
      {
        ...relationRecord("decision/dec_FIXTURE/CH1", "decision/dec_FIXTURE/RJ1", "supports"),
        relation_id: "rel_0000000000000000",
      },
      "relation_invalid",
    );
    const selfJudgment = authorizationPort.authorize(
      {
        version: currentActionEnvelopeVersion,
        actionId: "action-decision-self-judgment",
        kind: "decision.accept",
        target: "decision/dec_FIXTURE",
        actor,
        authorizationRef: "default@3",
        idempotencyKey: "decision-self-judgment",
      },
      {
        commandClasses: ["arbiter"],
        target: { proposalActor: actor },
        evaluatedAtCut: "canonical:1",
      },
    );
    assert.equal(selfJudgment.outcome, "denied");
    assert.equal(
      selfJudgment.bindingsUsed.find((binding) => binding.predicate === "isNotProposalAgent")?.satisfied,
      false,
    );
    const accepted = recordDecision(service, projection, decisionEvent(2, "decision_accepted"));
    assert.equal(accepted.decision.state, "in_effect");
    assert.deepEqual(
      accepted.decision.judgmentConsents.map(({ action, targetState, actor: consentActor, source }) => ({
        action,
        targetState,
        actor: consentActor,
        source,
      })),
      [
        {
          action: "accept",
          targetState: "in_effect",
          actor: { principal: { personId: "person-arbiter" }, executor: null },
          source: "local",
        },
      ],
    );
    recordDecision(service, projection, decisionEvent(3, "decision_claim_declared"));
    recordDecision(service, projection, decisionEvent(4, "decision_claim_fulfillment_declared"));
    assert.deepEqual(projection.readDecisionGraph().decisionAnchors[0]?.anchorRefs, [
      "decision/dec_FIXTURE",
      "decision/dec_FIXTURE/C1",
      "decision/dec_FIXTURE/CH1",
      "decision/dec_FIXTURE/RJ1",
    ]);
    const relation = relationRecord("decision/dec_FIXTURE/C1", "decision/dec_FIXTURE/CH1", "supports"),
      relationId = relation.relation_id;
    recordDecision(service, projection, decisionEvent(5, "decision_related", undefined, relation));
    assert.throws(
      () => recordDecision(service, projection, decisionEvent(6, "decision_related", undefined, relation)),
      (error: unknown) => code(error) === "relation_invalid",
    );
    assert.equal(store.readHead()?.revision, 5, "deterministic relation collision is zero-write");
    recordDecision(service, projection, decisionEvent(6, "decision_relation_retired", undefined, relationId));
    const edge = projection.readDecisionGraph().edges[0]!;
    assert.equal(edge.state, "edge_retired");
    assert.equal(edge.retiredRevision, 6);
    assert.equal(
      recordDecision(service, projection, decisionEvent(7, "decision_retired")).decision.state,
      "outcome_retired",
    );
    assert.throws(
      () => recordDecision(service, projection, decisionEvent(8, "decision_deferred")),
      (error: unknown) => code(error) === "invalid_transition",
    );
    const path = "decisions/decision-dec_FIXTURE/decision.md",
      before = {
        decision: service.show("dec_FIXTURE").decision,
        graph: projection.readDecisionGraph(),
        document: projection.readDocument(path).document,
      };
    projection.close();
    rmSync(projection.path, { force: true });
    projection.rebuild();
    assert.deepEqual(
      {
        decision: service.show("dec_FIXTURE").decision,
        graph: projection.readDecisionGraph(),
        document: projection.readDocument(path).document,
      },
      before,
    );
  });
  for (const [terminal, state] of [
    ["decision_accepted", "in_effect"],
    ["decision_rejected", "rejected"],
    ["decision_deferred", "deferred"],
  ] as const)
    withDecisionFixture(({ service, projection }) => {
      recordDecision(service, projection, decisionEvent(1, "decision_proposed"));
      assert.throws(
        () =>
          recordDecision(service, projection, {
            ...decisionEvent(2, "decision_proposed"),
            eventId: "event-duplicate",
            opId: "op-duplicate",
          }),
        /base must agree/u,
      );
      assert.equal(recordDecision(service, projection, decisionEvent(2, terminal)).decision.state, state);
      for (const illegal of ["decision_accepted", "decision_rejected", "decision_deferred"] as const)
        assert.throws(
          () => recordDecision(service, projection, decisionEvent(3, illegal)),
          (error: unknown) => code(error) === "invalid_transition",
          `${state} -> ${illegal}`,
        );
      if (state === "in_effect") {
        assert.equal(
          recordDecision(service, projection, decisionEvent(3, "decision_retired")).decision.state,
          "outcome_retired",
        );
        assert.throws(
          () => recordDecision(service, projection, decisionEvent(4, "decision_retired")),
          (error: unknown) => code(error) === "invalid_transition",
        );
      } else
        assert.throws(
          () => recordDecision(service, projection, decisionEvent(3, "decision_retired")),
          (error: unknown) => code(error) === "invalid_transition",
          `${state} -> retired`,
        );
    });
});

test("Decision proposal publishes initial prose, claim fulfillment, and relation in one rebuildable revision", () => {
  withDecisionFixture(({ service, projection, store }) => {
    const relation = relationRecord("decision/dec_FIXTURE/C1", "decision/dec_FIXTURE/CH1", "supports"),
      proposal = decisionEvent(1, "decision_proposed") as Extract<
        DecisionEventDraftV1,
        { readonly type: "decision_proposed" }
      >,
      draft = {
        ...proposal,
        payload: {
          ...proposal.payload,
          body: "# Canonical Decision\n\n初始正文。\n",
          claims: [
            {
              id: "C1",
              text: "The initial packet is atomic.",
              loadBearing: true,
            },
          ],
          fulfillments: [{ claimId: "C1", mode: "evidenced" as const }],
          relations: [relation],
        },
      } as const;
    const result = recordDecision(service, projection, draft);
    assert.equal(store.readHead()?.revision, 1);
    assert.deepEqual(result.decision.claims, [
      {
        id: "C1",
        text: "The initial packet is atomic.",
        loadBearing: true,
        fulfillment: "evidenced",
      },
    ]);
    assert.equal(projection.readDecisionGraph().edges[0]?.relationId, relation.relation_id);
    assert.equal(result.decision.body?.body, "# Canonical Decision\n\n初始正文。\n");
    const before = {
      decision: result.decision,
      graph: projection.readDecisionGraph(),
      document: projection.readDocument(result.path).document,
    };
    projection.close();
    rmSync(projection.path, { force: true });
    projection.rebuild();
    assert.deepEqual(
      {
        decision: service.show("dec_FIXTURE").decision,
        graph: projection.readDecisionGraph(),
        document: projection.readDocument(result.path).document,
      },
      before,
    );
  });
});

test("Decision accept requires explicit evidence or judgment-only, while human CEO self-judgment remains valid", () => {
  withDecisionFixture(({ service, projection, store }) => {
    recordDecision(service, projection, decisionEvent(1, "decision_proposed"));
    const before = store.readHead()?.revision;
    assert.throws(
      () =>
        recordDecision(service, projection, {
          ...decisionEvent(2, "decision_accepted"),
          payload: {
            rationale: "Rationale is not evidence.",
            judgmentOnlyRationale: null,
          },
        }),
      (error: unknown) => code(error) === "invalid_transition",
    );
    assert.equal(store.readHead()?.revision, before, "evidence-floor rejection is zero-write");
    recordDecision(service, projection, decisionEvent(2, "decision_claim_declared"));
    const evidence = relationRecord("decision/dec_FIXTURE/C1", "decision/dec_FIXTURE/CH1", "supports");
    recordDecision(service, projection, decisionEvent(3, "decision_related", undefined, evidence));
    assert.equal(
      recordDecision(service, projection, {
        ...decisionEvent(4, "decision_accepted"),
        payload: {
          rationale: "Claim evidence is present.",
          judgmentOnlyRationale: null,
        },
      }).decision.state,
      "in_effect",
    );
  });
  withDecisionFixture(({ service, projection }) => {
    const human = {
        principal: { personId: "person-ceo" },
        executor: null,
      } as const,
      proposal = decisionEvent(1, "decision_proposed") as Extract<
        DecisionEventDraftV1,
        { readonly type: "decision_proposed" }
      >;
    recordDecision(service, projection, decisionAt(1, "dec_FIXTURE", "decision_proposed", proposal.payload, human));
    const accepted = decisionEvent(2, "decision_accepted", human) as Extract<
      DecisionEventDraftV1,
      { readonly type: "decision_accepted" }
    >;
    assert.equal(recordDecision(service, projection, accepted).decision.arbiter?.principal.personId, "person-ceo");
  });
});
