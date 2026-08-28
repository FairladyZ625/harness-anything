// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { blockingOf } from "../../src/domain/task-blocking.ts";
import { closeoutReadiness, type CloseoutSnapshot } from "../../src/domain/closeout-readiness.ts";
import { coverageOf, freshnessReasonOf } from "../../src/domain/decision-coverage.ts";
import { factLiveness } from "../../src/domain/fact-liveness.ts";
import { consentedApprovedReview, reviewDigest } from "../../src/domain/review.ts";

const actor = { principal: { personId: "owner" }, executor: null } as const;
const commitSha = "a".repeat(40);

function closeout(gateResult: "pass" | "fail" = "pass"): CloseoutSnapshot {
  const execution = { schema: "execution/v1", executionId: "exe-1", taskId: "task-1", state: "submitted", iteration: 0, actor, source: "local", claimedAt: "2026-08-18T00:00:00.000Z", submittedAt: "2026-08-18T00:01:00.000Z", closedAt: null, submission: { completionClaim: "done", deliverables: ["packages/kernel/src/domain/task.ts"], outputs: [], verificationNotes: ["tests"], knownGaps: [], residualRisks: [], commitSha } } as unknown as CloseoutSnapshot["executions"][number];
  const review = { schema: "review/v1", reviewId: "review-1", taskId: "task-1", executionId: "exe-1", verdict: "approved", actor, capabilityRef: "cap", reason: "approved", evidenceChecked: ["tests"], commitSha, iteration: 0, contentDigest: `sha256:${"b".repeat(64)}`, reviewedAt: "2026-08-18T00:02:00.000Z" } as const;
  return { task: { status: "in_review", iteration: 0, completionGateIds: ["ci"] }, executions: [execution], reviews: [review], consents: [{ schema: "review-consent/v1", consentId: "consent-1", taskId: "task-1", executionId: "exe-1", reviewId: "review-1", reviewDigest: reviewDigest(review), contentDigest: review.contentDigest, actor, source: "local", consentedAt: "2026-08-18T00:03:00.000Z" }], codeDocWitnesses: [], gateWitnesses: [{ schema: "completion-gate-witness/v1", witnessId: "witness-1", receiptId: "receipt-1", checkerId: "ci", gateId: "ci", result: gateResult, taskId: "task-1", executionId: "exe-1", commitSha, iteration: 0, actor, source: "local", verifiedAt: "2026-08-18T00:04:00.000Z" } as CloseoutSnapshot["gateWitnesses"][number]] };
}

test("closeout readiness requires a passing exact-cut gate, not witness existence", () => {
  assert.equal(closeoutReadiness(closeout("pass")).readiness, "ready");
  const failed = closeoutReadiness(closeout("fail"));
  assert.equal(failed.readiness, "failed");
  assert.deepEqual(failed.gates, [{ gateId: "ci", status: "failed", detail: "current execution cut did not pass" }]);
  const stale = closeout();
  assert.equal(closeoutReadiness({ ...stale, gateWitnesses: stale.gateWitnesses.map((witness) => ({ ...witness, commitSha: "c".repeat(40) })) }).readiness, "incomplete");
  const recovered = closeout("fail");
  assert.deepEqual(closeoutReadiness({ ...recovered, gateWitnesses: [...recovered.gateWitnesses, { ...recovered.gateWitnesses[0]!, witnessId: "witness-2", receiptId: "receipt-2", result: "pass" }] }).gates, [{ gateId: "ci", status: "passed" }]);
});

test("code-doc reconciliation is not applicable only to unambiguous task-package deliverables", () => {
  const base = closeout("pass"),
    withDeliverables = (deliverables: readonly string[]) => ({
      ...base,
      task: { ...base.task!, completionGateIds: ["code-doc-reconciliation"] },
      executions: base.executions.map((execution) => ({
        ...execution,
        submission: execution.submission ? { ...execution.submission, deliverables } : null,
      })),
    });
  const reportOnly = closeoutReadiness(withDeliverables(["artifacts/reports/audit.md"]));
  assert.equal(reportOnly.readiness, "ready");
  assert.deepEqual(reportOnly.gates, [{
    gateId: "code-doc-reconciliation",
    status: "passed",
    detail: "not applicable: submission delivers task-package artifacts only",
  }]);
  assert.equal(closeoutReadiness(withDeliverables(["packages/kernel/src/domain/task.ts"])).blocker, "gate");
  assert.equal(closeoutReadiness(withDeliverables([])).blocker, "gate", "an empty declaration stays fail-closed");
  assert.equal(
    closeoutReadiness(withDeliverables(["artifacts/report.md", "implementation complete"])).blocker,
    "gate",
    "an ambiguous free-form deliverable must not waive the witness",
  );
});

test("closeout consumes the latest content-pinned consent selection and ignores other Reviews", () => {
  const base = closeout("pass"), selected = base.reviews[0]!, selectedConsent = base.consents[0]!;
  const dismissed = { ...selected, reviewId: "review-dismissed", verdict: "dismissed" as const, reason: "superseded review history" };
  const unselected = { ...selected, reviewId: "review-unselected", reason: "approved but not selected" };
  const earlierConsent = { ...selectedConsent, consentId: "consent-unselected", reviewId: unselected.reviewId, reviewDigest: reviewDigest(unselected), contentDigest: unselected.contentDigest };
  const history = { ...base, reviews: [dismissed, unselected, selected], consents: [earlierConsent, selectedConsent] };

  assert.equal(consentedApprovedReview(history.reviews, history.consents, "exe-1", commitSha, 0)?.review.reviewId, selected.reviewId);
  assert.equal(closeoutReadiness(history).readiness, "ready");
  const unpinnedSelection = { ...history, consents: [{ ...selectedConsent, reviewDigest: `sha256:${"0".repeat(64)}` as `sha256:${string}` }] };
  assert.equal(closeoutReadiness(unpinnedSelection).blocker, "consent", "an unselected approved Review must not satisfy the gate");
});

test("closeout readiness gates milestone and long_running completion on an active decision derives edge", () => {
  const edge = (relationType: string, state: string, targetRef = "task/task-1") => [{ relationId: "rel-lineage", sourceRef: "decision/dec-1/CH1", targetRef, relationType, state }];
  const milestone = () => { const base = closeout("pass"); return { ...base, task: { ...base.task!, taskId: "task-1", taskClass: "milestone" as const } }; };
  // An orphan milestone is not closeout-ready even with every other criterion green.
  const orphan = closeoutReadiness(milestone());
  assert.equal(orphan.readiness, "incomplete");
  assert.equal(orphan.blocker, "lineage");
  // Only an active derives edge naming this task authorises completion.
  assert.equal(closeoutReadiness({ ...milestone(), decisionRelations: edge("derives", "retired") }).readiness, "incomplete");
  assert.equal(closeoutReadiness({ ...milestone(), decisionRelations: edge("relates", "active") }).readiness, "incomplete");
  assert.equal(closeoutReadiness({ ...milestone(), decisionRelations: edge("derives", "active", "task/someone-else") }).readiness, "incomplete");
  assert.equal(closeoutReadiness({ ...milestone(), decisionRelations: edge("derives", "active") }).readiness, "ready");
  // long_running tasks read their class, not a boolean, and obey the same rule.
  const longRunning = { ...milestone(), task: { ...milestone().task!, taskClass: "long_running" as const } };
  assert.equal(closeoutReadiness(longRunning).blocker, "lineage");
  assert.equal(closeoutReadiness({ ...longRunning, decisionRelations: edge("derives", "active") }).readiness, "ready");
  // Standard tasks never required lineage and still do not.
  assert.equal(closeoutReadiness({ ...closeout("pass"), task: { ...closeout("pass").task!, taskId: "task-1", taskClass: "standard" } }).readiness, "ready");
  // A missing gate keeps its own blocker; the lineage gap still withholds readiness.
  const gateFirst = closeoutReadiness({ ...milestone(), gateWitnesses: [], decisionRelations: edge("derives", "active") });
  assert.equal(gateFirst.readiness, "incomplete");
  assert.equal(gateFirst.blocker, "gate");
});

test("completed tasks retain passed gate badges from their accepted execution cut", () => {
  const snapshot = closeout("pass");
  const assessment = closeoutReadiness({ ...snapshot, task: { ...snapshot.task!, status: "done" }, executions: snapshot.executions.map((execution) => ({ ...execution, state: "accepted" })) });
  assert.equal(assessment.readiness, "passed");
  assert.equal(assessment.executionId, "exe-1");
  assert.deepEqual(assessment.gates, [{ gateId: "ci", status: "passed" }]);
});

test("fact liveness retires the target of the canonical supersedes-fact edge", () => {
  const edges = [{ sourceRef: "fact/task/F-new", targetRef: "fact/task/F-old", relationType: "supersedes-fact", state: "active" }];
  assert.equal(factLiveness({ ref: "fact/task/F-old" }, edges), "superseded_fact");
  assert.equal(factLiveness({ ref: "fact/task/F-new" }, edges), "standing");
  assert.equal(factLiveness({ ref: "fact/task/F-old" }, [{ ...edges[0]!, state: "edge_retired" }]), "standing");
});

test("coverage handles transitive evidence, delivered tasks, standing policy, and only live refuters", () => {
  const decisions = [{ ref: "decision/d1", state: "in_effect", decisionClass: "ordinary", appliesTo: { modules: [], productLines: [] }, claims: [
    { ref: "decision/d1/C1", loadBearing: true, fulfillment: "evidenced" as const },
    { ref: "decision/d1/C2", loadBearing: true, fulfillment: "delivered" as const }
  ] }, { ref: "decision/policy", state: "in_effect", decisionClass: "standing_policy", appliesTo: { modules: ["kernel"], productLines: [] }, claims: [{ ref: "decision/policy/C1", loadBearing: true, fulfillment: "standing-policy" as const }] }];
  const relations = [
    { relationId: "via", sourceRef: "decision/d1/C1", targetRef: "decision/helper", relationType: "relates", state: "active" },
    { relationId: "evidence", sourceRef: "decision/helper", targetRef: "fact/task/F-live", relationType: "evidenced-by", state: "active" },
    { relationId: "delivery", sourceRef: "decision/d1/C2", targetRef: "task/done", relationType: "derives", state: "active" },
    { relationId: "refute", sourceRef: "decision/d1", targetRef: "fact/task/F-retired", relationType: "refuted-by", state: "active" },
    { relationId: "retire", sourceRef: "fact/task/F-new", targetRef: "fact/task/F-retired", relationType: "supersedes-fact", state: "active" }
  ];
  const rows = coverageOf(decisions, [{ ref: "fact/task/F-live" }, { ref: "fact/task/F-retired" }, { ref: "fact/task/F-new" }], [{ ref: "task/done", status: "done" }], relations);
  assert.deepEqual(rows.map(({ claimRef, status, relationPath }) => ({ claimRef, status, relationPath })), [
    { claimRef: "decision/d1/C1", status: "covered", relationPath: ["via", "evidence"] },
    { claimRef: "decision/d1/C2", status: "covered", relationPath: ["delivery"] },
    { claimRef: "decision/policy/C1", status: "covered", relationPath: ["decision/policy"] }
  ]);
});

test("freshness reason classifies uncovered causes once, in the domain", () => {
  // covered rows carry no cause, whatever their other fields say.
  assert.equal(freshnessReasonOf({ status: "covered", fulfillment: "evidenced", refutingFactRefs: ["fact/task/F-live"] }), null);
  // refuted outranks the other causes: an undeclared claim under active refutation is refuted.
  assert.equal(freshnessReasonOf({ status: "uncovered", fulfillment: "evidenced", refutingFactRefs: ["fact/task/F-live"] }), "refuted");
  assert.equal(freshnessReasonOf({ status: "uncovered", fulfillment: null, refutingFactRefs: ["fact/task/F-live"] }), "refuted");
  assert.equal(freshnessReasonOf({ status: "uncovered", fulfillment: "evidenced", refutingFactRefs: [] }), "no-live-evidence");
  assert.equal(freshnessReasonOf({ status: "uncovered", fulfillment: "delivered", refutingFactRefs: [] }), "no-live-evidence");
  assert.equal(freshnessReasonOf({ status: "uncovered", fulfillment: "standing-policy", refutingFactRefs: [] }), "no-live-evidence");
  assert.equal(freshnessReasonOf({ status: "uncovered", fulfillment: null, refutingFactRefs: [] }), "fulfillment-undeclared");
  // the served row shape leaves refutingFactRefs optional; absent is not refuted.
  assert.equal(freshnessReasonOf({ status: "uncovered", fulfillment: "evidenced" }), "no-live-evidence");
});

test("blocking applies depends-on to the source and releases it only when the target is done", () => {
  const tasks = [{ taskId: "a", status: "active" }, { taskId: "b", status: "active" }], relation = { relationId: "dep", sourceRef: "task/a", targetRef: "task/b", relationType: "depends-on", direction: "directed", state: "active", rationale: "a waits" };
  assert.deepEqual(blockingOf(tasks, [relation]).map(({ taskId, state }) => ({ taskId, state })), [{ taskId: "a", state: "blocked" }, { taskId: "b", state: "clear" }]);
  assert.deepEqual(blockingOf([{ ...tasks[0]! }, { ...tasks[1]!, status: "done" }], [relation]).map(({ state }) => state), ["clear", "clear"]);
  assert.deepEqual(blockingOf(tasks, [relation, { ...relation, relationId: "return", sourceRef: "task/b", targetRef: "task/a" }]).map(({ state, warnings }) => ({ state, cycle: warnings.some((warning) => warning.includes("cycle")) })), [{ state: "blocked", cycle: true }, { state: "blocked", cycle: true }]);
});
