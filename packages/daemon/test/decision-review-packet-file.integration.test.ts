// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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
const reviewer = withPolicyGroup(
  { actor: { principal: { personId: "person-reviewer" }, executor: null }, source: "local" as const },
  "admin",
);
const owner = withPolicyGroup({ ...proposer, actor: { ...proposer.actor, executor: null } }, "admin");

test("respond-review and override-review read their packet from --from-file like review does", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-review-packet-file-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("decision-review-packet-file"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "decision-review-packet-file-test",
  });
  try {
    const proposed = await cell.run(decisionProposal(), proposer),
      decisionId = receiptJson(proposed).decisionId as string,
      digest = (
        receiptJson(await cell.run({ kind: "decision-show", decisionId }, owner)).decision as {
          readonly currentReviewContentDigest: `sha256:${string}`;
        }
      ).currentReviewContentDigest;
    const reportRef = `decisions/decision-${decisionId}/artifacts/reports/changes.md`;
    writePackage(rootDir, reportRef, "# Review\n\nOne finding.\n");
    const reviewed = await cell.run(
      {
        kind: "decision-review",
        decisionId,
        reviewId: "review-changes",
        reviewContentDigest: digest,
        verdict: "changes_requested",
        reason: "The claim lacks evidence.",
        findings: [{ findingId: "F1", text: "Claim C1 has no evidence." }],
        evidenceChecked: [],
        reportRef,
      },
      reviewer,
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));

    writePackage(
      rootDir,
      "harness/tmp/respond.json",
      JSON.stringify({
        responses: [
          {
            reviewId: "review-changes",
            findingId: "F1",
            disposition: "rebut",
            rationale: "The evidence lands in a follow-up.",
            amendmentRef: null,
          },
        ],
      }),
    );
    const responded = await cell.run(
      { kind: "decision-respond-review", decisionId, fromFile: "harness/tmp/respond.json" },
      proposer,
    );
    assert.equal(responded.outcome, "applied", JSON.stringify(responded));

    writePackage(
      rootDir,
      "harness/tmp/override.json",
      JSON.stringify({ reviewContentDigest: digest, reviewIds: ["review-changes"], reason: "Owner accepts the risk." }),
    );
    const overridden = await cell.run(
      { kind: "decision-override-review", decisionId, fromFile: "harness/tmp/override.json" },
      owner,
    );
    assert.equal(overridden.outcome, "applied", JSON.stringify(overridden));
  } finally {
    await cell.close();
  }
});

function decisionProposal() {
  return {
    kind: "decision-propose",
    body: realizedDecisionBody("Review packet file"),
    jsonInput: JSON.stringify({
      title: "Review packet file",
      question: "Do review follow-up commands read their packet file?",
      riskTier: "high",
      urgency: "high",
      vertical: "software/coding",
      preset: "standard-task",
      decisionClass: "ordinary",
      appliesTo: { modules: ["daemon"], productLines: [] },
      chosen: [{ id: "CH1", text: "Read the packet file" }],
      rejected: [{ id: "RJ1", text: "Ignore the file", whyNot: "The command receives an empty payload" }],
      claims: [{ id: "C1", text: "The file is read.", loadBearing: true }],
      fulfillments: [],
    }),
  } as const;
}

function receiptJson(receipt: { readonly evidence?: string }): Record<string, unknown> {
  return JSON.parse(String(receipt.evidence)) as Record<string, unknown>;
}

function writePackage(rootDir: string, ref: string, content: string): void {
  const target = ref.startsWith("harness/")
    ? path.join(rootDir, ref)
    : path.join(rootDir, "harness", ...ref.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function initRepo(rootDir: string): void {
  execFileSync("git", ["-C", rootDir, "init", "-q"]);
  execFileSync("git", ["-C", rootDir, "config", "user.name", "Decision Review Test"]);
  execFileSync("git", ["-C", rootDir, "config", "user.email", "decision-review@example.invalid"]);
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    "layout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings:\n  reviewIndependence: execution\n  decisionReviewRequirement: high\n",
  );
  execFileSync("git", ["-C", rootDir, "add", "."]);
  execFileSync("git", ["-C", rootDir, "commit", "-qm", "base"]);
}
