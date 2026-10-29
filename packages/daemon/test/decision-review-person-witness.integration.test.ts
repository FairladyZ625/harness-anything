// harness-test-tier: integration
import assert from "node:assert/strict";
import { removeTempStoreRoot } from "../../kernel/test/store/helpers.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { realizedDecisionBody } from "../../../tools/fixtures/task-plan.mjs";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { resolveRepoBootstrap } from "../src/repo-bootstrap.ts";
import { openFencedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";

const auth = {
  transportKind: "unix-socket",
  unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0, source: "unix-socket-filesystem-owner-boundary" },
} as unknown as DaemonAuthenticationContext;

// The production shape after the Keycloak migration: the projection carries no person entities, so
// an awaits edge can only target a person through the binding's identity witness.
const ownerBinding = (personId: string, executorId: string) =>
    withPolicyGroup(
      {
        actor: { principal: { personId }, executor: { kind: "agent" as const, id: executorId } },
        source: "local" as const,
        authorizationBindingMode: "declared" as const,
      },
      "admin",
    ),
  reviewerBinding = (personId: string) =>
    withPolicyGroup({ actor: { principal: { personId }, executor: null }, source: "local" as const }, "maintainer");

interface ReviewStage {
  readonly cell: Awaited<ReturnType<typeof openRepoCell>>;
  readonly authority: ReturnType<typeof openPersistentWriterEpoch>;
  readonly owner: ReturnType<typeof ownerBinding>;
  readonly reviewer: ReturnType<typeof reviewerBinding>;
  readonly decisionId: string;
  readonly rootDir: string;
}

async function stageDecision(reviewId: string): Promise<ReviewStage> {
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-decision-person-witness-"))),
    repoId = workspaceId(`decision-person-witness-${reviewId}`),
    stateRoot = path.join(rootDir, "writer-epochs"),
    authority = openPersistentWriterEpoch({ stateRoot, holderId: "decision-person-witness-test" }),
    lease = authority.acquire(repoId),
    owner = ownerBinding("person-owner", "owner-agent"),
    reviewer = reviewerBinding("person-reviewer");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    execFileSync("git", ["-C", rootDir, "init", "-q"]);
    execFileSync("git", ["-C", rootDir, "config", "user.name", "Decision Person Witness Test"]);
    execFileSync("git", ["-C", rootDir, "config", "user.email", "witness@example.invalid"]);
    writeFileSync(path.join(rootDir, "README.md"), "# Project\n");
    execFileSync("git", ["-C", rootDir, "add", "README.md"]);
    execFileSync("git", ["-C", rootDir, "commit", "-qm", "project base"]);
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "decision-person-witness-test",
      bootstrap: {
        ...resolveRepoBootstrap({ rootDir, repoId, personId: "person-owner", displayName: "Owner" }, auth),
        actor: owner.actor,
        keycloakAuthorization: owner.keycloakAuthorization,
      },
      defaultWriterEpochFence: {
        schema: "harness-writer-epoch-fence/v1",
        stateRoot,
        repoId,
        epoch: lease.epoch,
        holderId: lease.holderId,
      },
    });
    const proposed = await cell.run(decisionProposal(), owner);
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
    const decisionId = receiptJson(proposed).decisionId as string,
      shown = receiptJson(await cell.run({ kind: "decision-show", decisionId }, owner)).decision as {
        readonly currentReviewContentDigest: `sha256:${string}`;
      },
      // A dispatched-style reviewId reports at the stem without its "review-" prefix.
      stem = reviewId.startsWith("review-") ? reviewId.slice("review-".length) : reviewId,
      reportRef = `decisions/decision-${decisionId}/artifacts/reports/${stem}.md`,
      reportPath = path.join(rootDir, "harness", ...reportRef.split("/"));
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, "# Review\n\nCorrections are needed.\n");
    const packetPath = path.join(
      rootDir,
      "harness",
      "decisions",
      `decision-${decisionId}`,
      "artifacts",
      "reports",
      `${stem}.json`,
    );
    writeFileSync(
      packetPath,
      JSON.stringify({
        reviewId,
        reviewContentDigest: shown.currentReviewContentDigest,
        verdict: "changes_requested",
        reason: "The proposal needs named corrections.",
        findings: [{ findingId: "finding-1", text: "Name the first correction." }],
        evidenceChecked: [],
        reportRef,
      }),
    );
    return { cell, authority, owner, reviewer, decisionId, rootDir };
  } catch (error) {
    try {
      await cell?.close();
    } finally {
      authority.close();
      removeTempStoreRoot(rootDir);
    }
    throw error;
  }
}

async function closeStage(stage: ReviewStage): Promise<void> {
  try {
    await stage.cell.close();
  } finally {
    stage.authority.close();
    removeTempStoreRoot(stage.rootDir);
  }
}

test("a from-file changes_requested review and its response resolve the proposal owner as an awaits target", async () => {
  const stage = await stageDecision("review-from-file");
  try {
    const reviewed = await stage.cell.run(
      {
        kind: "decision-review",
        decisionId: stage.decisionId,
        fromFile: `harness/decisions/decision-${stage.decisionId}/artifacts/reports/from-file.json`,
      },
      stage.reviewer,
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    writeFileSync(
      path.join(
        stage.rootDir,
        "harness",
        "decisions",
        `decision-${stage.decisionId}`,
        "artifacts",
        "reports",
        "respond.json",
      ),
      JSON.stringify({
        responses: [
          {
            reviewId: "review-from-file",
            findingId: "finding-1",
            disposition: "rebut",
            rationale: "The correction conflicts with the chosen tradeoff.",
            amendmentRef: null,
          },
        ],
      }),
    );
    const responded = await stage.cell.run(
      {
        kind: "decision-respond-review",
        decisionId: stage.decisionId,
        fromFile: `harness/decisions/decision-${stage.decisionId}/artifacts/reports/respond.json`,
      },
      stage.owner,
    );
    assert.equal(responded.outcome, "applied", JSON.stringify(responded));
    const awaits = (
      JSON.parse(
        String(
          (await stage.cell.run({ kind: "relation-list", entity: `decision/${stage.decisionId}` }, stage.owner))
            .evidence,
        ),
      ) as {
        readonly rows: readonly { readonly relationType: string; readonly targetRef: string; readonly state: string }[];
      }
    ).rows.filter(({ relationType }) => relationType === "awaits");
    assert.deepEqual(
      awaits.map(({ targetRef, state }) => ({ targetRef, state })),
      [{ targetRef: "person/person-owner", state: "active" }],
    );
  } finally {
    await closeStage(stage);
  }
});

test("an invalid respond-review packet names its own field instead of a missing finding", async () => {
  const stage = await stageDecision("review-direct");
  try {
    const shown = receiptJson(
        await stage.cell.run({ kind: "decision-show", decisionId: stage.decisionId }, stage.owner),
      ).decision as { readonly currentReviewContentDigest: `sha256:${string}` },
      reportRef = `decisions/decision-${stage.decisionId}/artifacts/reports/direct.md`;
    writeFileSync(
      path.join(stage.rootDir, "harness", ...reportRef.split("/")),
      "# Review\n\nA correction is needed.\n",
    );
    const reviewed = await stage.cell.run(
      {
        kind: "decision-review",
        decisionId: stage.decisionId,
        reviewId: "review-direct",
        reviewContentDigest: shown.currentReviewContentDigest,
        verdict: "changes_requested",
        reason: "The proposal needs a named correction.",
        findings: [{ findingId: "finding-1", text: "Name the correction before acceptance." }],
        evidenceChecked: [],
        reportRef,
      },
      stage.reviewer,
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    const packet = (responses: unknown) =>
        stage.cell.run(
          {
            kind: "decision-respond-review",
            decisionId: stage.decisionId,
            jsonInput: JSON.stringify({ responses }),
          },
          stage.owner,
        ),
      invalidFields = await packet([
        { reviewId: "review-direct", findingId: "finding-1", disposition: "accepted", text: "Wrong field names." },
      ]);
    assert.equal(invalidFields.outcome, "op_rejected", JSON.stringify(invalidFields));
    assert.equal(invalidFields.code, "invalid_command", JSON.stringify(invalidFields));
    assert.match(
      String(invalidFields.rejectionExplanation ?? invalidFields.evidence ?? ""),
      /responses\[0\]\.disposition/u,
      "the rejection must name the invalid field, not a missing finding",
    );
    const missingFinding = await packet([
      {
        reviewId: "review-direct",
        findingId: "finding-absent",
        disposition: "adopt",
        rationale: "Fields are valid, so this surfaces the existence judgment.",
        amendmentRef: null,
      },
    ]);
    assert.equal(missingFinding.code, "invalid_transition", JSON.stringify(missingFinding));
    assert.match(
      String(missingFinding.rejectionExplanation ?? missingFinding.evidence ?? ""),
      /review-direct\/finding-absent does not exist/u,
    );
    const unknownField = await packet([
      {
        reviewId: "review-direct",
        findingId: "finding-1",
        disposition: "adopt",
        rationale: "Every known field is valid; only the unknown field is wrong.",
        amendmentRef: null,
        text: "Not a response field.",
      },
    ]);
    assert.equal(unknownField.code, "invalid_command", JSON.stringify(unknownField));
    assert.match(
      String(unknownField.rejectionExplanation ?? unknownField.evidence ?? ""),
      /responses\[0\] does not accept text/u,
    );
    const omittedAmendmentRef = await packet([
      {
        reviewId: "review-direct",
        findingId: "finding-1",
        disposition: "adopt",
        rationale: "An omitted amendmentRef normalizes to null.",
      },
    ]);
    assert.equal(omittedAmendmentRef.outcome, "applied", JSON.stringify(omittedAmendmentRef));
    const malformedFinding = await stage.cell.run(
      {
        kind: "decision-review",
        decisionId: stage.decisionId,
        reviewId: "review-malformed",
        reviewContentDigest: shown.currentReviewContentDigest,
        verdict: "changes_requested",
        reason: "The finding item itself is malformed.",
        findings: [{ findingId: "finding-2" }],
        evidenceChecked: [],
        reportRef,
      },
      stage.reviewer,
    );
    assert.equal(malformedFinding.code, "invalid_command", JSON.stringify(malformedFinding));
    assert.match(
      String(malformedFinding.rejectionExplanation ?? malformedFinding.evidence ?? ""),
      /findings\[0\]\.text is required/u,
    );
  } finally {
    await closeStage(stage);
  }
});

function decisionProposal() {
  return {
    kind: "decision-propose",
    body: realizedDecisionBody("Person witness review"),
    jsonInput: JSON.stringify({
      title: "Person witness review",
      question: "Can a review await target the proposal owner without a person entity?",
      riskTier: "high",
      urgency: "high",
      vertical: "software/coding",
      preset: "standard-task",
      decisionClass: "ordinary",
      appliesTo: { modules: ["daemon"], productLines: [] },
      chosen: [{ id: "CH1", text: "Resolve the owner through the identity witness" }],
      rejected: [{ id: "RJ1", text: "Materialize person entities", whyNot: "People live in Keycloak" }],
      claims: [{ id: "C1", text: "The awaits edge can target the owner.", loadBearing: true }],
      fulfillments: [],
    }),
  } as const;
}

function receiptJson(receipt: { readonly evidence?: string }): Record<string, unknown> {
  return JSON.parse(String(receipt.evidence)) as Record<string, unknown>;
}
