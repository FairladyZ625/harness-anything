// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  decisionReviewContentDigest,
  makeTaskEventReader,
  serializeCanonicalEvent,
  type DecisionDocumentState,
} from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { realizedDecisionBody } from "../../../tools/fixtures/task-plan.mjs";

const proposer = withRoleBinding(
  {
    actor: {
      principal: { personId: "person-proposer" },
      executor: { kind: "agent" as const, id: "proposer-agent" },
    },
    source: "local" as const,
    authorizationBindingMode: "declared" as const,
  },
  "repo-write",
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
    const proposed = await cell.run(decisionProposal(), proposer),
      decisionId = receiptJson(proposed).decisionId as string,
      owner = withRoleBinding(proposer, "repo-write"),
      independentAgent = withRoleBinding(
        {
          actor: {
            principal: proposer.actor.principal,
            executor: { kind: "agent" as const, id: "independent-reviewer" },
          },
          source: "local" as const,
        },
        "arbiter",
      );
    const shown = receiptJson(await cell.run({ kind: "decision-show", decisionId, includeBody: true }, owner))
        .decision as DecisionDocumentState & { readonly body: { readonly body: string } },
      { body, ...current } = shown,
      digest = decisionReviewContentDigest({ ...current, relations: [] }, body.body),
      unreviewed = await cell.run(
        {
          kind: "decision-accept",
          decisionId,
          rationale: "The high-risk Decision needs an independent review.",
          judgmentOnlyRationale: "No review was selected.",
          reviewId: "missing-review",
          expectedDigest: digest,
        },
        owner,
      );
    assert.deepEqual(
      { outcome: unreviewed.outcome, code: unreviewed.code },
      { outcome: "op_rejected", code: "invalid_transition" },
    );
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
        reportRef: null,
      },
      independentAgent,
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
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
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Decision judgment and review disposition stay with the proposal owner or explicit human approval", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-review-authority-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("decision-review-authority"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "decision-review-authority-test",
  });
  const other = withRoleBinding(
      withRoleBinding(
        {
          actor: {
            principal: { personId: "person-other" },
            executor: { kind: "agent" as const, id: "other-agent" },
          },
          source: "local" as const,
          authorizationBindingMode: "declared" as const,
        },
        "repo-write",
      ),
      "arbiter",
    ),
    repoWriter = withRoleBinding(
      {
        actor: {
          principal: { personId: "person-repo-writer" },
          executor: { kind: "agent" as const, id: "repo-writer-agent" },
        },
        source: "local" as const,
        authorizationBindingMode: "declared" as const,
      },
      "repo-write",
    ),
    humanOwner = withRoleBinding(
      {
        actor: { principal: other.actor.principal, executor: null },
        source: "local" as const,
        authorizationBindingMode: "declared" as const,
      },
      "arbiter",
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
        rationale: "Consent cannot grant a principal arbiter qualification.",
        judgmentOnlyRationale: "The principal has repo-write authority only.",
        consentBy: repoWriter.actor.principal.personId,
        consentAt: approval.consentAt,
        consentChannel: approval.consentChannel,
      },
      repoWriter,
    );
    assert.deepEqual(
      { outcome: unqualifiedApproval.outcome, code: unqualifiedApproval.code },
      { outcome: "op_rejected", code: "actor_unauthorized" },
    );
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
        reportRef: null,
      },
      withRoleBinding(
        {
          actor: {
            principal: proposer.actor.principal,
            executor: { kind: "agent" as const, id: "independent-reviewer" },
          },
          source: "local" as const,
        },
        "arbiter",
      ),
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
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
    const approvedOverride = await cell.run(
      { ...override, reviewIds: ["review-changes-requested"], ...approval },
      other,
    );
    assert.equal(approvedOverride.outcome, "applied", JSON.stringify(approvedOverride));
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
  const binding = withRoleBinding(proposer, "arbiter"),
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
    human = withRoleBinding(
      { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" as const },
      "arbiter",
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

function decisionProposal() {
  return {
    kind: "decision-propose",
    body: realizedDecisionBody("Review independence"),
    jsonInput: JSON.stringify({
      title: "Review independence",
      question: "Should a separate agent review this proposal?",
      riskTier: "medium",
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

function initRepo(rootDir: string): void {
  execFileSync("git", ["-C", rootDir, "init", "-q"]);
  execFileSync("git", ["-C", rootDir, "config", "user.name", "Decision Review Test"]);
  execFileSync("git", ["-C", rootDir, "config", "user.email", "decision-review@example.invalid"]);
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    "layout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  execFileSync("git", ["-C", rootDir, "add", "."]);
  execFileSync("git", ["-C", rootDir, "commit", "-qm", "base"]);
}
