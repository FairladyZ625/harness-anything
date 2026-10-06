// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, type ExecutionV1 } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

const worker = withPolicyGroup(
  { actor: { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } }, source: "local" },
  "contributor",
);
const owner = withPolicyGroup(
  { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" },
  "admin",
) as const;
const githubCiMapping =
  "  gates:\n    ci:\n      appliesTo: code\n      adapter: github-actions\n      branch: main\n      event: push\n      coverage: descendant\n      selection: newest\n";

const git = (rootDir: string, ...args: readonly string[]): string =>
  execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** One delivery round: a commit on the task's own branch, a closeout, and the submit that cuts it. */
async function deliverRound(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  rootDir: string,
  taskId: string,
  packagePath: string,
  executionId: string,
  summary: string,
): Promise<string> {
  await cell.settlePendingMaterialization("closeout git commit");
  const worktree = path.join(rootDir, ".worktrees", taskId);
  writeFileSync(path.join(worktree, "DELIVERY.md"), `${summary}\n`);
  git(worktree, "add", "DELIVERY.md");
  git(worktree, "commit", "--quiet", "-m", `test: ${summary}`);
  const tip = git(worktree, "rev-parse", "HEAD");
  writeFileSync(
    path.join(rootDir, "harness", packagePath, "closeout.md"),
    `# Closeout\n\n## Summary\n\n${summary} Commit ${tip}.\n\n` +
      "## Verification\n\nVerified.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNot applicable.\n",
  );
  const submitted = (await cell.run({ kind: "task-submit", taskId, executionId }, worker)) as Record<string, unknown>;
  assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
  return tip;
}

function startedExecutions(rootDir: string, repoId: string): readonly ExecutionV1[] {
  return makeTaskEventReader({ repoId, rootDir })
    .read()
    .events.flatMap((event) =>
      event.schema === "task-event/v1" && event.type === "execution_started" ? [event.payload.execution] : [],
    );
}

test("a rework execution freezes the delivery branch's fork point, not the advanced project HEAD", async () => {
  const name = "baseline-rework",
    rootDir = mkdtempSync(path.join(tmpdir(), `ha-${name}-`)),
    repoId = workspaceId(name),
    taskId = `task-${name}`;
  git(rootDir, "init", "--quiet", "-b", "main");
  git(rootDir, "config", "user.name", "RepoCell Test");
  git(rootDir, "config", "user.email", "repo-cell@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    `settings:\n  ci:\n    workflows: [rework-ci]\n${githubCiMapping}`,
  );
  const cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: name });
  const reader = makeTaskEventReader({ repoId, rootDir });
  try {
    const created = (await cell.run({ kind: "task-create", taskId, title: "Baseline rework" }, worker)) as Record<
      string,
      unknown
    >;
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const packagePath = String(created.packagePath);
    await realizeTaskPlanFixture(rootDir, packagePath, (planPath: string) =>
      cell.run({ kind: "doc-submit", paths: [planPath] }, worker),
    );

    // Round A starts at the fork, delivers on the task branch, and is returned for rework.
    const executionA = "execution-baseline-a";
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId: executionA }, worker)).outcome, "applied");
    await deliverRound(cell, rootDir, taskId, packagePath, executionA, "Round A delivery.");
    const returned = (await cell.run(
      { kind: "task-adjudicate", taskId, executionId: executionA, return: true, reason: "Rework the cut." },
      owner,
    )) as Record<string, unknown>;
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));

    // main advances past the delivery branch's fork while the task sits in rework.
    git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "main advanced");

    // Round B appends a commit on the same branch and submits again.
    const executionB = "execution-baseline-b";
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId: executionB }, worker)).outcome, "applied");
    const branchTip = await deliverRound(cell, rootDir, taskId, packagePath, executionB, "Round B delivery.");

    const baselines = new Map(
      startedExecutions(rootDir, repoId).map((execution) => [execution.executionId, execution.deliveryBaseline]),
    );
    const baselineA = baselines.get(executionA),
      baselineB = baselines.get(executionB);
    assert.ok(baselineA?.kind === "commit" && baselineB?.kind === "commit");
    // The frozen baseline is the branch's fork point on the default branch — recomputed here
    // independently as merge-base(canonical HEAD, branch tip) — so the reviewer's lineage check,
    // git merge-base --is-ancestor <baseline> <delivery commit>, holds even though main advanced
    // between the rounds (here it advances twice: the rework-time commit above and the ledger's
    // own outbox commits the cell keeps writing to the canonical checkout). Before the fix the
    // round-B baseline froze the advanced main HEAD and the ancestry command below failed.
    const forkPoint = git(rootDir, "merge-base", "HEAD", branchTip);
    assert.equal(baselineA.commitSha, forkPoint);
    assert.equal(baselineB.commitSha, forkPoint);
    git(rootDir, "merge-base", "--is-ancestor", baselineB.commitSha, branchTip);
  } finally {
    await reader.drain();
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
