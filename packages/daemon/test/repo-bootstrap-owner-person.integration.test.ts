// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

test("the bootstrap owner is a Person a review awaits edge can target in a freshly initialized repository", async () => {
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-bootstrap-owner-person-"))),
    repoId = workspaceId("bootstrap-owner-person"),
    stateRoot = path.join(rootDir, "writer-epochs"),
    authority = openPersistentWriterEpoch({ stateRoot, holderId: "bootstrap-owner-person-test" }),
    lease = authority.acquire(repoId),
    owner = withPolicyGroup(
      {
        actor: { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: "owner-agent" } },
        source: "local" as const,
        authorizationBindingMode: "declared" as const,
      },
      "admin",
    ),
    reviewer = withPolicyGroup(
      { actor: { principal: { personId: "person-reviewer" }, executor: null }, source: "local" as const },
      "maintainer",
    );
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    execFileSync("git", ["-C", rootDir, "init", "-q"]);
    execFileSync("git", ["-C", rootDir, "config", "user.name", "Bootstrap Owner Test"]);
    execFileSync("git", ["-C", rootDir, "config", "user.email", "bootstrap-owner@example.invalid"]);
    writeFileSync(path.join(rootDir, "README.md"), "# Project\n");
    execFileSync("git", ["-C", rootDir, "add", "README.md"]);
    execFileSync("git", ["-C", rootDir, "commit", "-qm", "project base"]);
    // The full `ha init` shape: no People action runs between bootstrap and the first review.
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "bootstrap-owner-person-test",
      bootstrap: {
        ...resolveRepoBootstrap(
          { rootDir, repoId: "bootstrap-owner-person", personId: "person-owner", displayName: "Owner" },
          auth,
        ),
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
      reportRef = `decisions/decision-${decisionId}/artifacts/reports/changes-requested.md`,
      reportPath = path.join(rootDir, "harness", ...reportRef.split("/"));
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, "# Review\n\nTwo corrections are needed.\n");
    const reviewed = await cell.run(
      {
        kind: "decision-review",
        decisionId,
        reviewId: "review-changes-requested",
        reviewContentDigest: shown.currentReviewContentDigest,
        verdict: "changes_requested",
        reason: "The proposal needs two corrections.",
        findings: [
          { findingId: "finding-1", text: "Name the first correction." },
          { findingId: "finding-2", text: "Name the second correction." },
        ],
        evidenceChecked: [],
        reportRef,
      },
      reviewer,
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    const responded = await cell.run(
      {
        kind: "decision-respond-review",
        decisionId,
        responses: [
          {
            reviewId: "review-changes-requested",
            findingId: "finding-1",
            disposition: "rebut",
            rationale: "The first correction conflicts with the chosen tradeoff.",
            amendmentRef: null,
          },
        ],
      },
      owner,
    );
    assert.equal(responded.outcome, "applied", JSON.stringify(responded));
    const awaits = (
      JSON.parse(
        String((await cell.run({ kind: "relation-list", entity: `decision/${decisionId}` }, owner)).evidence),
      ) as {
        readonly rows: readonly { readonly relationType: string; readonly targetRef: string; readonly state: string }[];
      }
    ).rows.filter(({ relationType }) => relationType === "awaits");
    assert.deepEqual(
      awaits.map(({ targetRef, state }) => ({ targetRef, state })),
      [{ targetRef: "person/person-owner", state: "active" }],
    );
  } finally {
    await cell?.close();
    authority.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function decisionProposal() {
  return {
    kind: "decision-propose",
    body: realizedDecisionBody("Bootstrap owner review"),
    jsonInput: JSON.stringify({
      title: "Bootstrap owner review",
      question: "Can the bootstrap owner answer a review?",
      riskTier: "high",
      urgency: "high",
      vertical: "software/coding",
      preset: "standard-task",
      decisionClass: "ordinary",
      appliesTo: { modules: ["daemon"], productLines: [] },
      chosen: [{ id: "CH1", text: "Answer the review" }],
      rejected: [{ id: "RJ1", text: "Ignore the review", whyNot: "Findings must be answered" }],
      claims: [{ id: "C1", text: "The owner can be awaited.", loadBearing: true }],
      fulfillments: [],
    }),
  } as const;
}

function receiptJson(receipt: { readonly evidence?: string }): Record<string, unknown> {
  return JSON.parse(String(receipt.evidence)) as Record<string, unknown>;
}
