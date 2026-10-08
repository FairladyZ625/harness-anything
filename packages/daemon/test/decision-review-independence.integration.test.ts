// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  decisionReviewContentDigest,
  deriveRelationId,
  makeTaskEventReader,
  serializeCanonicalEvent,
  type DecisionDocumentState,
} from "@harness-anything/kernel";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { realizedDecisionBody } from "../../../tools/fixtures/task-plan.mjs";

const proposer = withPolicyGroup(
  {
    actor: {
      principal: { personId: "person-proposer" },
      executor: { kind: "agent" as const, id: "proposer-agent" },
    },
    source: "local" as const,
    authorizationBindingMode: "declared" as const,
  },
  "contributor",
);

test("an independent approved review lets the proposal owner accept the current Decision cut", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-review-independence-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("decision-review-independence"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "decision-review-independence-test",
  });
  try {
    const settingsOwner = withPolicyGroup(
      { actor: { principal: proposer.actor.principal, executor: null }, source: "local" as const },
      "contributor",
    );
    const settingsUpdated = await cell.run(
      {
        kind: "settings-update",
        decisionReviewRequirement: "high",
        reviewIndependence: "principal",
        idempotencyKey: "decision-review-policy",
      },
      settingsOwner,
    );
    assert.equal(settingsUpdated.outcome, "applied", JSON.stringify(settingsUpdated));
    const proposed = await cell.run(decisionProposal(), proposer),
      decisionId = receiptJson(proposed).decisionId as string,
      owner = withPolicyGroup({ ...proposer, actor: { ...proposer.actor, executor: null } }, "admin"),
      independentReviewer = withPolicyGroup(
        {
          actor: {
            principal: { personId: "person-reviewer" },
            executor: null,
          },
          source: "local" as const,
        },
        "admin",
      );
    const relatedDecisionIds: string[] = [];
    for (const suffix of ["relation-a", "relation-b"]) {
      const relatedProposal = await cell.run(
        { ...decisionProposal(), body: realizedDecisionBody(`Review independence ${suffix}`) },
        proposer,
      );
      relatedDecisionIds.push(receiptJson(relatedProposal).decisionId as string);
    }
    for (const [targetDecisionId, rationale] of [
      [relatedDecisionIds[0], "The first relation belongs to the proposed Decision."],
      [relatedDecisionIds[1], "The second relation was added after proposal publication."],
    ] as const) {
      const related = await cell.run(
        {
          kind: "relation-relate",
          sourceRef: `decision/${decisionId}`,
          targetRef: `decision/${targetDecisionId}`,
          relationType: "relates",
          rationale,
          expectedVersion: 0,
        },
        proposer,
      );
      assert.equal(related.outcome, "applied", JSON.stringify(related));
    }
    const shown = receiptJson(await cell.run({ kind: "decision-show", decisionId, includeBody: true }, owner))
        .decision as DecisionDocumentState & {
        readonly body: { readonly body: string };
        readonly currentReviewContentDigest: `sha256:${string}`;
      },
      digest = shown.currentReviewContentDigest,
      unreviewed = await cell.run(
        {
          kind: "decision-accept",
          decisionId,
          rationale: "The high-risk Decision needs an independent review.",
          judgmentOnlyRationale: "No review was selected.",
          expectedDigest: digest,
        },
        owner,
      );
    assert.deepEqual(
      { outcome: unreviewed.outcome, code: unreviewed.code },
      { outcome: "op_rejected", code: "invalid_transition" },
    );
    const humanApprovedProposal = await cell.run(
        { ...decisionProposal(), body: realizedDecisionBody("Human-approved review requirement") },
        proposer,
      ),
      humanApprovedDecisionId = receiptJson(humanApprovedProposal).decisionId as string,
      humanApprovedDigest = (
        receiptJson(await cell.run({ kind: "decision-show", decisionId: humanApprovedDecisionId }, owner)).decision as {
          readonly currentReviewContentDigest: `sha256:${string}`;
        }
      ).currentReviewContentDigest,
      consentAccept = {
        kind: "decision-accept" as const,
        decisionId: humanApprovedDecisionId,
        rationale: "The owner approved the current high-risk Decision content.",
        judgmentOnlyRationale: "Human consent records approval, not an independent review.",
        consentBy: proposer.actor.principal.personId,
        consentAt: "2026-09-29T01:02:03.000Z",
        consentChannel: "chat" as const,
      },
      consentWithoutReview = await cell.run(consentAccept, owner);
    assert.deepEqual(
      { outcome: consentWithoutReview.outcome, code: consentWithoutReview.code },
      { outcome: "op_rejected", code: "invalid_transition" },
      "human consent no longer exempts a high-risk Decision from the review requirement",
    );
    assert.match(String(consentWithoutReview.rejectionExplanation), /requires an approved review/u);
    const humanApprovedReportRef = `decisions/decision-${humanApprovedDecisionId}/artifacts/reports/human-approved.md`;
    writeReport(rootDir, humanApprovedReportRef);
    const humanApprovedReview = await cell.run(
      {
        kind: "decision-review",
        decisionId: humanApprovedDecisionId,
        reviewId: "review-human-approved",
        reviewContentDigest: humanApprovedDigest,
        verdict: "approved",
        reason: "The current content was independently reviewed before the owner accepted it.",
        findings: [],
        evidenceChecked: [],
        reportRef: humanApprovedReportRef,
      },
      independentReviewer,
    );
    assert.equal(humanApprovedReview.outcome, "applied", JSON.stringify(humanApprovedReview));
    const humanApproved = await cell.run(consentAccept, owner);
    assert.equal(humanApproved.outcome, "applied", JSON.stringify(humanApproved));
    const humanApprovedConsent = (
      receiptJson(await cell.run({ kind: "decision-show", decisionId: humanApprovedDecisionId }, owner)).decision as {
        readonly judgmentConsents: readonly { readonly basis?: string }[];
      }
    ).judgmentConsents.at(-1);
    assert.equal(humanApprovedConsent?.basis, "human");
    const reportRef = `decisions/decision-${decisionId}/artifacts/reports/independent.md`;
    const samePrincipalReportRef = `decisions/decision-${decisionId}/artifacts/reports/same-principal.md`;
    writeReport(rootDir, samePrincipalReportRef);
    const samePrincipalReviewer = withPolicyGroup(
      {
        actor: {
          principal: proposer.actor.principal,
          executor: null,
        },
        source: "local" as const,
      },
      "admin",
    );
    const samePrincipalReview = await cell.run(
      {
        kind: "decision-review",
        decisionId,
        reviewId: "review-same-principal",
        reviewContentDigest: digest,
        verdict: "approved",
        reason: "A direct human still represents the proposal owner principal.",
        findings: [],
        evidenceChecked: [],
        reportRef: samePrincipalReportRef,
      },
      samePrincipalReviewer,
    );
    assert.deepEqual(
      { outcome: samePrincipalReview.outcome, code: samePrincipalReview.code },
      { outcome: "op_rejected", code: "actor_unauthorized" },
    );
    const missingReport = await cell.run(
      {
        kind: "decision-review",
        decisionId,
        reviewId: "review-independent",
        reviewContentDigest: digest,
        verdict: "approved",
        reason: "The current content and evidence support acceptance.",
        findings: [],
        evidenceChecked: [],
        reportRef,
      },
      independentReviewer,
    );
    assert.deepEqual(
      { outcome: missingReport.outcome, code: missingReport.code },
      { outcome: "op_rejected", code: "review_report_missing" },
    );
    assert.match(
      String(missingReport.rejectionExplanation),
      new RegExp(reportRef.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
    writeReport(rootDir, reportRef);
    const reviewed = await cell.run(
      {
        kind: "decision-review",
        decisionId,
        reviewId: "review-independent",
        reviewContentDigest: digest,
        verdict: "approved",
        reason: "The current content and evidence support acceptance.",
        findings: [],
        evidenceChecked: [],
        reportRef,
      },
      independentReviewer,
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    const reviewEvent = makeTaskEventReader({ repoId: "decision-review-independence", rootDir }).readEvent(
      reviewed.opId,
    );
    assert.ok(reviewEvent?.schema === "decision-event/v1" && reviewEvent.type === "decision_review_recorded");
    assert.equal(reviewEvent.payload.carriedDocumentClaims?.[0]?.path, reportRef);
    const report = await cell.run({ kind: "doc-show", path: reportRef }, independentReviewer);
    assert.equal(report.outcome, "applied", JSON.stringify(report));
    assert.match(String(report.evidence), /The current Decision cut was reviewed/u);
    const reviewedShow = receiptJson(await cell.run({ kind: "decision-show", decisionId }, owner)).decision as {
        readonly currentReviewContentDigest: unknown;
        readonly acceptReviewReadiness: unknown;
      },
      listed = (await cell.read("repo.decisions.list", { projection: "full" }, owner)).decisions.find(
        (row: { readonly decisionId: string }) => row.decisionId === decisionId,
      );
    assert.equal(reviewedShow.currentReviewContentDigest, digest);
    assert.notEqual(reviewedShow.acceptReviewReadiness, null);
    assert.deepEqual(
      { digest: listed?.currentReviewContentDigest, readiness: listed?.acceptReviewReadiness, body: listed?.body },
      { digest, readiness: reviewedShow.acceptReviewReadiness, body: null },
      "full list rows carry the same review cut and readiness as decision-show without returning the body",
    );
    const accepted = await cell.run(
      {
        kind: "decision-accept",
        decisionId,
        rationale: "An independent agent reviewed the proposal.",
        judgmentOnlyRationale: "Executor-axis independence is satisfied.",
        reviewId: "review-independent",
        expectedDigest: digest,
      },
      owner,
    );
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    const acceptedDecision = receiptJson(
      await cell.run({ kind: "decision-show", decisionId, includeBody: true }, owner),
    ).decision as { readonly acceptReviewReadiness: unknown };
    assert.equal(acceptedDecision.acceptReviewReadiness, null);
    const acceptedAgenda = await cell.read("repo.agenda.read", { limit: 50 }, owner);
    assert.deepEqual(acceptedAgenda.awaitingYou, []);
    assert.deepEqual(acceptedAgenda.answeredForYou, []);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Decision scope authorization and human approval govern judgment and review disposition", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-review-authority-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("decision-review-authority"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "decision-review-authority-test",
  });
  const other = withPolicyGroup(
      withPolicyGroup(
        {
          actor: {
            principal: { personId: "person-other" },
            executor: { kind: "agent" as const, id: "other-agent" },
          },
          source: "local" as const,
          authorizationBindingMode: "declared" as const,
        },
        "contributor",
      ),
      "maintainer",
    ),
    repoWriter = withPolicyGroup(
      {
        actor: {
          principal: { personId: "person-repo-writer" },
          executor: { kind: "agent" as const, id: "repo-writer-agent" },
        },
        source: "local" as const,
        authorizationBindingMode: "declared" as const,
      },
      "contributor",
    ),
    humanOwner = withPolicyGroup(
      {
        actor: { principal: other.actor.principal, executor: null },
        source: "local" as const,
        authorizationBindingMode: "declared" as const,
      },
      "maintainer",
    ),
    approval = {
      consentBy: other.actor.principal.personId,
      consentAt: "2026-09-28T01:02:03.000Z",
      consentChannel: "chat" as const,
    };
  try {
    const proposed = await cell.run(decisionProposal(), proposer),
      decisionId = receiptJson(proposed).decisionId as string,
      shown = receiptJson(await cell.run({ kind: "decision-show", decisionId, includeBody: true }, proposer))
        .decision as DecisionDocumentState & { readonly body: { readonly body: string } },
      { body, ...current } = shown,
      digest = decisionReviewContentDigest({ ...current, relations: [] }, body.body);
    const foreignAccept = await cell.run(
      {
        kind: "decision-accept",
        decisionId,
        rationale: "A different principal cannot accept without approval.",
        judgmentOnlyRationale: "No owner authority was supplied.",
      },
      other,
    );
    assert.deepEqual(
      { outcome: foreignAccept.outcome, code: foreignAccept.code },
      { outcome: "op_rejected", code: "actor_unauthorized" },
    );
    const foreignDefer = await cell.run(
      { kind: "decision-defer", decisionId, reason: "A different principal cannot defer without approval." },
      other,
    );
    assert.deepEqual(
      { outcome: foreignDefer.outcome, code: foreignDefer.code },
      { outcome: "op_rejected", code: "actor_unauthorized" },
    );
    const unqualifiedApproval = await cell.run(
      {
        kind: "decision-accept",
        decisionId,
        rationale: "Consent cannot grant a principal missing action authority.",
        judgmentOnlyRationale: "The principal has no action authority.",
        consentBy: repoWriter.actor.principal.personId,
        consentAt: approval.consentAt,
        consentChannel: approval.consentChannel,
      },
      { ...repoWriter, keycloakAuthorization: undefined },
    );
    assert.deepEqual(
      { outcome: unqualifiedApproval.outcome, code: unqualifiedApproval.code },
      { outcome: "op_rejected", code: "authorization_denied" },
    );
    const reviewer = withPolicyGroup(
      {
        actor: { principal: { personId: "person-reviewer" }, executor: null },
        source: "local" as const,
      },
      "admin",
    );
    const reportRef = `decisions/decision-${decisionId}/artifacts/reports/changes-requested.md`;
    writeReport(rootDir, reportRef);
    const reviewed = await cell.run(
      {
        kind: "decision-review",
        decisionId,
        reviewId: "review-changes-requested",
        reviewContentDigest: digest,
        verdict: "changes_requested",
        reason: "The proposal needs a named correction.",
        findings: [{ findingId: "finding-1", text: "Name the correction before acceptance." }],
        evidenceChecked: [],
        reportRef,
      },
      reviewer,
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    const secondReportRef = `decisions/decision-${decisionId}/artifacts/reports/changes-requested-2.md`;
    writeReport(rootDir, secondReportRef);
    const reviewedAgain = await cell.run(
      {
        kind: "decision-review",
        decisionId,
        reviewId: "review-changes-requested-2",
        reviewContentDigest: digest,
        verdict: "changes_requested",
        reason: "The proposal needs a second named correction.",
        findings: [{ findingId: "finding-2", text: "Name the second correction before acceptance." }],
        evidenceChecked: [],
        reportRef: secondReportRef,
      },
      reviewer,
    );
    assert.equal(reviewedAgain.outcome, "applied", JSON.stringify(reviewedAgain));
    const awaitsRelationId = deriveRelationId({
        source: `decision/${decisionId}`,
        target: `person/${proposer.actor.principal.personId}`,
        type: "awaits",
        direction: "directed",
      }),
      [firstAsk] = relationRows(await cell.run({ kind: "relation-list", entity: `decision/${decisionId}` }, proposer));
    assert.equal(firstAsk?.state, "active");
    assert.match(firstAsk?.rationale ?? "", /^consent: /u);
    assert.equal(
      decisionReviewContentDigest(
        {
          ...current,
          relations: [
            {
              relation_id: firstAsk!.relationId,
              source: firstAsk!.sourceRef,
              target: firstAsk!.targetRef,
              type: firstAsk!.relationType as "awaits",
              strength: firstAsk!.strength as "strong",
              direction: firstAsk!.direction as "directed",
              origin: firstAsk!.origin as "authored",
              state: firstAsk!.state as "active",
              rationale: firstAsk!.rationale,
            },
          ],
        },
        body.body,
      ),
      digest,
    );
    const blockedAgenda = await cell.read("repo.agenda.read", { limit: 50 }, proposer);
    assert.deepEqual(
      blockedAgenda.awaitingYou.map(({ sourceRef }: { readonly sourceRef: string }) => sourceRef),
      [`decision/${decisionId}`],
    );
    assert.equal(
      [...blockedAgenda.decisionReviewInProgress, ...blockedAgenda.awaitingDecision].some(
        (row: { readonly decisionId: string }) => row.decisionId === decisionId,
      ),
      false,
      "an unresolved changes_requested Decision is surfaced only through its awaits row",
    );
    const override = {
      kind: "decision-override-review" as const,
      decisionId,
      reviewContentDigest: digest,
      reviewIds: ["review-changes-requested"],
      reason: "The authenticated principal explicitly accepts the named disagreement.",
    };
    const agentOverride = await cell.run(override, other);
    assert.deepEqual(
      { outcome: agentOverride.outcome, code: agentOverride.code },
      { outcome: "op_rejected", code: "actor_unauthorized" },
    );
    const humanOverride = await cell.run(override, humanOwner);
    assert.equal(humanOverride.outcome, "applied", JSON.stringify(humanOverride));
    assert.equal(
      relationRows(await cell.run({ kind: "relation-list", entity: `decision/${decisionId}` }, proposer)).find(
        ({ relationId }) => relationId === awaitsRelationId,
      )?.state,
      "active",
    );
    const partiallyDisposedAgenda = await cell.read("repo.agenda.read", { limit: 50 }, proposer);
    assert.deepEqual(
      partiallyDisposedAgenda.awaitingYou.map(({ sourceRef }: { readonly sourceRef: string }) => sourceRef),
      [`decision/${decisionId}`],
    );
    const secondOverride = await cell.run({ ...override, reviewIds: ["review-changes-requested-2"] }, humanOwner);
    assert.equal(secondOverride.outcome, "applied", JSON.stringify(secondOverride));
    const disposedAgenda = await cell.read("repo.agenda.read", { limit: 50 }, proposer);
    assert.deepEqual(
      disposedAgenda.awaitingYou.map(({ sourceRef }: { readonly sourceRef: string }) => sourceRef),
      [`decision/${decisionId}`],
      "overrides dispose current blockers but do not replace the proposal owner's finding responses",
    );
    assert.deepEqual(disposedAgenda.answeredForYou, []);
    const approvedOverride = await cell.run(
      { ...override, reviewIds: ["review-changes-requested"], ...approval },
      other,
    );
    assert.equal(approvedOverride.outcome, "applied", JSON.stringify(approvedOverride));

    writeReport(rootDir, `decisions/decision-${decisionId}/artifacts/reports/changes-requested-again.md`);
    const secondReview = await cell.run(
      {
        kind: "decision-review",
        decisionId,
        reviewId: "review-changes-requested-again",
        reviewContentDigest: digest,
        verdict: "changes_requested",
        reason: "A later review identified another correction.",
        findings: [{ findingId: "finding-2", text: "Address the later correction." }],
        evidenceChecked: [],
        reportRef: `decisions/decision-${decisionId}/artifacts/reports/changes-requested-again.md`,
      },
      reviewer,
    );
    assert.equal(secondReview.outcome, "applied", JSON.stringify(secondReview));
    assert.equal(
      relationRows(await cell.run({ kind: "relation-list", entity: `decision/${decisionId}` }, proposer)).find(
        ({ relationId }) => relationId === awaitsRelationId,
      )?.state,
      "active",
    );
    assert.deepEqual(
      (await cell.read("repo.agenda.read", { limit: 50 }, proposer)).awaitingYou.map(
        ({ sourceRef }: { readonly sourceRef: string }) => sourceRef,
      ),
      [`decision/${decisionId}`],
    );
    const amended = await cell.run(
      {
        kind: "decision-amend",
        decisionId,
        standingPolicy: false,
        fulfillments: [],
        sets: [],
        appends: [],
        body: realizedDecisionBody("Review independence amended"),
      },
      proposer,
    );
    assert.equal(amended.outcome, "applied", JSON.stringify(amended));
    assert.equal(
      relationRows(await cell.run({ kind: "relation-list", entity: `decision/${decisionId}` }, proposer)).find(
        ({ relationId }) => relationId === awaitsRelationId,
      )?.state,
      "active",
    );
    const amendedDecision = receiptJson(
      await cell.run({ kind: "decision-show", decisionId, includeBody: true }, proposer),
    ).decision as { readonly currentReviewContentDigest: `sha256:${string}` };
    const unansweredAgenda = await cell.read("repo.agenda.read", { limit: 50 }, proposer);
    assert.deepEqual(
      unansweredAgenda.awaitingYou.map(({ sourceRef }: { readonly sourceRef: string }) => sourceRef),
      [`decision/${decisionId}`],
      "historical unanswered findings remain visible through the awaits row after a new content cut",
    );
    const requirementUpdated = await cell.run(
      {
        kind: "settings-update",
        decisionReviewRequirement: "high",
        idempotencyKey: "require-review-before-responses",
      },
      withPolicyGroup(
        { actor: { principal: proposer.actor.principal, executor: null }, source: "local" as const },
        "contributor",
      ),
    );
    assert.equal(requirementUpdated.outcome, "applied", JSON.stringify(requirementUpdated));
    const responded = await cell.run(
      {
        kind: "decision-respond-review",
        decisionId,
        responses: [
          {
            reviewId: "review-changes-requested",
            findingId: "finding-1",
            disposition: "adopt",
            rationale: "The amended content names the first correction.",
            amendmentRef: "decision-amend:Review independence amended",
          },
          {
            reviewId: "review-changes-requested-2",
            findingId: "finding-2",
            disposition: "rebut",
            rationale: "The second request conflicts with the chosen tradeoff.",
            amendmentRef: null,
          },
          {
            reviewId: "review-changes-requested-again",
            findingId: "finding-2",
            disposition: "adopt",
            rationale: "The amended content addresses the later correction.",
            amendmentRef: "decision-amend:Review independence amended",
          },
        ],
      },
      proposer,
    );
    assert.equal(responded.outcome, "applied", JSON.stringify(responded));
    assert.equal(
      relationRows(await cell.run({ kind: "relation-list", entity: `decision/${decisionId}` }, proposer)).find(
        ({ relationId }) => relationId === awaitsRelationId,
      )?.state,
      "retired",
      "under a high requirement the answered cut now awaits review, which is not an owner-response blocker",
    );
    assert.deepEqual((await cell.read("repo.agenda.read", { limit: 50 }, proposer)).awaitingYou, []);
    const reviewRequiredAgenda = await cell.read("repo.agenda.read", { limit: 50 }, proposer);
    assert.deepEqual(
      reviewRequiredAgenda.awaitingDecisionReview.map(
        ({ decisionId: queuedId }: { readonly decisionId: string }) => queuedId,
      ),
      [decisionId],
      "a high-risk cut with all historical findings answered is queued for review",
    );
    assert.deepEqual(
      reviewRequiredAgenda.awaitingYou,
      [],
      "review_required is not an owner-response blocker and must not create an awaits edge",
    );
    writeReport(rootDir, `decisions/decision-${decisionId}/artifacts/reports/amended-cut.md`);
    const newCutReview = await cell.run(
      {
        kind: "decision-review",
        decisionId,
        reviewId: "review-amended-cut",
        reviewContentDigest: amendedDecision.currentReviewContentDigest,
        verdict: "changes_requested",
        reason: "The amended cut has a new correction.",
        findings: [{ findingId: "finding-amended", text: "Address the amended-cut correction." }],
        evidenceChecked: [],
        reportRef: `decisions/decision-${decisionId}/artifacts/reports/amended-cut.md`,
      },
      reviewer,
    );
    assert.equal(newCutReview.outcome, "applied", JSON.stringify(newCutReview));
    const rejected = await cell.run(
      { kind: "decision-reject", decisionId, reason: "The owner rejects the amended proposal." },
      humanOwner,
    );
    assert.equal(rejected.outcome, "applied", JSON.stringify(rejected));
    const rejectedAgenda = await cell.read("repo.agenda.read", { limit: 50 }, proposer);
    assert.deepEqual(rejectedAgenda.awaitingYou, []);
    assert.deepEqual(rejectedAgenda.answeredForYou, []);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Human approval preserves the proposing executor and survives a cold read", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-human-consent-"));
  initRepo(rootDir);
  const options = {
    repoId: workspaceId("human-consent"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "human-consent-test",
  };
  let cell = await openRepoCell(options);
  const binding = withPolicyGroup(proposer, "maintainer"),
    consentAt = "2026-09-12T01:02:03.000Z";
  const eventIds: string[] = [];
  try {
    for (const [variant, adjudication] of [
      [
        "accept",
        (decisionId: string) =>
          ({
            kind: "decision-accept",
            decisionId,
            rationale: "The principal explicitly approved this outcome in chat.",
            judgmentOnlyRationale: "The principal explicitly approved this outcome in chat.",
          }) as const,
      ] as const,
      [
        "reject",
        (decisionId: string) =>
          ({ kind: "decision-reject", decisionId, reason: "The principal explicitly rejected this outcome." }) as const,
      ] as const,
    ]) {
      // The body varies per variant so each iteration proposes a distinct Decision instead of
      // replaying the identical prior action digest onto the already-adjudicated document.
      const proposal = await cell.run(
          { ...decisionProposal(), body: realizedDecisionBody(`Human consent ${variant}`) },
          proposer,
        ),
        decisionId = receiptJson(proposal).decisionId as string,
        action = adjudication(decisionId),
        approval = { consentBy: proposer.actor.principal.personId, consentAt, consentChannel: "chat" };
      for (const invalid of [
        { ...approval, consentBy: "another-person" },
        { ...approval, consentBy: proposer.actor.executor.id },
        { ...approval, consentAt: "not-a-time" },
        { ...approval, consentChannel: "email" },
        { consentBy: approval.consentBy },
      ]) {
        const result = await cell.run({ ...action, ...invalid }, binding);
        assert.equal(result.outcome, "op_rejected", JSON.stringify(result));
      }
      const accepted = await cell.run({ ...action, ...approval }, binding);
      assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
      eventIds.push(accepted.opId);
      const event = makeTaskEventReader({ repoId: "human-consent", rootDir }).readEvent(accepted.opId);
      assert.ok(
        event?.schema === "decision-event/v1" &&
          (event.type === "decision_accepted" || event.type === "decision_rejected"),
      );
      assert.deepEqual(event.actor, proposer.actor);
      const consent = event.payload.judgmentConsent;
      assert.deepEqual(
        { approvedBy: consent.approvedBy, recordedBy: consent.recordedBy, at: consent.at, channel: consent.channel },
        { approvedBy: approval.consentBy, recordedBy: proposer.actor.executor, at: consentAt, channel: "chat" },
      );
      assert.doesNotThrow(() => serializeCanonicalEvent(event));
      for (const patch of [{ recordedBy: null }, { approvedBy: "another-person" }, { at: "bad" }, { channel: "email" }])
        assert.throws(() =>
          serializeCanonicalEvent({
            ...event,
            payload: { ...event.payload, judgmentConsent: { ...consent, ...patch } },
          }),
        );
      const again = await cell.run({ ...action, ...approval }, binding);
      assert.equal(again.outcome, "applied", JSON.stringify(again));
      assert.equal(again.opId, accepted.opId);
      assert.equal(again.revision, accepted.revision);
      const conflicting = await cell.run(
        action.kind === "decision-accept"
          ? { kind: "decision-reject", decisionId, reason: "The opposite adjudication must not land." }
          : {
              kind: "decision-accept",
              decisionId,
              rationale: "The opposite adjudication must not land.",
              judgmentOnlyRationale: "The opposite adjudication must not land.",
            },
        binding,
      );
      assert.equal(conflicting.outcome, "op_rejected", JSON.stringify(conflicting));
    }
    await cell.close();
    cell = await openRepoCell(options);
    for (const opId of eventIds) {
      const event = makeTaskEventReader({ repoId: "human-consent", rootDir }).readEvent(opId);
      assert.ok(
        event?.schema === "decision-event/v1" &&
          (event.type === "decision_accepted" || event.type === "decision_rejected"),
      );
      assert.deepEqual(event.payload.judgmentConsent.recordedBy, proposer.actor.executor);
      assert.equal(event.payload.judgmentConsent.at, consentAt);
      assert.doesNotThrow(() => serializeCanonicalEvent(event));
    }
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a direct human can adjudicate without recording a separate approval", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-direct-human-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
      repoId: workspaceId("direct-human-adjudication"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "direct-human-adjudication-test",
    }),
    human = withPolicyGroup(
      { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" as const },
      "admin",
    );
  try {
    for (const [variant, action] of [
      [
        "accept",
        (decisionId: string) => ({
          kind: "decision-accept" as const,
          decisionId,
          rationale: "The authenticated human accepts directly.",
          judgmentOnlyRationale: "Direct human judgment needs no separate consent record.",
        }),
      ],
      [
        "reject",
        (decisionId: string) => ({
          kind: "decision-reject" as const,
          decisionId,
          reason: "The authenticated human rejects directly.",
        }),
      ],
      [
        "defer",
        (decisionId: string) => ({
          kind: "decision-defer" as const,
          decisionId,
          reason: "The authenticated human defers directly.",
        }),
      ],
    ] as const) {
      const proposed = await cell.run(
          { ...decisionProposal(), body: realizedDecisionBody(`Direct human ${variant}`) },
          proposer,
        ),
        decisionId = receiptJson(proposed).decisionId as string,
        result = await cell.run(action(decisionId), human);
      assert.equal(result.outcome, "applied", JSON.stringify(result));
      const event = makeTaskEventReader({ repoId: "direct-human-adjudication", rootDir }).readEvent(result.opId);
      assert.ok(
        event?.schema === "decision-event/v1" &&
          (event.type === "decision_accepted" ||
            event.type === "decision_rejected" ||
            event.type === "decision_deferred"),
      );
      assert.equal(event.payload.judgmentConsent.approvedBy, undefined);
      assert.equal(event.payload.judgmentConsent.recordedBy, undefined);
    }
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("retry completes the awaits write after the review write response is interrupted", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-review-awaits-retry-"));
  initRepo(rootDir);
  let armed = false;
  const cell = await openRepoCell({
    repoId: workspaceId("decision-review-awaits-retry"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "decision-review-awaits-retry-test",
    killpoint: (point) => {
      if (armed && point === "before_response_write") {
        armed = false;
        throw new Error("interrupt after review publication");
      }
    },
  });
  try {
    const proposed = await cell.run(decisionProposal(), proposer),
      decisionId = receiptJson(proposed).decisionId as string,
      shown = receiptJson(await cell.run({ kind: "decision-show", decisionId, includeBody: true }, proposer))
        .decision as DecisionDocumentState & { readonly body: { readonly body: string } },
      { body, ...current } = shown,
      digest = decisionReviewContentDigest({ ...current, relations: [] }, body.body),
      reviewer = withPolicyGroup(
        { actor: { principal: { personId: "person-reviewer" }, executor: null }, source: "local" as const },
        "admin",
      ),
      action = {
        kind: "decision-review" as const,
        decisionId,
        reviewId: "review-retry",
        reviewContentDigest: digest,
        verdict: "changes_requested" as const,
        reason: "Retry must finish the notification write.",
        findings: [{ findingId: "finding-retry", text: "Complete the interrupted notification." }],
        evidenceChecked: [],
        reportRef: `decisions/decision-${decisionId}/artifacts/reports/retry.md`,
      };
    writeReport(rootDir, action.reportRef);
    armed = true;
    const interrupted = await cell.run(action, reviewer);
    assert.equal(interrupted.code, "publication_indeterminate", JSON.stringify(interrupted));
    assert.deepEqual(
      relationRows(await cell.run({ kind: "relation-list", entity: `decision/${decisionId}` }, proposer)),
      [],
    );

    const retried = await cell.run(action, reviewer);
    assert.equal(retried.outcome, "applied", JSON.stringify(retried));
    assert.equal(
      relationRows(await cell.run({ kind: "relation-list", entity: `decision/${decisionId}` }, proposer))[0]?.state,
      "active",
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the in-progress agenda row names each running reviewer and the findings its review recorded", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-review-in-progress-")),
    repoId = workspaceId("decision-review-in-progress");
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId,
    rootDir: canonicalRoot(rootDir),
    ownerId: "decision-review-in-progress-test",
  });
  try {
    const settingsUpdated = await cell.run(
      { kind: "settings-update", decisionReviewRequirement: "high", idempotencyKey: "decision-review-in-progress" },
      withPolicyGroup(
        { actor: { principal: proposer.actor.principal, executor: null }, source: "local" as const },
        "contributor",
      ),
    );
    assert.equal(settingsUpdated.outcome, "applied", JSON.stringify(settingsUpdated));
    const decisionId = receiptJson(await cell.run(decisionProposal(), proposer)).decisionId as string,
      digest = (
        receiptJson(await cell.run({ kind: "decision-show", decisionId, includeBody: true }, proposer)).decision as {
          readonly currentReviewContentDigest: `sha256:${string}`;
        }
      ).currentReviewContentDigest;
    const reviewers = await Promise.all(
      (
        [
          ["decision-review-a", "reviewer-a", "独立评审甲"],
          ["decision-review-b", "reviewer-b", undefined],
        ] as const
      ).map(async ([idempotencyKey, agentId, agentName]) => {
        const hash = createHash("sha256").update(`${repoId}\0${idempotencyKey}`).digest("hex"),
          dispatchId = `dispatch_${hash.slice(0, 24)}`,
          runtimeSessionId = `runtime_${hash.slice(24, 48)}`;
        const ingress = await cell.runtimeIngress(
          {
            kind: "event",
            type: "runtime_dispatch_requested",
            opId: `runtime-spawn-${hash.slice(0, 32)}`,
            payload: {
              dispatchId,
              runtimeSessionId,
              instanceId: "instance-1",
              installationId: "installation-1",
              kindId: "codex",
              idempotencyKey,
              definitionSnapshotRef: `artifact:runtime-definition/${agentId}`,
              definitionSnapshot: {
                schema: "agent-definition-snapshot/v1",
                configVersion: 1,
                instanceId: "instance-1",
                installationId: "installation-1",
                kindId: "codex",
                providerId: "openai",
                model: "review-model",
                reasoningEffort: null,
                baseUrl: null,
                authMode: "subscription",
              },
              reviewTarget: { kind: "decision", decisionId, digest },
              agentId,
              ...(agentName ? { agentName } : {}),
            },
          },
          proposer,
        );
        assert.equal(ingress.outcome, "applied", JSON.stringify(ingress));
        openDispatchStream(rootDir, {
          dispatchId,
          taskId: null,
          executionId: null,
          reviewTarget: { kind: "decision", decisionId, digest },
          runtimeSessionId,
          instanceId: "instance-1",
          startedAt: "2026-09-29T00:00:00.000Z",
          agentId,
          ...(agentName ? { agentName } : {}),
        });
        appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: process.pid });
        return { dispatchId, reviewer: agentName ?? agentId };
      }),
    );
    const reviewersOf = async () =>
      (await cell.read("repo.agenda.read", { limit: 50 }, proposer)).decisionReviewInProgress.map(
        (row: { readonly decisionId: string; readonly reviewers: unknown }) => [row.decisionId, row.reviewers],
      );
    assert.deepEqual(await reviewersOf(), [
      [
        decisionId,
        [
          { ...reviewers[0], findingCount: null },
          { ...reviewers[1], findingCount: null },
        ],
      ],
    ]);
    const reportRef = `decisions/decision-${decisionId}/artifacts/reports/${reviewers[0]!.dispatchId}.md`;
    writeReport(rootDir, reportRef);
    const reviewed = await cell.run(
      {
        kind: "decision-review",
        decisionId,
        reviewId: `review-${reviewers[0]!.dispatchId}`,
        reviewContentDigest: digest,
        verdict: "approved",
        reason: "The current cut is acceptable.",
        findings: [],
        evidenceChecked: [],
        reportRef,
      },
      withPolicyGroup(
        { actor: { principal: { personId: "person-reviewer" }, executor: null }, source: "local" as const },
        "admin",
      ),
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    assert.deepEqual(
      await reviewersOf(),
      [
        [
          decisionId,
          [
            { ...reviewers[0], findingCount: 0 },
            { ...reviewers[1], findingCount: null },
          ],
        ],
      ],
      "a recorded review reports its finding count; a reviewer still running reports none yet",
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a person's ask on the proposal owner survives the review changes being resolved", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-review-awaits-owned-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("decision-review-awaits-owned"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "decision-review-awaits-owned-test",
  });
  try {
    const decisionId = receiptJson(await cell.run(decisionProposal(), proposer)).decisionId as string,
      asked = await cell.run(
        {
          kind: "relation-relate",
          sourceRef: `decision/${decisionId}`,
          targetRef: `person/${proposer.actor.principal.personId}`,
          relationType: "awaits",
          rationale: "consent: Do you agree with this proposal?",
          expectedVersion: 0,
        },
        proposer,
      );
    assert.equal(asked.outcome, "applied", JSON.stringify(asked));
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "harness", "people.yaml"),
      JSON.stringify({
        schema: "harness-people/v1",
        people: [{ personId: "person-not-in-keycloak", roles: ["owner"] }],
      }),
    );
    const beforeUnknownPerson = makeTaskEventReader({ repoId: "decision-review-awaits-owned", rootDir }).readHead()
        .revision,
      unknownPerson = await cell.run(
        {
          kind: "relation-relate",
          sourceRef: `decision/${decisionId}`,
          targetRef: "person/person-not-in-keycloak",
          relationType: "awaits",
          rationale: "consent: This synthetic roster entry is not an identity.",
          expectedVersion: 0,
        },
        proposer,
      );
    assert.deepEqual(
      { outcome: unknownPerson.outcome, code: unknownPerson.code },
      {
        outcome: "op_rejected",
        code: "entity_not_found",
      },
    );
    assert.equal(
      makeTaskEventReader({ repoId: "decision-review-awaits-owned", rootDir }).readHead()?.revision,
      beforeUnknownPerson,
      "a retired people.yaml entry cannot create an identity witness or publish a relation",
    );
    const shown = receiptJson(await cell.run({ kind: "decision-show", decisionId, includeBody: true }, proposer))
        .decision as { readonly currentReviewContentDigest: `sha256:${string}` },
      reportRef = `decisions/decision-${decisionId}/artifacts/reports/changes-requested.md`;
    writeReport(rootDir, reportRef);
    const reviewed = await cell.run(
      {
        kind: "decision-review",
        decisionId,
        reviewId: "review-changes-requested",
        reviewContentDigest: shown.currentReviewContentDigest,
        verdict: "changes_requested",
        reason: "The proposal needs a correction.",
        findings: [{ findingId: "finding-1", text: "Name the correction before acceptance." }],
        evidenceChecked: [],
        reportRef,
      },
      withPolicyGroup(
        { actor: { principal: { personId: "person-reviewer" }, executor: null }, source: "local" as const },
        "admin",
      ),
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    const amended = await cell.run(
      {
        kind: "decision-amend",
        decisionId,
        standingPolicy: false,
        fulfillments: [],
        sets: [],
        appends: [],
        body: realizedDecisionBody("Review independence amended"),
      },
      proposer,
    );
    assert.equal(amended.outcome, "applied", JSON.stringify(amended));
    const ask = relationRows(
      await cell.run({ kind: "relation-list", entity: `decision/${decisionId}` }, proposer),
    ).find(({ relationType }) => relationType === "awaits");
    assert.deepEqual(
      { state: ask?.state, rationale: ask?.rationale },
      { state: "active", rationale: "consent: Do you agree with this proposal?" },
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function decisionProposal() {
  return {
    kind: "decision-propose",
    body: realizedDecisionBody("Review independence"),
    jsonInput: JSON.stringify({
      title: "Review independence",
      question: "Should a separate agent review this proposal?",
      riskTier: "high",
      urgency: "high",
      vertical: "software/coding",
      preset: "standard-task",
      decisionClass: "ordinary",
      appliesTo: { modules: ["daemon"], productLines: [] },
      chosen: [{ id: "CH1", text: "Require independent review" }],
      rejected: [{ id: "RJ1", text: "Allow self-review", whyNot: "It lacks executor-axis independence" }],
      claims: [{ id: "C1", text: "The reviewer is independent.", loadBearing: true }],
      fulfillments: [],
    }),
  } as const;
}

function receiptJson(receipt: { readonly evidence?: string }): Record<string, unknown> {
  return JSON.parse(String(receipt.evidence)) as Record<string, unknown>;
}

function writeReport(rootDir: string, reportRef: string): void {
  const target = path.join(rootDir, "harness", ...reportRef.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "# Independent review\n\nThe current Decision cut was reviewed.\n");
}

function relationRows(receipt: { readonly evidence?: string }) {
  return (
    JSON.parse(String(receipt.evidence)) as {
      readonly rows: readonly {
        readonly relationId: string;
        readonly sourceRef: string;
        readonly targetRef: string;
        readonly relationType: string;
        readonly strength: string;
        readonly direction: string;
        readonly origin: string;
        readonly state: string;
        readonly rationale: string;
      }[];
    }
  ).rows;
}

function initRepo(rootDir: string): void {
  execFileSync("git", ["-C", rootDir, "init", "-q"]);
  execFileSync("git", ["-C", rootDir, "config", "user.name", "Decision Review Test"]);
  execFileSync("git", ["-C", rootDir, "config", "user.email", "decision-review@example.invalid"]);
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    "layout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings:\n  reviewIndependence: execution\n",
  );
  execFileSync("git", ["-C", rootDir, "add", "."]);
  execFileSync("git", ["-C", rootDir, "commit", "-qm", "base"]);
}
