// harness-test-tier: integration
// dec_E610E1D99A39003886D1B5EE7C CH3: one document read must say which cut its bytes came from.
// canonical V1 (accepted projection) and worker V2 (live authored copy / execution workspace) may
// coexist; each read labels its own source, digest, size and media type, and an execution
// observation is only observable while the execution holds an effective lease.
import assert from "node:assert/strict";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Text } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { type RepoCellBinding } from "../src/repo-cell.ts";
import {
  readTaskWorktreeExecutionBinding,
  taskWorktreeExecutionBindingPath,
  writeTaskWorktreeExecutionBinding,
} from "../src/task-worktree.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;

interface DocumentRead {
  readonly status: string;
  readonly source: string;
  readonly syncState: string;
  readonly body: string;
  readonly blobSha256: string | null;
  readonly contentKind: string;
  readonly mediaType: string | null;
  readonly size: number | null;
  readonly bytes: string | null;
  readonly repositoryPath: string;
  readonly worktreeBody: string | null;
  readonly uncommitted: boolean;
  readonly canonicalVersion: {
    readonly workspaceRevision: number;
    readonly blobSha256: string;
    readonly size: number;
  } | null;
  readonly execution: {
    readonly executionId: string;
    readonly leaseVersion: number;
    readonly leaseExpiresAt: string;
    readonly observedAt: string;
  } | null;
  readonly unobservableReason: string | null;
}

const taskId = "task-doc-sources",
  executionId = "execution-doc-sources",
  V1_APPENDIX = "Canonical V1 body.",
  V2_APPENDIX = "Worker V2 body.";

async function startTaskWithTwoCuts(options: { readonly startBinding?: RepoCellBinding } = {}) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-sources-")),
    repoId = workspaceId("task-doc-sources");
  initRepo(rootDir);
  const cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: repoId }),
    binding: RepoCellBinding = withPolicyGroup({ actor, source: "local" }, "admin"),
    created = (await cell.run({ kind: "task-create", taskId, title: "Document sources" }, binding)) as {
      readonly outcome: string;
      readonly opId: string;
      readonly packagePath: string;
    };
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  await waitForFixturePublication(cell, created.opId, binding);
  const packagePath = created.packagePath;
  await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
    cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
  );
  const planPath = path.join(rootDir, "harness", packagePath, "task_plan.md"),
    canonicalBody = readFileSync(planPath, "utf8");
  // The fixture submits the scaffold. Append the two distinct cuts so canonical V1 and the live
  // authored V2 cannot be confused by sharing their whole body.
  const v1Body = `${canonicalBody}\n## Worker Notes\n\n${V1_APPENDIX}\n`,
    v2Body = `${canonicalBody}\n## Worker Notes\n\n${V2_APPENDIX}\n`;
  writeFileSync(planPath, v1Body);
  const submitted = await cell.run({ kind: "doc-submit", paths: [`${packagePath}/task_plan.md`] }, binding);
  assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
  const started = await cell.run({ kind: "task-start", taskId, executionId }, options.startBinding ?? binding);
  assert.equal(started.outcome, "applied", JSON.stringify(started));
  await waitForFixturePublication(cell, started.opId, binding);
  writeFileSync(planPath, v2Body);
  // The execution observes its own materialized worktree when the task has one; write the same V2
  // there so the two cuts differ in the workspace the execution view is allowed to read.
  for (const worktree of worktreeRoots(rootDir)) {
    const workerPlan = path.join(worktree, "harness", packagePath, "task_plan.md");
    if (workerPlan !== planPath && existsSync(workerPlan)) writeFileSync(workerPlan, v2Body);
  }
  return { cell, binding, rootDir, packagePath, planPath, v1Body, v2Body };
}

test("canonical V1 and worker V2 reads each label the source that owns their bytes", async () => {
  const fixture = await startTaskWithTwoCuts();
  try {
    const canonical = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
    })) as DocumentRead;
    assert.equal(canonical.source, "canonical");
    assert.equal(canonical.syncState, "unsynced", "the live copy differs from the accepted cut");
    assert.equal(canonical.body, fixture.v1Body, "the default read still returns the accepted cut");
    assert.equal(canonical.blobSha256, sha256Text(fixture.v1Body));
    assert.equal(canonical.size, Buffer.byteLength(fixture.v1Body));
    assert.equal(canonical.bytes, null, "a text document carries no byte channel");
    assert.equal(canonical.worktreeBody, fixture.v2Body, "the live authored copy stays visible");
    assert.equal(canonical.uncommitted, true);
    assert.equal(canonical.canonicalVersion?.blobSha256, sha256Text(fixture.v1Body));
    assert.equal(canonical.canonicalVersion?.size, Buffer.byteLength(fixture.v1Body));

    const strictCanonical = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "canonical",
    })) as DocumentRead;
    assert.equal(strictCanonical.source, "canonical");
    assert.equal(strictCanonical.body, fixture.v1Body);
    assert.equal(strictCanonical.blobSha256, sha256Text(fixture.v1Body));

    const authored = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "authored-copy",
    })) as DocumentRead;
    assert.equal(authored.source, "authored-copy");
    assert.equal(authored.syncState, "unsynced");
    assert.equal(authored.body, fixture.v2Body);
    assert.equal(authored.blobSha256, sha256Text(fixture.v2Body), "the digest is the digest of the returned bytes");
    assert.equal(authored.size, Buffer.byteLength(fixture.v2Body));
    assert.equal(authored.canonicalVersion?.blobSha256, sha256Text(fixture.v1Body));

    const execution = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId,
    })) as DocumentRead;
    assert.equal(execution.source, "execution");
    assert.equal(execution.syncState, "unsynced");
    assert.equal(execution.body, fixture.v2Body);
    assert.equal(execution.blobSha256, sha256Text(fixture.v2Body));
    assert.equal(execution.size, Buffer.byteLength(fixture.v2Body));
    assert.equal(execution.execution?.executionId, executionId);
    assert.ok(Number(execution.execution?.leaseVersion) > 0);
    assert.match(String(execution.execution?.leaseExpiresAt), /^\d{4}-\d{2}-\d{2}T/u);
    assert.match(String(execution.execution?.observedAt), /^\d{4}-\d{2}-\d{2}T/u);
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("an execution observation without an effective lease is unobservable", async () => {
  const fixture = await startTaskWithTwoCuts();
  try {
    const released = await fixture.cell.run({ kind: "task-release", taskId }, fixture.binding);
    assert.equal(released.outcome, "applied", JSON.stringify(released));

    const unobservable = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId,
    })) as DocumentRead;
    assert.equal(unobservable.source, "unobservable");
    assert.equal(unobservable.syncState, "unobservable");
    assert.equal(unobservable.unobservableReason, "execution_not_leased");
    assert.equal(unobservable.blobSha256, null, "no digest may describe content this read did not observe");
    assert.equal(unobservable.size, null);
    assert.equal(unobservable.bytes, null);
    assert.equal(unobservable.body, "");
    assert.equal(unobservable.execution, null);

    const foreign = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId: "execution-somebody-else",
    })) as DocumentRead;
    assert.equal(foreign.source, "unobservable");
    assert.equal(foreign.syncState, "unobservable");
    assert.equal(foreign.unobservableReason, "execution_not_found");
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("a missing authored copy is unobservable, not a clean workspace", async () => {
  const fixture = await startTaskWithTwoCuts();
  try {
    rmSync(fixture.planPath);
    const canonical = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
    })) as DocumentRead;
    assert.equal(canonical.source, "canonical");
    assert.equal(canonical.body, fixture.v1Body);
    assert.equal(canonical.blobSha256, sha256Text(fixture.v1Body));
    assert.equal(canonical.worktreeBody, null);
    // The legacy boolean cannot tell "same bytes" from "no file to compare"; the explicit state can.
    assert.equal(canonical.uncommitted, false);
    assert.equal(canonical.syncState, "unobservable");
    assert.equal(canonical.unobservableReason, "authored_copy_not_observed");

    const authored = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "authored-copy",
    })) as DocumentRead;
    assert.equal(authored.source, "unobservable");
    assert.equal(authored.syncState, "unobservable");
    assert.equal(authored.unobservableReason, "authored_copy_not_observed");
    assert.equal(authored.blobSha256, null);
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("a remote lease never relabels the center's local worktree as its observation", async () => {
  const remoteBinding: RepoCellBinding = withPolicyGroup(
    { actor, source: { kind: "node" as const, nodeId: "edge-remote" } },
    "admin",
  );
  const fixture = await startTaskWithTwoCuts({ startBinding: remoteBinding });
  try {
    // The center still has a materialized worktree with a V2 copy from this fixture; the lease,
    // however, belongs to edge-remote. That local copy cannot be presented as edge-remote's view.
    const observed = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId,
    })) as DocumentRead;
    assert.equal(observed.source, "unobservable");
    assert.equal(observed.syncState, "unobservable");
    assert.equal(observed.unobservableReason, "execution_owner_not_local");
    assert.equal(observed.body, "");
    assert.equal(observed.blobSha256, null);
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("a stale or missing worktree execution marker is unobservable", async () => {
  const fixture = await startTaskWithTwoCuts();
  try {
    const worktree = worktreeRoots(fixture.rootDir).find(
      (root) => root !== fixture.rootDir && existsSync(path.join(root, "harness", fixture.packagePath, "task_plan.md")),
    );
    assert.ok(worktree, "the fixture must have a materialized execution worktree");
    assert.equal(readTaskWorktreeExecutionBinding(worktree)?.executionId, executionId);

    writeTaskWorktreeExecutionBinding(worktree, taskId, "execution-stale");
    const stale = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId,
    })) as DocumentRead;
    assert.equal(stale.source, "unobservable");
    assert.equal(stale.unobservableReason, "execution_workspace_unbound");
    assert.equal(stale.body, "");

    rmSync(taskWorktreeExecutionBindingPath(worktree));
    const missing = (await fixture.cell.read("repo.tasks.document.read", {
      taskId,
      path: "task_plan.md",
      view: "execution",
      executionId,
    })) as DocumentRead;
    assert.equal(missing.source, "unobservable");
    assert.equal(missing.unobservableReason, "execution_workspace_unbound");
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Task Doc Sources Test");
  git(rootDir, "config", "user.email", "task-doc-sources@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
}

function git(rootDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}

function worktreeRoots(rootDir: string): readonly string[] {
  return execFileSync("git", ["-C", rootDir, "worktree", "list", "--porcelain"], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
}
