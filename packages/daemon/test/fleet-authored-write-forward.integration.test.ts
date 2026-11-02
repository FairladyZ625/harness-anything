// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { realizedDecisionBody } from "../../../tools/fixtures/task-plan.mjs";
import { fleetNodeClaimFixture, localAuthFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";

function evidence(receipt: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(String(receipt.evidence));
}

async function deniedThenApplied(
  f: Awaited<ReturnType<typeof fleetNodeClaimFixture>>,
  kind: string,
  run: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  f.owners.keycloak.revoke("person-one", "lease-repo", [kind]);
  const before = f.eventCount();
  const denied = await run();
  assert.equal(denied.code, "authorization_denied", JSON.stringify({ kind, denied }));
  assert.equal(f.eventCount(), before, `${kind} denial must not append a canonical event`);
  f.owners.keycloak.permit("person-one", "lease-repo", [kind]);
  const applied = await run();
  assert.equal(applied.outcome, "applied", JSON.stringify({ kind, applied }));
  assert.ok(f.eventCount() > before, `${kind} must reach the canonical writer`);
  return applied;
}

function proposal(title: string) {
  return {
    title,
    question: "Do all edge authored writes reach the same canonical writer?",
    riskTier: "low",
    urgency: "medium",
    vertical: "software/coding",
    preset: "decision-conformance",
    decisionClass: "ordinary",
    appliesTo: { modules: ["daemon"], productLines: [] },
    chosen: [{ id: "CH1", text: "Use the center's authorized command port" }],
    rejected: [{ id: "RJ1", text: "Write the replica", whyNot: "It creates a second writer" }],
    claims: [],
    fulfillments: [],
    body: realizedDecisionBody(title),
  };
}

test(
  "edge fact reclassification, archive and unarchive carry real payloads and center authorization",
  { timeout: 90_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t);
    const edge = await fleetEdgeHostFixture(t, f);
    await deniedThenApplied(f, "fact-type-register", () =>
      edge.command({
        kind: "fact-type-register",
        registersDomainType: "edge-routing",
        statement: "Registered Fact domain type: edge-routing",
        evidenceSource: "test:fleet-authored-write",
        confidence: "high",
        memoryClass: "semantic",
        memoryTags: [],
      }),
    );
    const recorded = await deniedThenApplied(f, "fact-record", () =>
      edge.command({
        kind: "fact-record",
        statement: "Edge fact writes use the center writer.",
        evidenceSource: "test:fleet-authored-write",
        confidence: "high",
        memoryClass: "semantic",
      }),
    );
    const factId = String(evidence(recorded).factId);
    for (const action of [
      { kind: "fact-reclassify", factId, domainTypes: ["edge-routing"], rationale: "Record the verified domain." },
      { kind: "fact-archive", factId, reason: "The observed experiment finished." },
      { kind: "fact-unarchive", factId, reason: "The observation is useful again." },
    ])
      await deniedThenApplied(f, action.kind, () => edge.command(action));
    const shown = await f.host.run("lease-repo", { kind: "fact-show", factId }, localAuthFixture());
    const fact = evidence(shown).fact as Record<string, unknown>;
    assert.deepEqual(fact.domainTypes, ["edge-routing"]);
    assert.equal(fact.archived, false);
  },
);

test("edge task archive and reopen preserve real lifecycle and center denial", { timeout: 90_000 }, async (t) => {
  const f = await fleetNodeClaimFixture(t);
  const edge = await fleetEdgeHostFixture(t, f);
  assert.equal(
    (await edge.command({ kind: "task-create", taskId: "task-edge-archive", title: "Archive from the edge" })).outcome,
    "applied",
  );
  for (const action of [
    { kind: "task-amend", taskId: "task-edge-archive", patches: [{ field: "title", value: "Amended on the edge" }] },
    { kind: "task-archive", taskId: "task-edge-archive", reason: "Pause the obsolete package." },
    { kind: "task-reopen", taskId: "task-edge-archive", reason: "Resume the package." },
  ])
    await deniedThenApplied(f, action.kind, () => edge.command(action));
  const shown = evidence(
    await f.host.run("lease-repo", { kind: "task-show", taskId: "task-edge-archive" }, localAuthFixture()),
  );
  assert.equal((shown.task as Record<string, unknown>).title, "Amended on the edge");
  assert.equal((shown.task as Record<string, unknown>).packageDisposition, "active");
});

test(
  "edge decision proposal, amend, claims and review reach the center with authorization intact",
  { timeout: 90_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true);
    const vertical = await f.host.run("lease-repo", { kind: "vertical-declaration-migrate" }, localAuthFixture());
    assert.equal(vertical.outcome, "applied", JSON.stringify(vertical));
    await waitForFleetPublication(f.host, "lease-repo", String(vertical.opId), localAuthFixture());
    const edge = await fleetEdgeHostFixture(t, f);
    // Propose through the ordinary GUI RPC; subsequent commands use the same fleet wire as the CLI.
    let id = 100;
    const rpc = async (method: string, payload: Record<string, unknown>) => {
      const response = await edge.rpc.handle({
        jsonrpc: "2.0",
        id: ++id,
        method,
        params: { repo: { repoId: "lease-repo" }, payload },
      });
      assert.ok(response && !Array.isArray(response) && "result" in response, JSON.stringify(response));
      return response.result as Record<string, unknown>;
    };
    const proposed = await deniedThenApplied(f, "decision-propose", () =>
      rpc("repo.decision.propose", proposal("Edge decision")),
    );
    const decisionId = String(evidence(proposed).decisionId);
    for (const action of [
      {
        kind: "decision-amend",
        decisionId,
        reason: "Clarify the center route.",
        title: "Edge decision amended",
        standingPolicy: false,
        fulfillments: [],
        sets: [],
        appends: [],
      },
      {
        kind: "decision-claim-add",
        decisionId,
        claimId: "C1",
        text: "The command crosses the fleet port.",
        loadBearing: false,
      },
      { kind: "decision-claim-fulfill", decisionId, claimId: "C1", mode: "evidenced" },
    ])
      await deniedThenApplied(f, action.kind, () => edge.command(action));
    const shown = evidence(await f.host.run("lease-repo", { kind: "decision-show", decisionId }, localAuthFixture()));
    const decision = shown.decision as Record<string, unknown>;
    assert.equal(decision.title, "Edge decision amended");
    const reviewContentDigest = String(decision.currentReviewContentDigest);
    f.owners.keycloak.revoke("person-one", "lease-repo", ["decision-dispatch-review"]);
    const beforeDispatch = f.eventCount();
    const dispatchPayload = { decisionId, expectedDigest: reviewContentDigest };
    assert.equal((await rpc("repo.decision.dispatchReview", dispatchPayload)).code, "authorization_denied");
    assert.equal(f.eventCount(), beforeDispatch);
    f.owners.keycloak.permit("person-one", "lease-repo", ["decision-dispatch-review"]);
    const dispatch = await rpc("repo.decision.dispatchReview", dispatchPayload);
    assert.equal(dispatch.code, "runtime_instance_not_allowed", JSON.stringify(dispatch));
    assert.match(String(dispatch.rejectionExplanation), /No runtime instance is allowed/u);
    assert.equal(f.eventCount(), beforeDispatch, "the center requires an allowed runtime before dispatch");
    for (const operation of ["reject", "defer"]) {
      const other = await rpc("repo.decision.propose", proposal(`Edge GUI ${operation}`));
      assert.equal(other.outcome, "applied", JSON.stringify(other));
      await deniedThenApplied(f, `decision-${operation}`, () =>
        rpc(`repo.decision.${operation}`, {
          decisionId: String(evidence(other).decisionId),
          reason: `Human chooses to ${operation} the proposal.`,
        }),
      );
    }
    // Independent human reviewer on the center; the edge proposer cannot self-review.
    const reportRef = `decisions/decision-${decisionId}/artifacts/reports/edge-independent.md`;
    const reportPath = path.join(f.repo, "harness", reportRef);
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, "# Independent review\n\nThe edge command has the same center authorization boundary.\n");
    const changesReportRef = `decisions/decision-${decisionId}/artifacts/reports/edge-changes.md`;
    writeFileSync(
      path.join(f.repo, "harness", changesReportRef),
      "# Changes requested\n\nClarify the recorded tradeoff.\n",
    );
    const published = await f.host.run(
      "lease-repo",
      { kind: "doc-submit", paths: [reportRef, changesReportRef] },
      localAuthFixture(),
    );
    assert.equal(published.outcome, "applied", JSON.stringify(published));
    await waitForFleetPublication(f.host, "lease-repo", String(published.opId), localAuthFixture());
    const review = {
      kind: "decision-review",
      decisionId,
      reviewId: "review-edge-independent",
      reviewContentDigest,
      verdict: "approved",
      reason: "The current content was independently reviewed.",
      findings: [],
      evidenceChecked: [],
      reportRef,
    };
    f.owners.keycloak.revoke("person-one", "lease-repo", ["decision-review"]);
    const beforeReview = f.eventCount();
    const denied = await edge.command(review);
    assert.equal(denied.code, "authorization_denied", JSON.stringify(denied));
    assert.equal(f.eventCount(), beforeReview);
    f.owners.keycloak.permit("person-one", "lease-repo", ["decision-review"]);
    const selfReview = await edge.command(review);
    assert.equal(selfReview.outcome, "op_rejected", JSON.stringify(selfReview));
    assert.equal(f.eventCount(), beforeReview, "forwarding must retain review independence");
    const reviewer = await fleetEdgeHostFixture(t, f, {
      name: "reviewer",
      nodeId: "center-node",
      personId: "person-center",
    });
    const requested = await reviewer.command({
      ...review,
      reviewId: "review-edge-changes",
      verdict: "changes_requested",
      findings: [{ findingId: "G1", text: "Clarify the tradeoff." }],
      reportRef: changesReportRef,
    });
    assert.equal(requested.outcome, "applied", JSON.stringify(requested));
    await deniedThenApplied(f, "decision-respond-review", () =>
      rpc("repo.decision.respondReview", {
        decisionId,
        responses: [
          {
            reviewId: "review-edge-changes",
            findingId: "G1",
            disposition: "rebut",
            rationale: "The owner explicitly accepts this tradeoff.",
            amendmentRef: null,
          },
        ],
      }),
    );
    await deniedThenApplied(f, "decision-override-review", () =>
      rpc("repo.decision.overrideReview", {
        decisionId,
        reviewContentDigest,
        reviewIds: ["review-edge-changes"],
        reason: "The authenticated human accepts the documented tradeoff.",
      }),
    );
    const reviewed = await reviewer.command(review);
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    const accepted = await deniedThenApplied(f, "decision-accept", () =>
      rpc("repo.decision.accept", {
        decisionId,
        rationale: "The independent reviewer approved this cut.",
        judgmentOnlyRationale: "Routing is verified by integration evidence.",
        reviewId: review.reviewId,
        expectedDigest: reviewContentDigest,
      }),
    );
    assert.equal(
      (await edge.command({ kind: "task-create", taskId: "task-edge-reckon", title: "Coverage evidence" })).outcome,
      "applied",
    );
    // Acceptance records the initial owner assignment; consume that real cut rather than inventing a revision.
    const assigned = await deniedThenApplied(f, "decision-assign", () =>
      edge.command({
        kind: "decision-assign",
        decisionId,
        personId: "person-center",
        expectedVersion: accepted.revision,
      }),
    );
    await deniedThenApplied(f, "decision-unassign", () =>
      edge.command({ kind: "decision-unassign", decisionId, expectedVersion: assigned.revision }),
    );
    for (const action of [
      { kind: "decision-reckon", decisionId, taskId: "task-edge-reckon" },
      { kind: "decision-transition", decisionId, targetState: "outcome_retired", dryRun: false },
    ])
      await deniedThenApplied(f, action.kind, () => edge.command(action));
  },
);

test(
  "edge distillation uses canonical source files and promotes through center authorization",
  { timeout: 90_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t);
    const edge = await fleetEdgeHostFixture(t, f);
    assert.equal(
      (await edge.command({ kind: "task-create", taskId: "task-edge-distill", title: "Distill evidence" })).outcome,
      "applied",
    );
    // File references name center workspace evidence; edge-only source files must be published first.
    const source = "harness/context/distill-source.md";
    mkdirSync(path.dirname(path.join(f.repo, source)), { recursive: true });
    writeFileSync(
      path.join(f.repo, source),
      "# Measured observation\n\nThe canonical writer accepted the experiment.\n",
    );
    const action = { kind: "distill-candidate", taskId: "task-edge-distill", inputPath: source };
    f.owners.keycloak.revoke("person-one", "lease-repo", [action.kind]);
    const before = f.eventCount();
    assert.equal((await edge.command(action)).code, "authorization_denied");
    assert.equal(f.eventCount(), before);
    f.owners.keycloak.permit("person-one", "lease-repo", [action.kind]);
    const candidate = await edge.command(action);
    assert.equal(candidate.outcome, "applied", JSON.stringify(candidate));
    const candidatePath = String(evidence(candidate).candidatePath);
    assert.equal(existsSync(path.join(f.repo, candidatePath)), true, "the center owns the generated candidate");
    await deniedThenApplied(f, "distill-promote", () =>
      edge.command({
        kind: "distill-promote",
        taskId: "task-edge-distill",
        candidatePath,
        statement: "The canonical writer accepted the experiment.",
        confidence: "high",
        memoryClass: "semantic",
      }),
    );
  },
);
