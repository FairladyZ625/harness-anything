// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  assessFactRetirement,
  upstreamEvidencingFacts,
  type FactRetirementDecision,
  type FactRetirementRelation,
} from "../../src/domain/fact-retirement-readiness.ts";

const taskId = "task_retirement",
  decisionId = "dec_retirement",
  factRef = "fact/F-ABCDEFGH",
  decisions: readonly FactRetirementDecision[] = [
    {
      decisionId,
      claims: [
        { id: "C1", loadBearing: true },
        { id: "C2", loadBearing: false },
      ],
    },
  ],
  upstream: readonly FactRetirementRelation[] = [
    relation(`decision/${decisionId}/CH1`, `task/${taskId}`, "derives"),
    relation(`decision/${decisionId}/C1`, factRef, "evidenced-by"),
    relation(`decision/${decisionId}/C2`, "fact/F-BCDEFGHJ", "evidenced-by"),
  ];

test("the upstream walk follows decision derives task and load-bearing claim evidenced-by fact", () => {
  assert.deepEqual(upstreamEvidencingFacts(taskId, decisions, upstream), [
    {
      factRef,
      viaClaim: `decision/${decisionId}/C1`,
      viaDecision: `decision/${decisionId}`,
    },
  ]);
  assert.deepEqual(
    upstreamEvidencingFacts(taskId, decisions, [
      relation(`task/${taskId}`, `decision/${decisionId}/CH1`, "derives"),
      relation(factRef, `decision/${decisionId}/C1`, "evidenced-by"),
    ]),
    [],
  );
});

test("standing upstream evidence is undeclared until superseded or attested still true", () => {
  const missing = assessFactRetirement({ taskId, decisions, relations: upstream, stillHoldsAttestations: [] });
  assert.equal(missing.ready, false);
  assert.equal(missing.code, "fact_retirement_undeclared");
  assert.deepEqual(missing.undischarged, [
    {
      factRef,
      viaClaim: `decision/${decisionId}/C1`,
      viaDecision: `decision/${decisionId}`,
    },
  ]);

  const attested = assessFactRetirement({
    taskId,
    decisions,
    relations: upstream,
    stillHoldsAttestations: [{ factRef, rationale: "The motivating observation remains true after delivery." }],
  });
  assert.equal(attested.ready, true);
  assert.deepEqual(attested.undischarged, []);
});

test("a task-produced superseding Fact discharges the upstream Fact without an attestation", () => {
  const replacement = "fact/F-CDEFGHJK",
    assessment = assessFactRetirement({
      taskId,
      decisions,
      relations: [
        ...upstream,
        relation(`task/${taskId}`, replacement, "produces"),
        relation(replacement, factRef, "supersedes-fact"),
      ],
      stillHoldsAttestations: [],
    });
  assert.equal(assessment.ready, true);
  assert.deepEqual(assessment.undischarged, []);
});

test("no upstream evidenced Fact is ready and mixed dispositions report only missing claim paths", () => {
  assert.equal(assessFactRetirement({ taskId, decisions, relations: [], stillHoldsAttestations: [] }).ready, true);
  const secondDecision = "dec_second",
    secondFact = "fact/F-DEFGHJKM",
    mixed = assessFactRetirement({
      taskId,
      decisions: [...decisions, { decisionId: secondDecision, claims: [{ id: "C9", loadBearing: true }] }],
      relations: [
        ...upstream,
        relation(`decision/${secondDecision}/CH1`, `task/${taskId}`, "derives"),
        relation(`decision/${secondDecision}/C9`, secondFact, "evidenced-by"),
      ],
      stillHoldsAttestations: [{ factRef, rationale: "Still true." }],
    });
  assert.deepEqual(mixed.undischarged, [
    {
      factRef: secondFact,
      viaClaim: `decision/${secondDecision}/C9`,
      viaDecision: `decision/${secondDecision}`,
    },
  ]);
});

function relation(sourceRef: string, targetRef: string, relationType: string): FactRetirementRelation {
  return { sourceRef, targetRef, relationType, state: "active" };
}
