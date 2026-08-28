// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { realizedDecisionBody } from "../../../tools/fixtures/task-plan.mjs";

const proposer = {
  actor: {
    principal: { personId: "person-proposer" },
    executor: { kind: "agent" as const, id: "proposer-agent" },
  },
  source: "local" as const,
};

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
    assert.equal(denied.nextAction, "An agent cannot judge its own Decision proposal; use an independent reviewer.");
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
      relations: [],
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
