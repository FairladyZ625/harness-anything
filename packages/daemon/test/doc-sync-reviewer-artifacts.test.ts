// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { withRoleBinding } from "./role-binding.fixtures.ts";

import { initRepo, ownerBinding, rows, write } from "./doc-sync-slice-a.fixtures.ts";

// The execution worker rides the held-lease channel like any direct executor; the reviewer is a
// runtime-session actor that must not reach reviewed prose once submit releases the lease.
const workerBinding = withRoleBinding(
    {
      actor: {
        principal: { personId: "person-owner" },
        executor: { kind: "agent", id: "artifact-worker" },
      },
      source: "local" as const,
    },
    "owner",
  ),
  reviewerBinding = withRoleBinding(
    {
      actor: {
        principal: { personId: "person-owner" },
        executor: { kind: "agent", id: "runtime-session:runtime-artifact-reviewer" },
      },
      source: "local" as const,
    },
    "owner",
  );

test("task artifact json and log files ride doc sync under the held task lease", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-reviewer-artifacts-"));
  initRepo(rootDir);
  const repoId = workspaceId("reviewer-artifacts"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "reviewer-artifacts-daemon",
    });
  try {
    const created = (await cell.run(
        { kind: "task-create", taskId: "task-artifact-text", title: "Artifact text channel" },
        ownerBinding,
      )) as { packagePath?: string },
      packagePath = created.packagePath!;
    await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
      cell.run({ kind: "doc-submit", paths: [planPath] }, ownerBinding),
    );
    assert.equal(
      (
        await cell.run(
          { kind: "task-start", taskId: "task-artifact-text", executionId: "exec-artifact-text" },
          workerBinding,
        )
      ).outcome,
      "applied",
    );
    const submission = `${packagePath}/artifacts/closeout-submission.json`,
      log = `${packagePath}/artifacts/evidence/run.log`,
      packetOutsideArtifacts = `${packagePath}/review-input.json`;
    write(
      rootDir,
      submission,
      JSON.stringify({ completionClaim: "delivered", deliverables: [], verificationNotes: [] }, null, 2) + "\n",
    );
    write(rootDir, log, "2026-09-14T00:00:00Z evidence line one\n2026-09-14T00:01:00Z evidence line two\n");
    write(rootDir, packetOutsideArtifacts, "{}\n");
    const status = await cell.run(
      { kind: "doc-status", paths: [submission, log, packetOutsideArtifacts] },
      workerBinding,
    );
    assert.deepEqual(
      rows(status.evidence).map((row) => [row.path, row.state]),
      [
        [submission, "eligible"],
        [log, "eligible"],
        // The artifacts subtree is the unified textual subset; a JSON file elsewhere in the
        // package is still not a doc-sync candidate.
        [packetOutsideArtifacts, "blocked"],
      ],
      JSON.stringify(status.evidence),
    );
    const submitted = (await cell.run({ kind: "doc-submit", paths: [submission, log] }, workerBinding)) as Record<
      string,
      unknown
    >;
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    await waitForFixturePublication(cell, String(submitted.opId), workerBinding);
    const event = makeTaskEventReader({ repoId, rootDir }).readEvent(String(submitted.opId));
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema === "doc-event/v1")
      assert.deepEqual(
        event.payload.changes.map((change) => [change.path, change.candidate?.mediaType]),
        [
          [submission, "application/json"],
          [log, "text/x-harness-opaque"],
        ],
      );
    // Negative control: a textual-format artifact whose bytes are not UTF-8 stays out of doc sync.
    const undecodable = `${packagePath}/artifacts/binary.json`;
    write(rootDir, undecodable, Buffer.from([0x7b, 0xff, 0x7d]));
    const refused = await cell.run({ kind: "doc-submit", paths: [undecodable] }, workerBinding);
    assert.notEqual(refused.outcome, "applied");
    assert.match(String((refused as { summary?: string }).summary ?? JSON.stringify(refused)), /task artifact add/u);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a runtime reviewer cannot publish reviewed task prose after submit releases the lease", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-reviewer-prose-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("reviewer-prose"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "reviewer-prose-daemon",
  });
  try {
    const created = (await cell.run(
        { kind: "task-create", taskId: "task-reviewer-prose", title: "Reviewer prose boundary" },
        ownerBinding,
      )) as { packagePath?: string },
      packagePath = created.packagePath!;
    await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
      cell.run({ kind: "doc-submit", paths: [planPath] }, ownerBinding),
    );
    assert.equal(
      (
        await cell.run(
          { kind: "task-start", taskId: "task-reviewer-prose", executionId: "exec-reviewer-prose" },
          workerBinding,
        )
      ).outcome,
      "applied",
    );
    const proseArtifact = `${packagePath}/artifacts/report.md`;
    write(rootDir, proseArtifact, "# Evidence\n\nProse boundary fixture delivery.\n");
    const proseSync = (await cell.run({ kind: "doc-submit", paths: [proseArtifact] }, workerBinding)) as Record<
      string,
      unknown
    >;
    assert.equal(proseSync.outcome, "applied", JSON.stringify(proseSync));
    write(
      rootDir,
      `${packagePath}/closeout.md`,
      `## Summary\nDelivered artifact:${proseArtifact}@${String(proseSync.revision)} for this round.\n\n## Verification\nFixture.\n\n## Residual Risk\nNone.\n\n## Same Mechanism Elsewhere\nCovered by the other tests in this file.\n`,
    );
    assert.equal(
      (
        await cell.run(
          { kind: "task-submit", taskId: "task-reviewer-prose", executionId: "exec-reviewer-prose" },
          workerBinding,
        )
      ).outcome,
      "applied",
    );
    // The reviewer rewrites reviewed prose and tries to publish it while the task lease is
    // released by submit: doc sync must refuse the prose edit.
    write(
      rootDir,
      `${packagePath}/closeout.md`,
      "## Summary\nReviewer rewrite.\n\n## Verification\nFixture.\n\n## Residual Risk\nNone.\n",
    );
    const refused = (await cell.run(
      { kind: "doc-submit", paths: [`${packagePath}/closeout.md`] },
      reviewerBinding,
    )) as { outcome?: string; code?: string };
    assert.equal(refused.outcome, "op_rejected");
    assert.equal(refused.code, "lease_conflict");
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
