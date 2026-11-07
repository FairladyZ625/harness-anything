// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const holder = withPolicyGroup(
  {
    actor: { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: "ceo-session:one" } },
    source: "local" as const,
  },
  "admin",
);

// #4376: a same-holder start used to answer `no_changes` before it read the caller's
// expectedVersion and executionId, so a wrong precondition looked like a successful rejoin.
test("a held-lease task start checks the caller's revision and execution before reporting no_changes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-start-held-preconditions-")),
    repoId = "start-held-preconditions",
    taskId = "task-start-held-preconditions",
    executionId = "execution-start-held-preconditions";
  let cell: Awaited<ReturnType<typeof openBootstrappedRepoCell>> | undefined;
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: rootDir, stdio: "ignore" });
    git("init", "--quiet");
    git("config", "user.name", "Start Preconditions Fixture");
    git("config", "user.email", "start-preconditions@example.invalid");
    git("commit", "--allow-empty", "--quiet", "-m", "base");
    cell = await openBootstrappedRepoCell({
      repoId: workspaceId(repoId),
      rootDir: canonicalRoot(rootDir),
      ownerId: repoId,
    });
    const created = await cell.run({ kind: "task-create", taskId, title: "Held lease preconditions" }, holder);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, holder);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, holder),
    );
    const started = await cell.run({ kind: "task-start", taskId, executionId }, holder);
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    await waitForFixturePublication(cell, started.opId, holder);
    const revision = Number(started.revision),
      staleRevision = revision - 1;

    const wrongExecution = await cell.run(
      { kind: "task-start", taskId, executionId: "execution-someone-else", expectedVersion: revision },
      holder,
    );
    assert.notEqual(wrongExecution.outcome, "no_changes", JSON.stringify(wrongExecution));
    assert.equal(wrongExecution.code, "invalid_transition", JSON.stringify(wrongExecution));
    assert.match(
      String(wrongExecution.rejectionExplanation ?? JSON.stringify(wrongExecution)),
      new RegExp(executionId, "u"),
    );

    const staleVersion = await cell.run(
      { kind: "task-start", taskId, executionId, expectedVersion: staleRevision },
      holder,
    );
    assert.notEqual(staleVersion.outcome, "no_changes", JSON.stringify(staleVersion));
    assert.match(
      JSON.stringify(staleVersion.nextActions ?? []),
      new RegExp(`--expected-version ${String(revision)}`, "u"),
      JSON.stringify(staleVersion),
    );

    const matching = await cell.run({ kind: "task-start", taskId, executionId, expectedVersion: revision }, holder);
    assert.equal(matching.outcome, "no_changes", JSON.stringify(matching));
    assert.equal(matching.executionId, executionId);
    const unconstrained = await cell.run({ kind: "task-start", taskId }, holder);
    assert.equal(unconstrained.outcome, "no_changes", JSON.stringify(unconstrained));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
