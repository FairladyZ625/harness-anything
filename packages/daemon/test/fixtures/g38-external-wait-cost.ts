// harness-test-tier: integration
// G38 write-port external-wait probes: measure network round trips and remote child processes
// only while chainRepoCellWrite holds the serialized write turn.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalRoot, workspaceId } from "../../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { writePortExternalObservation } from "../../src/daemon-host/write-port-external-observation.ts";
import { chainRepoCellWrite } from "../../src/daemon-host/repo-cell.ts";
import { pushWorkerBranch } from "../../src/daemon-host/runtime-worker-push.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "../repo-settings.fixture.ts";
import { withPolicyGroup } from "../keycloak-policy.fixtures.ts";
import { initRepo } from "../task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../../tools/fixtures/task-plan.mjs";
import { removeTempRepository } from "../../../../tools/fixtures/remove-temp-repository.ts";

export const EXTERNAL_WAIT_METRICS = Object.freeze(["networkRoundTrips", "remoteChildProcesses"] as const);

export type ExternalWaitCounts = Record<(typeof EXTERNAL_WAIT_METRICS)[number], number>;

function gitShell(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function closeout(taskId: string) {
  return (
    `# Closeout\n\n## Summary\n\nMeasured ${taskId}.\n\n` +
    "## Verification\n\nG38 external-wait fixture.\n\n## Residual Risk\n\nNone.\n\n" +
    "## Same Mechanism Elsewhere\n\nN/A.\n"
  );
}

async function withFileOriginFixture(
  label: string,
  run: (input: {
    readonly cell: Awaited<ReturnType<typeof openBootstrappedRepoCell>>;
    readonly rootDir: string;
    readonly taskId: string;
    readonly executionId: string;
    readonly worktree: string;
    readonly binding: ReturnType<typeof withPolicyGroup>;
  }) => Promise<ExternalWaitCounts>,
): Promise<ExternalWaitCounts> {
  const parent = mkdtempSync(path.join(tmpdir(), `ha-g38-external-${label}-`)),
    rootDir = path.join(parent, "repo"),
    bare = path.join(parent, "origin.git"),
    repoId = workspaceId(`g38-external-${label}`),
    taskId = `task_g38_${label}`,
    executionId = `execution_g38_${label}`,
    binding = withPolicyGroup(
      {
        actor: { principal: { personId: "person-g38-external-wait" }, executor: null },
        source: "local" as const,
      },
      "admin",
    );
  try {
    mkdirSync(rootDir);
    initRepo(rootDir);
    gitShell(rootDir, "branch", "-M", "main");
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/harness.yaml"), "settings:\n");
    execFileSync("git", ["init", "--bare", "-q", "--initial-branch=main", bare], { stdio: "ignore" });
    gitShell(rootDir, "remote", "add", "origin", pathToFileURL(bare).href);
    gitShell(rootDir, "push", "-q", "origin", "main:main");
    const cell = await openBootstrappedRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: `g38-external-${label}`,
      now: () => "2026-11-24T02:00:00.000Z",
    });
    try {
      const created = await cell.run({ kind: "task-create", taskId, title: `G38 ${label}` }, binding);
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      await waitForFixturePublication(cell, created.opId, binding);
      const packagePath = String((created as { readonly packagePath?: unknown }).packagePath);
      await realizeTaskPlanFixture(
        rootDir,
        packagePath,
        (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
        `G38 ${label}`,
      );
      assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, binding)).outcome, "applied");
      const worktree = path.join(rootDir, ".worktrees", taskId);
      writeFileSync(path.join(worktree, "README.md"), `# ${label}\n`);
      gitShell(worktree, "add", "README.md");
      gitShell(worktree, "commit", "-qm", "fixture delivery");
      const closeoutPath = `${packagePath}/closeout.md`;
      for (const root of [rootDir, worktree]) {
        const file = path.join(root, "harness", closeoutPath);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, closeout(taskId));
      }
      assert.equal((await cell.run({ kind: "doc-submit", paths: [closeoutPath] }, binding)).outcome, "applied");
      return await run({ cell, rootDir, taskId, executionId, worktree, binding });
    } finally {
      await cell.close();
    }
  } finally {
    removeTempRepository(parent);
  }
}

export async function measureTaskSubmitWritePort(_rootDir: string): Promise<ExternalWaitCounts> {
  return withFileOriginFixture("submit", async ({ cell, taskId, executionId, binding }) => {
    writePortExternalObservation.reset();
    const submitted = await cell.run({ kind: "task-submit", taskId, executionId }, binding);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    return writePortExternalObservation.snapshot();
  });
}

export async function measureTaskPushWritePort(_rootDir: string): Promise<ExternalWaitCounts> {
  return withFileOriginFixture("push", async ({ cell, taskId, executionId, binding, worktree }) => {
    writePortExternalObservation.reset();
    const submitted = await cell.run({ kind: "task-submit", taskId, executionId }, binding);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    gitShell(worktree, "push", "-q", "origin", `HEAD:refs/heads/${taskId}`);
    writePortExternalObservation.reset();
    const pushed = await cell.run({ kind: "task-push", taskId }, binding);
    assert.equal(pushed.outcome, "applied", JSON.stringify(pushed));
    return writePortExternalObservation.snapshot();
  });
}

/** Rejection that only needs current snapshot state: submit targeting an unknown execution id. */
export async function measureTaskSubmitRejectionWritePort(_rootDir: string): Promise<ExternalWaitCounts> {
  return withFileOriginFixture("submit-reject", async ({ cell, taskId, binding }) => {
    writePortExternalObservation.reset();
    const rejected = await cell.run({ kind: "task-submit", taskId, executionId: "execution_g38_missing" }, binding);
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    return writePortExternalObservation.snapshot();
  });
}

/** Run a hosted-shaped push through the real write queue with a local Git transport. */
export async function measureInjectedRemoteGitProcessWritePort(): Promise<ExternalWaitCounts> {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-g38-external-positive-")),
    rootDir = path.join(parent, "repo"),
    bare = path.join(parent, "origin.git"),
    worktree = path.join(parent, "worker"),
    taskId = "task_g38_positive",
    remote = "https://g38.invalid/origin.git",
    config = path.join(parent, "gitconfig");
  try {
    mkdirSync(rootDir);
    initRepo(rootDir);
    gitShell(rootDir, "branch", "-M", "main");
    execFileSync("git", ["init", "--bare", "-q", "--initial-branch=main", bare], { stdio: "ignore" });
    gitShell(rootDir, "push", pathToFileURL(bare).href, "main:main");
    gitShell(rootDir, "remote", "add", "origin", remote);
    gitShell(rootDir, "worktree", "add", "-qb", taskId, worktree);
    writeFileSync(config, `[url "${pathToFileURL(bare).href}"]\n\tinsteadOf = ${remote}\n`, "utf8");
    writePortExternalObservation.reset();
    const pushed = await chainRepoCellWrite(Promise.resolve(), () =>
      pushWorkerBranch({
        cwd: worktree,
        canonicalRoot: rootDir,
        taskId,
        env: { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "file" },
      }),
    );
    assert.ok(pushed.attempted && pushed.ok, JSON.stringify(pushed));
    assert.equal(gitShell(bare, "rev-parse", `refs/heads/${taskId}`), pushed.pushedCommit);
    return writePortExternalObservation.snapshot();
  } finally {
    removeTempRepository(parent);
  }
}
