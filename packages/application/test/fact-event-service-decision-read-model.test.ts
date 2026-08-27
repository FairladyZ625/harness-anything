// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deriveRelationId,
  makeTaskEventStore,
  makeTaskProjection,
  type DecisionEventDraftV1,
} from "../../kernel/src/index.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { makeDecisionService, makeFactService } from "../src/index.ts";

import {
  actor,
  bundle,
  code,
  compileDecision,
  decisionAt,
  decisionEvent,
  factEvent,
  git,
  recordDecision,
  recordFact,
  withDecisionFixture,
} from "./fact-event-service.fixtures.ts";
test("Decision list derives E selectors, orders them numerically, filters ranges, and rejects ambiguity", () => {
  withDecisionFixture(({ service, projection }) => {
    const proposed = decisionEvent(1, "decision_proposed");
    if (proposed.type !== "decision_proposed") throw new Error("proposal fixture missing");
    const ids = ["dec_NO_LEGACY", "dec_IMPORTED_E10_ALPHA", "dec_IMPORTED_E2_BETA", "dec_IMPORTED_E2_ALPHA"];
    ids.forEach((decisionId, index) =>
      recordDecision(
        service,
        projection,
        decisionAt(
          index + 1,
          decisionId,
          "decision_proposed",
          {
            ...proposed.payload,
            title: decisionId,
            appliesTo: {
              modules: [index % 2 ? "daemon" : "kernel"],
              productLines: [index === 1 ? "platform" : "core"],
            },
          },
          actor,
        ),
      ),
    );
    const listed = service.list({});
    assert.deepEqual(
      listed.decisions.map(({ decisionId, legacyId }) => [decisionId, legacyId]),
      [
        ["dec_IMPORTED_E2_ALPHA", "E2"],
        ["dec_IMPORTED_E2_BETA", "E2"],
        ["dec_IMPORTED_E10_ALPHA", "E10"],
        ["dec_NO_LEGACY", undefined],
      ],
    );
    assert.equal(
      listed.decisions.every(({ body }) => body === null),
      true,
    );
    assert.deepEqual(
      service.list({ legacyRange: { start: 3, end: 10 } }).decisions.map(({ decisionId }) => decisionId),
      ["dec_IMPORTED_E10_ALPHA"],
    );
    assert.deepEqual(
      service.list({ module: "daemon", productLine: "platform" }).decisions.map(({ decisionId }) => decisionId),
      ["dec_IMPORTED_E10_ALPHA"],
    );
    assert.equal(service.show("E10").decision.decisionId, "dec_IMPORTED_E10_ALPHA");
    assert.throws(
      () => service.show("E2"),
      (error: unknown) => code(error) === "ambiguous_selector",
    );
    assert.throws(
      () => service.show("E404"),
      (error: unknown) => code(error) === "entity_not_found",
    );
  });
});

test("Decision read catches up an L1-only authored proposal without a body-null crash window", () => {
  withDecisionFixture(({ store, projection, service }) => {
    const proposed = compileDecision(projection, decisionEvent(1, "decision_proposed"));
    store.append(proposed);
    const listed = service.list({ search: "Canonical" });
    assert.equal(listed.status, "ready");
    assert.equal(listed.watermark, 1);
    assert.equal(listed.decisions[0]?.body, null);
    assert.equal(service.show("dec_FIXTURE").decision.body?.body, "\n# Canonical Decision\n");
  });
});

test("Decision coverage replays all fulfillment modes, refutation, and exact task_completed basis", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-coverage-"));
  let projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    git(rootDir, "init", "--quiet");
    git(rootDir, "config", "user.name", "Coverage Test");
    git(rootDir, "config", "user.email", "coverage@example.invalid");
    git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
    const store = makeTaskEventStore({ repoId: "coverage-test", rootDir });
    projection = makeTaskProjection({ rootDir, eventStore: store });
    for (const event of lifecycleFixture().events) {
      const compiled = bundle(event);
      store.append(compiled);
      projection.apply(event, compiled.plan);
    }
    const factService = makeFactService({ eventStore: store, projection }),
      decisionService = makeDecisionService({ eventStore: store, projection });
    recordFact(factService, projection, factEvent(7, "task-1", "F-ABCDEFGH"));
    recordFact(factService, projection, factEvent(8, "task-1", "F-BCDEFGHJ"));
    let revision = 9;
    const record = (
      decisionId: string,
      type: DecisionEventDraftV1["type"],
      payload: unknown,
      eventActor = type === "decision_proposed"
        ? actor
        : ({
            principal: { personId: "person-arbiter" },
            executor: null,
          } as const),
    ) => recordDecision(decisionService, projection, decisionAt(revision++, decisionId, type, payload, eventActor));
    const propose = (decisionId: string, decisionClass: "ordinary" | "standing_policy" = "ordinary") =>
      record(decisionId, "decision_proposed", {
        title: decisionId,
        question: `Should ${decisionId} hold?`,
        riskTier: "medium",
        urgency: "medium",
        vertical: "default",
        preset: "default",
        appliesTo: { modules: ["kernel"], productLines: [] },
        decisionClass,
        chosen: [{ id: "CH1", text: "Proceed" }],
        rejected: [{ id: "RJ1", text: "Stop", whyNot: "Evidence supports proceeding" }],
        body: `\n# ${decisionId}\n`,
        claims: [],
        fulfillments: [],
        relations: [],
        provenance: [
          {
            runtime: "codex",
            sessionId: "session-decision",
            transcriptReachability: "by_session_id",
            boundAt: "2026-08-13T00:00:00.000Z",
          },
        ],
      });
    const claim = (decisionId: string, mode: "evidenced" | "delivered" | "standing_policy") => {
      record(decisionId, "decision_claim_declared", {
        claimId: "C1",
        text: `${decisionId} is fulfilled`,
        loadBearing: true,
      });
      record(decisionId, "decision_claim_fulfillment_declared", {
        claimId: "C1",
        mode,
      });
    };
    const relate = (
      decisionId: string,
      source: string,
      target: string,
      type: "derives" | "evidenced-by" | "refuted-by",
    ) => {
      const identity = { source, target, type, direction: "directed" as const };
      record(decisionId, "decision_related", {
        relation: {
          relation_id: deriveRelationId(identity),
          ...identity,
          strength: "strong",
          origin: "declared",
          rationale: "Canonical coverage evidence",
          state: "active",
        },
      });
    };
    propose("dec_STANDING", "standing_policy");
    record("dec_STANDING", "decision_accepted", {
      rationale: "Independent acceptance",
      judgmentOnlyRationale: "Standing policy is a CEO judgment.",
    });
    claim("dec_STANDING", "standing_policy");
    propose("dec_DELIVERED");
    record("dec_DELIVERED", "decision_accepted", {
      rationale: "Independent acceptance",
      judgmentOnlyRationale: "Delivery is a CEO judgment.",
    });
    claim("dec_DELIVERED", "delivered");
    relate("dec_DELIVERED", "decision/dec_DELIVERED/C1", "task/task-1", "derives");
    propose("dec_EVIDENCED");
    record("dec_EVIDENCED", "decision_accepted", {
      rationale: "Independent acceptance",
      judgmentOnlyRationale: "Evidence semantics are covered separately.",
    });
    claim("dec_EVIDENCED", "evidenced");
    relate("dec_EVIDENCED", "decision/dec_EVIDENCED/C1", "fact/F-ABCDEFGH", "evidenced-by");
    relate("dec_EVIDENCED", "decision/dec_EVIDENCED/C1", "fact/F-BCDEFGHJ", "refuted-by");
    const graph = decisionService.graph();
    assert.equal(graph.status, "ready");
    assert.equal(graph.watermark, revision - 1);
    const byDecision = new Map(graph.coverageRows.map((row) => [row.decisionRef, row]));
    assert.equal(byDecision.get("decision/dec_STANDING")?.status, "covered");
    assert.equal(byDecision.get("decision/dec_STANDING")?.fulfillment, "standing_policy");
    assert.equal(
      byDecision.get("decision/dec_DELIVERED")?.status,
      "covered",
      "task_completed is the delivered truth source",
    );
    assert.equal(byDecision.get("decision/dec_DELIVERED")?.fulfillment, "delivered");
    assert.equal(byDecision.get("decision/dec_EVIDENCED")?.status, "uncovered");
    assert.deepEqual(byDecision.get("decision/dec_EVIDENCED")?.refutingFactRefs, ["fact/F-BCDEFGHJ"]);
    assert.equal(
      graph.coverageRows.every((row) => row.basisRevision === graph.watermark),
      true,
    );
  } finally {
    projection?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
