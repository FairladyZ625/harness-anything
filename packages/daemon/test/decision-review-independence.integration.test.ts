// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, serializeCanonicalEvent } from "../../kernel/src/index.ts";
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
  },
  "repo-write",
);

test("Decision outcomes reject self-judgment and accept an independent reviewer", async () => {
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
      sameAgent = withRoleBinding(proposer, "arbiter"),
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
    const denied = await cell.run(
      {
        kind: "decision-accept",
        decisionId,
        rationale: "The proposer must not accept its own proposal.",
        judgmentOnlyRationale: "Self-review is intentionally rejected.",
      },
      sameAgent,
    );
    assert.deepEqual(
      { outcome: denied.outcome, code: denied.code },
      { outcome: "op_rejected", code: "actor_unauthorized" },
    );
    const accepted = await cell.run(
      {
        kind: "decision-accept",
        decisionId,
        rationale: "An independent agent reviewed the proposal.",
        judgmentOnlyRationale: "Executor-axis independence is satisfied.",
      },
      independentAgent,
    );
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
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
    for (const targetState of ["in_effect", "rejected"] as const) {
      const proposal = await cell.run({ ...decisionProposal(), body: realizedDecisionBody(targetState) }, proposer),
        decisionId = receiptJson(proposal).decisionId as string,
        transition = {
          kind: "decision-transition",
          decisionId,
          targetState,
          judgmentOnlyRationale: "The principal explicitly approved this outcome in chat.",
          fulfillments: [],
          standingPolicy: false,
        },
        approval = { consentBy: proposer.actor.principal.personId, consentAt, consentChannel: "chat" };
      const denied = await cell.run(transition, binding);
      assert.equal(denied.code, "actor_unauthorized", JSON.stringify(denied));
      for (const invalid of [
        { ...approval, consentBy: "another-person" },
        { ...approval, consentBy: proposer.actor.executor.id },
        { ...approval, consentAt: "not-a-time" },
        { ...approval, consentChannel: "email" },
        { consentBy: approval.consentBy },
      ]) {
        const result = await cell.run({ ...transition, ...invalid }, binding);
        assert.equal(result.outcome, "op_rejected", JSON.stringify(result));
      }
      const accepted = await cell.run({ ...transition, ...approval }, binding);
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
      const again = await cell.run({ ...transition, ...approval }, binding);
      assert.equal(again.outcome, "applied", JSON.stringify(again));
      assert.equal(again.opId, accepted.opId);
      assert.equal(again.revision, accepted.revision);
      const conflicting = await cell.run(
        { ...transition, ...approval, targetState: targetState === "in_effect" ? "rejected" : "in_effect" },
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
