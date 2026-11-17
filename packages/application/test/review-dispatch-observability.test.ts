// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { preflightNodeReviewDispatch } from "../src/commands/node-review-dispatch-preflight.ts";
import {
  reviewDispatchDiagnostic,
  reviewDispatchFailureWarning,
  withReviewDispatchFailures,
} from "../src/queries/review-dispatch-failure-read.ts";
import { fleetVersionWarningMessages } from "../src/queries/fleet-version-warning-read.ts";

const candidate = { taskId: "task-review", executionId: "execution-review", dispatchKey: "review:cut:one" },
  now = () => "2026-11-17T01:00:00.000Z";

for (const code of ["human_confirmation_required", "authentication_required", "oidc_device_expired"]) {
  test(`${code} preserves the provider explanation and adds provider-neutral login recovery`, () => {
    const message = "The configured identity provider rejected the expired session.",
      diagnostic = reviewDispatchDiagnostic({ code, message });
    assert.equal(diagnostic.code, code);
    assert.ok(diagnostic.message.startsWith(message));
    assert.match(diagnostic.message, /ha bootstrap --operation login.*sync this node/u);
    assert.doesNotMatch(diagnostic.message, /Keycloak/iu);
  });
}

for (const [code, message, expected] of [
  [
    "protocol_version_unsupported",
    "Node edge-one build=aaaa differs from center build=bbbb. Run git pull --ff-only, then build CLI and daemon.",
    /edge-one.*aaaa.*bbbb.*git pull --ff-only/u,
  ],
  [
    "edge_default_branch_behind",
    "Edge default branch is behind center main. Run git merge --ff-only origin/main.",
    /git merge --ff-only origin\/main/u,
  ],
  [
    "human_confirmation_required",
    "The command requires an active personal Keycloak access token issued for this center.",
    /Keycloak.*expired.*Sign in/u,
  ],
  ["execution_credential_rejected", "Execution credential rejected.", /credential.*expired.*Sign in/u],
] as const) {
  for (const command of ["task-submit", "task-dispatch-review"]) {
    test(`${command} keeps accepted cut and exposes ${code} in its receipt and canonical failure`, async () => {
      const published: unknown[] = [],
        error = Object.assign(new Error(message), { code }),
        observed = await preflightNodeReviewDispatch({
          candidates: [candidate],
          preflight: async () => {
            throw error;
          },
          diagnostic: (value) =>
            reviewDispatchDiagnostic({ code: (value as typeof error).code, message: (value as Error).message }),
          writeFailure: async (row, failure) => {
            published.push({ row, failure });
          },
          now,
        });
      const result = withReviewDispatchFailures(
        { outcome: "applied", command, opId: "accepted-submission", warnings: ["existing warning"] },
        observed.failures,
      );
      assert.equal(result.outcome, "applied");
      assert.equal(result.opId, "accepted-submission");
      assert.equal(published.length, 1);
      const failure = (result.reviewDispatchFailures as { code: string; message: string }[])[0]!;
      assert.equal(failure.code, code);
      assert.match(failure.message, expected);
      assert.match(String(result.warnings), expected);
      assert.match(reviewDispatchFailureWarning(failure), /review dispatch failed/u);
      assert.equal((result.warnings as string[])[0], "existing warning");
    });
  }
}

test("a healthy preflight or absent candidate adds no failure and performs no canonical write", async () => {
  for (const candidates of [[], [candidate]]) {
    let preflights = 0;
    const receipt = { outcome: "applied", opId: "healthy" };
    const result = await preflightNodeReviewDispatch({
      candidates,
      preflight: async () => {
        preflights++;
      },
      diagnostic: () => {
        throw new Error("unexpected diagnostic");
      },
      writeFailure: async () => {
        throw new Error("unexpected write");
      },
      now,
    });
    assert.equal(withReviewDispatchFailures(receipt, result.failures), receipt);
    assert.equal(preflights, candidates.length);
  }
});

test("failure publication rejection exposes both original preflight and expired login", async () => {
  const result = await preflightNodeReviewDispatch({
    candidates: [candidate],
    preflight: async () => {
      throw Object.assign(new Error("git merge --ff-only origin/main"), { code: "edge_default_branch_behind" });
    },
    diagnostic: (error) =>
      reviewDispatchDiagnostic({ code: (error as { code: string }).code, message: (error as Error).message }),
    writeFailure: async () => {
      throw Object.assign(new Error("Keycloak access token expired"), { code: "human_confirmation_required" });
    },
    now,
  });
  assert.equal(result.failures[0]?.code, "edge_default_branch_behind");
  assert.match(String(result.publicationWarnings), /human_confirmation_required.*Sign in/u);
});

test("fleet warnings identify node, role and repositories and isolate unrelated VM warnings", () => {
  const input = {
    warnings: [
      { nodeId: "edge-one", message: "build aaaa != bbbb" },
      { nodeId: "vm-old", message: "build old != bbbb" },
      { nodeId: "unbound", message: "build unknown" },
    ],
    sessions: [
      { nodeId: "edge-one", lastRepoId: "repo-current" },
      { nodeId: "vm-old", lastRepoId: "repo-other" },
    ],
    replicas: [{ nodeId: "edge-one", repoId: "repo-shared" }],
  };
  const all = fleetVersionWarningMessages(input);
  assert.equal(all.length, 3);
  assert.match(all[0]!, /node=edge-one.*role=edge.*repoIds=repo-current,repo-shared/u);
  assert.match(all[1]!, /node=vm-old.*repoIds=repo-other/u);
  assert.match(all[2]!, /repoIds=unknown/u);
  const current = fleetVersionWarningMessages({ ...input, repoId: "repo-current" });
  assert.equal(current.length, 1);
  assert.doesNotMatch(current.join("\n"), /vm-old|unbound|repo-other/u);
  assert.equal(fleetVersionWarningMessages({ ...input, repoId: "repo-empty" }).length, 0);
});
