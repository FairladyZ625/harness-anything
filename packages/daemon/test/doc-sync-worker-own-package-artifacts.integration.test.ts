// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/storage";
import { type TaskProjection } from "@harness-anything/kernel";
import { runDocAction } from "../src/doc-sync-actions.ts";
import { scannerRead, scannerSubmit } from "../src/doc-sync-adjudication.ts";
import { taskWorktreeDocumentBase } from "../src/worktree-setup.ts";
import { runtimeExecutionActor } from "../src/runtime-execution-credential.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

// Agenda B13/B22: a dispatched worker updates an artifact that already exists in its own task
// package, and the update reaches the center through the one authorized doc channel. The worktree
// mirror keeps independent copies of the canonical ledger; `task submit` reads the worktree, and `doc sync`
// must read the same candidate inventory or the worker's own package edit silently reports no_changes.
const holder = withPolicyGroup(
  {
    actor: { principal: { personId: "owner" }, executor: { kind: "agent" as const, id: "worker" } },
    source: "local" as const,
  },
  "admin",
);

async function ownPackageFixture(label: string) {
  const rootDir = mkdtempSync(path.join(tmpdir(), `ha-own-package-${label}-`)),
    ledger = path.join(rootDir, "harness"),
    taskId = `task-own-package-${label}`,
    executionId = `execution-own-package-${label}`,
    repoId = workspaceId(`own-package-${label}`);
  initRepo(rootDir);
  git(rootDir, "branch", "-M", "main");
  writeFileSync(path.join(rootDir, ".gitignore"), "harness/\n.harness/\n.worktrees/\n");
  git(rootDir, "add", ".gitignore");
  git(rootDir, "commit", "-qm", "test: fixture exclusions");
  mkdirSync(ledger);
  initRepo(ledger);
  writeFileSync(path.join(ledger, "harness.yaml"), "settings:\n  closeout:\n    profile: strict\n");
  const cell = await openBootstrappedRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: `own-package-${label}-fixture`,
    }),
    created = await cell.run({ kind: "task-create", taskId, title: `Own package ${label}` }, holder);
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  await waitForFixturePublication(cell, created.opId, holder);
  const packagePath = String((created as { readonly packagePath?: string }).packagePath);
  await realizeTaskPlanFixture(
    rootDir,
    packagePath,
    async (documentPath) => {
      const receipt = await cell.run({ kind: "doc-submit", paths: [documentPath] }, holder);
      await waitForFixturePublication(cell, receipt.opId, holder);
      return receipt;
    },
    `Own package ${label}`,
  );
  const artifactPath = `${packagePath}/artifacts/worker-owned.md`,
    canonicalArtifact = path.join(ledger, artifactPath),
    original = "# Worker artifact v1\n";
  mkdirSync(path.dirname(canonicalArtifact), { recursive: true });
  writeFileSync(canonicalArtifact, original);
  const seeded = await cell.run({ kind: "doc-submit", paths: [artifactPath] }, holder);
  assert.equal(seeded.outcome, "applied", JSON.stringify(seeded));
  await waitForFixturePublication(cell, seeded.opId, holder);
  const started = await cell.run({ kind: "task-start", taskId, executionId }, holder);
  assert.equal(started.outcome, "applied", JSON.stringify(started));
  await waitForFixturePublication(cell, started.opId, holder);
  return {
    rootDir,
    ledger,
    repoId,
    taskId,
    executionId,
    packagePath,
    artifactPath,
    canonicalArtifact,
    workerArtifact: path.join(rootDir, ".worktrees", taskId, "harness", artifactPath),
    cell,
  };
}

test("runtime doc sync writes a granted non-task surface with the execution lease", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-sync-runtime-surface-"));
  type TestEvent = {
    readonly opId: string;
    readonly workspaceRevision: number;
    readonly payload: {
      readonly executionId: string | null;
      readonly changes: readonly {
        readonly path: string;
        readonly baseBlobSha256: string | null;
        readonly policyId: string;
        readonly candidate: { readonly sha256: string; readonly size: number; readonly mediaType: string } | null;
      }[];
    };
  };
  let revision = 1,
    submittedEvent: TestEvent | null = null,
    submittedBody = "",
    projectedDocument: { readonly path: string; readonly blobSha256: string } | null = null;
  const authoredPath = "skills/test-isolation/SKILL.md",
    repoId = workspaceId("doc-sync-runtime-surface"),
    taskId = "task-doc-sync-runtime-surface",
    executionId = "execution-doc-sync-runtime-surface",
    runtimeSessionId = "runtime-doc-sync-surface",
    principal = {
      personId: "owner",
      repoId,
      runtimeSessionId,
      dispatchId: "dispatch-doc-sync-runtime-surface",
      taskId,
      executionId,
      role: "implementation" as const,
      surfaces: ["harness/skills/test-isolation/**"],
      source: "local" as const,
      expiresAt: "2026-11-03T01:00:00.000Z",
    },
    actor = runtimeExecutionActor(principal),
    lease = {
      schema: "lease/v1" as const,
      taskId,
      executionId,
      actor,
      source: "local" as const,
      phase: "held" as const,
      expiresAt: "2026-11-03T01:00:00.000Z",
      version: 1,
    },
    headDigest = `sha256:${"a".repeat(64)}`,
    cut = () => ({ repoId, revision, headDigest }),
    store = {
      currentCut: cut,
      readHead: () => ({ revision }),
      ledgerMetadata: () => ({ generation: 1 }),
      readEvent: (opId: string) => (submittedEvent?.opId === opId ? submittedEvent : null),
      append: (value: unknown) => {
        const commit = value as {
          readonly event: TestEvent;
          readonly blobs: readonly { readonly body: string | Uint8Array }[];
        };
        submittedEvent = commit.event;
        submittedBody =
          typeof commit.blobs[0]?.body === "string"
            ? commit.blobs[0].body
            : Buffer.from(commit.blobs[0]?.body ?? new Uint8Array()).toString("utf8");
        revision = commit.event.workspaceRevision;
      },
      publication: () => ({ commitSha: null }),
    } as never,
    projection = {
      taskIdForDocumentPath: () => null,
      currentLeaseForExecution: (candidate: string) => (candidate === executionId ? lease : null),
      readRuntimeSession: (candidate: string) =>
        candidate === runtimeSessionId
          ? {
              schema: "runtime-session/v1",
              runtimeSessionId,
              taskBindings: [{ taskId, executionId }],
            }
          : null,
      readDocument: () => ({
        document: projectedDocument,
        sourceRevision: revision,
        watermark: revision,
        status: "ready" as const,
      }),
      readTaskStatuses: () => ({ rows: [] }),
      readOperation: () => null,
      apply: (event: TestEvent) => {
        const change = event.payload.changes[0];
        projectedDocument =
          change?.candidate === null || change?.candidate === undefined
            ? null
            : { path: change.path, blobSha256: change.candidate.sha256 };
        revision = event.workspaceRevision;
      },
    } as unknown as TaskProjection,
    input = {
      action: { kind: "doc-dry-run", paths: [authoredPath] },
      binding: { ...holder, actor, executionPrincipal: principal },
      rootDir,
      workspaceId: repoId,
      store,
      projection,
      now: () => "2026-11-03T00:00:00.000Z",
    };
  try {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    initRepo(path.join(rootDir, "harness"));
    const target = path.join(rootDir, "harness", authoredPath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "# Granted surface\n\nWorker update.\n");

    const dryRun = scannerRead(input),
      submit = scannerSubmit({ ...input, action: { kind: "doc-submit", paths: [authoredPath] } });
    assert.equal(dryRun.rows[0]?.state, "eligible", JSON.stringify(dryRun.rows[0]));
    assert.equal(dryRun.executionId, executionId);
    assert.equal(dryRun.lease?.taskId, taskId);
    assert.equal(submit.rows[0]?.state, "eligible", JSON.stringify(submit.rows[0]));
    assert.equal(submit.executionId, executionId);
    assert.equal(submit.lease?.taskId, taskId);

    const receipt = await runDocAction({
      ...input,
      action: { kind: "doc-submit", paths: [authoredPath] },
      binding: { ...input.binding, authorizationDecision: { outcome: "allowed" } as never },
    });
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.equal(submittedEvent?.payload.executionId, executionId);
    assert.equal(submittedBody, "# Granted surface\n\nWorker update.\n");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a worker materializes an owner-declared non-task document surface", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-own-package-surface-"));
  initRepo(rootDir);
  const selected: { paths?: readonly string[] } = {};
  const input = (surfaces: readonly string[]) => ({
    action: { kind: "doc-materialize", paths: ["harness/skills/test-isolation/dispatch-isolated-test.mjs"] },
    binding: {
      ...holder,
      executionPrincipal: {
        personId: "owner",
        repoId: workspaceId("own-package-surface"),
        runtimeSessionId: "runtime-own-package-surface",
        dispatchId: "dispatch-own-package-surface",
        taskId: "task-own-package-surface",
        executionId: "execution-own-package-surface",
        role: "implementation" as const,
        surfaces,
        source: "local" as const,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    },
    workspaceId: workspaceId("own-package-surface"),
    rootDir,
    store: {
      materialize: (options?: { readonly paths?: readonly string[] }) => {
        selected.paths = options?.paths;
        return { commitSha: { sha: "surface-materialize" }, settlements: [], conflicts: [] };
      },
      readHead: () => ({ revision: 4 }),
      followerStatus: () => ({ worktree: { status: "verified" } }),
      currentCut: () => "surface-materialize",
    } as never,
    projection: { taskIdForDocumentPath: () => null } as unknown as TaskProjection,
    now: () => new Date().toISOString(),
  });
  try {
    const receipt = await runDocAction(input(["harness/skills/test-isolation/**"]));

    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.deepEqual(selected.paths, ["harness/skills/test-isolation/dispatch-isolated-test.mjs"]);
    assert.throws(() => runDocAction(input([])), { code: "execution_credential_rejected" });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doc sync carries a worker's atomic replacement of an existing own-package artifact", async () => {
  const fixture = await ownPackageFixture("sync"),
    body = "# Worker artifact v2\n\nrewritten in the worktree\n";
  try {
    assert.notEqual(statSync(fixture.workerArtifact).ino, statSync(fixture.canonicalArtifact).ino);
    // Only the worker copy holds authored bytes, including after an editor replaces it atomically.
    const scratch = `${fixture.workerArtifact}.tmp`;
    writeFileSync(scratch, body);
    renameSync(scratch, fixture.workerArtifact);
    assert.notEqual(statSync(fixture.workerArtifact).ino, statSync(fixture.canonicalArtifact).ino);
    assert.notEqual(readFileSync(fixture.canonicalArtifact, "utf8"), body);

    const receipt = await fixture.cell.run({ kind: "doc-submit", paths: [`harness/${fixture.artifactPath}`] }, holder);
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    await waitForFixturePublication(fixture.cell, receipt.opId, holder);
    assert.equal(readFileSync(fixture.canonicalArtifact, "utf8"), body);
    const event = makeTaskEventReader({ repoId: fixture.repoId, rootDir: fixture.rootDir }).readEvent(receipt.opId);
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema === "doc-event/v1")
      assert.equal(event.payload.changes[0]?.path, fixture.artifactPath, "the tracked task-package path is rewritten");
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("artifact add refuses an existing destination and names the base-sha doc channel that applies it", async () => {
  const fixture = await ownPackageFixture("artifact-add"),
    body = "# Worker artifact v3\n\napplied through the named route\n";
  try {
    const collision = await fixture.cell.run(
      {
        kind: "task-artifact-add",
        taskId: fixture.taskId,
        content: body,
        destination: "artifacts/worker-owned.md",
      },
      holder,
    );
    assert.equal(collision.code, "artifact_collision", JSON.stringify(collision));
    const explanation = String(collision.rejectionExplanation);
    assert.ok(
      explanation.includes(`the published copy harness/${fixture.artifactPath} is the source of truth`),
      explanation,
    );
    assert.match(
      explanation,
      /Edit it in place, then update it with ha doc sync --submit --path .*artifacts\/worker-owned\.md/u,
    );

    writeFileSync(fixture.workerArtifact, body);
    const receipt = await fixture.cell.run({ kind: "doc-submit", paths: [`harness/${fixture.artifactPath}`] }, holder);
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    await waitForFixturePublication(fixture.cell, receipt.opId, holder);
    assert.equal(readFileSync(fixture.canonicalArtifact, "utf8"), body);
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("a worker's path selection that leaves its task package stays a cross-task rejection", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-own-package-foreign-"));
  initRepo(rootDir);
  mkdirSync(path.join(rootDir, "harness"));
  initRepo(path.join(rootDir, "harness"));
  try {
    await assert.rejects(
      async () =>
        runDocAction({
          action: { kind: "doc-submit", paths: ["harness/tasks/task-someone-else-artifacts/artifacts/report.md"] },
          binding: {
            ...holder,
            executionPrincipal: {
              personId: "owner",
              repoId: workspaceId("own-package-foreign"),
              runtimeSessionId: "runtime-own-package-foreign",
              dispatchId: "dispatch-own-package-foreign",
              taskId: "task-own-package-foreign",
              executionId: "execution-own-package-foreign",
              role: "implementation",
              surfaces: ["harness/tasks/**"],
              source: "local",
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            },
          },
          workspaceId: workspaceId("own-package-foreign"),
          rootDir,
          store: {} as never,
          projection: {
            taskIdForDocumentPath: (value: string) =>
              value.startsWith("tasks/task-own-package-foreign") ? "task-own-package-foreign" : null,
          } as unknown as TaskProjection,
          now: () => new Date().toISOString(),
        }),
      { code: "execution_credential_rejected" },
    );
    await assert.rejects(
      async () =>
        runDocAction({
          action: { kind: "doc-materialize", paths: ["harness/tasks/task-someone-else-artifacts/artifacts/report.md"] },
          binding: {
            ...holder,
            executionPrincipal: {
              personId: "owner",
              repoId: workspaceId("own-package-foreign"),
              runtimeSessionId: "runtime-own-package-foreign",
              dispatchId: "dispatch-own-package-foreign",
              taskId: "task-own-package-foreign",
              executionId: "execution-own-package-foreign",
              role: "implementation",
              surfaces: ["harness/tasks/**"],
              source: "local",
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            },
          },
          workspaceId: workspaceId("own-package-foreign"),
          rootDir,
          store: {} as never,
          projection: {
            taskIdForDocumentPath: () => null,
          } as unknown as TaskProjection,
          now: () => new Date().toISOString(),
        }),
      { code: "execution_credential_rejected" },
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("accepted worktree documents advance their bases across edits and an acknowledgement retry", async () => {
  const fixture = await ownPackageFixture("sequential"),
    taskRoot = path.join(fixture.rootDir, ".worktrees", fixture.taskId);
  try {
    const sync = async () => {
      const receipt = await fixture.cell.run({ kind: "doc-submit", taskId: fixture.taskId }, holder);
      if (receipt.outcome === "applied") await waitForFixturePublication(fixture.cell, receipt.opId, holder);
      return receipt;
    };
    for (const body of ["# First edit\n", "# Second edit\n"]) {
      writeFileSync(fixture.workerArtifact, body);
      assert.equal(
        readFileSync(fixture.canonicalArtifact, "utf8"),
        body === "# First edit\n" ? "# Worker artifact v1\n" : "# First edit\n",
      );
      const status = await fixture.cell.run({ kind: "doc-status", taskId: fixture.taskId }, holder);
      assert.match(String(status.summary), /eligible: 1/u, "status reads independent worker copies too");
      const receipt = await sync();
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      assert.equal(readFileSync(fixture.canonicalArtifact, "utf8"), body);
    }
    // A pre-fix execution may have accepted several edits without any node-local bases.
    unlinkSync(taskWorktreeDocumentBase(taskRoot, fixture.artifactPath));
    writeFileSync(fixture.workerArtifact, "# Legacy continuation\n");
    const continued = await sync();
    assert.equal(continued.outcome, "applied", JSON.stringify(continued));
    assert.equal(readFileSync(fixture.canonicalArtifact, "utf8"), "# Legacy continuation\n");
    // Canonical acceptance survives even if a crash loses the local acknowledgement.
    writeFileSync(taskWorktreeDocumentBase(taskRoot, fixture.artifactPath), "# Worker artifact v1\n");
    assert.equal((await sync()).outcome, "no_changes");
    writeFileSync(fixture.workerArtifact, "# Third edit\n");
    const receipt = await sync();
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.equal(readFileSync(fixture.canonicalArtifact, "utf8"), "# Third edit\n");
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("a missing worktree base recovers this task execution's accepted version for a worker edit", async () => {
  const fixture = await ownPackageFixture("missing-base");
  try {
    const taskRoot = path.join(fixture.rootDir, ".worktrees", fixture.taskId);
    writeFileSync(fixture.workerArtifact, "# Accepted in this execution\n");
    const accepted = await fixture.cell.run({ kind: "doc-submit", taskId: fixture.taskId }, holder);
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    await waitForFixturePublication(fixture.cell, accepted.opId, holder);
    unlinkSync(taskWorktreeDocumentBase(taskRoot, fixture.artifactPath));
    writeFileSync(fixture.workerArtifact, "# Edited without a known base\n");
    const receipt = await fixture.cell.run({ kind: "doc-submit", taskId: fixture.taskId }, holder);
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    await waitForFixturePublication(fixture.cell, receipt.opId, holder);
    assert.equal(readFileSync(fixture.canonicalArtifact, "utf8"), "# Edited without a known base\n");
    assert.equal(readFileSync(fixture.workerArtifact, "utf8"), "# Edited without a known base\n");
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

for (const selection of ["task", "paths"] as const) {
  test(`an acknowledged worker copy cannot hide a canonical edit selected by ${selection}`, async () => {
    const fixture = await ownPackageFixture(`canonical-edit-${selection}`);
    try {
      const acceptedBody = "# Accepted worker edit\n",
        canonicalEdit = "# Subsequent canonical edit\n",
        action = selection === "task" ? { taskId: fixture.taskId } : { paths: [fixture.artifactPath] };
      writeFileSync(fixture.workerArtifact, acceptedBody);
      const accepted = await fixture.cell.run({ kind: "doc-submit", ...action }, holder);
      assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
      await waitForFixturePublication(fixture.cell, accepted.opId, holder);
      // Canonical acceptance survived, but the node lost its local acknowledgement.
      writeFileSync(
        taskWorktreeDocumentBase(path.join(fixture.rootDir, ".worktrees", fixture.taskId), fixture.artifactPath),
        "# Worker artifact v1\n",
      );
      writeFileSync(fixture.canonicalArtifact, canonicalEdit);
      const status = await fixture.cell.run({ kind: "doc-status", ...action }, holder);
      assert.match(String(status.summary), /eligible: 1/u, JSON.stringify(status));
      const synced = await fixture.cell.run({ kind: "doc-submit", ...action }, holder);
      assert.equal(synced.outcome, "applied", JSON.stringify(synced));
      await waitForFixturePublication(fixture.cell, synced.opId, holder);
      assert.equal(readFileSync(fixture.canonicalArtifact, "utf8"), canonicalEdit);
      assert.equal(readFileSync(fixture.workerArtifact, "utf8"), acceptedBody);
    } finally {
      await fixture.cell.close();
      rmSync(fixture.rootDir, { recursive: true, force: true });
    }
  });
}

for (const document of ["artifact", "bootstrap"] as const) {
  test(`a same-author pre-execution ${document} write cannot supply an edited mirror's missing base`, async () => {
    const fixture = await ownPackageFixture(`unscoped-${document}`);
    try {
      const taskRoot = path.join(fixture.rootDir, ".worktrees", fixture.taskId),
        logical = document === "artifact" ? fixture.artifactPath : `${fixture.packagePath}/task_plan.md`,
        worker = path.join(taskRoot, "harness", logical),
        canonical = path.join(fixture.ledger, logical),
        original = readFileSync(canonical, "utf8");
      unlinkSync(taskWorktreeDocumentBase(taskRoot, logical));
      writeFileSync(worker, original + "\nExtra worker evidence without an execution acknowledgement.\n");
      const receipt = await fixture.cell.run({ kind: "doc-submit", taskId: fixture.taskId }, holder);
      assert.equal(receipt.code, "base_blob_changed", JSON.stringify(receipt));
      assert.equal(readFileSync(canonical, "utf8"), original);
    } finally {
      await fixture.cell.close();
      rmSync(fixture.rootDir, { recursive: true, force: true });
    }
  });
}

test("a task's accepted canonical write acknowledges later worker edits while its untouched mirror stays clean", async () => {
  const fixture = await ownPackageFixture("canonical-ack");
  try {
    writeFileSync(fixture.canonicalArtifact, "# Accepted canonical task edit\n");
    const accepted = await fixture.cell.run({ kind: "doc-submit", taskId: fixture.taskId }, holder);
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    await waitForFixturePublication(fixture.cell, accepted.opId, holder);
    assert.equal(readFileSync(fixture.workerArtifact, "utf8"), "# Worker artifact v1\n");
    const untouched = await fixture.cell.run({ kind: "doc-submit", taskId: fixture.taskId }, holder);
    assert.equal(untouched.outcome, "no_changes", JSON.stringify(untouched));
    assert.equal(readFileSync(fixture.canonicalArtifact, "utf8"), "# Accepted canonical task edit\n");
    writeFileSync(fixture.workerArtifact, "# Continued from worker\n");
    const continued = await fixture.cell.run({ kind: "doc-submit", taskId: fixture.taskId }, holder);
    assert.equal(continued.outcome, "applied", JSON.stringify(continued));
    await waitForFixturePublication(fixture.cell, continued.opId, holder);
    assert.equal(readFileSync(fixture.canonicalArtifact, "utf8"), "# Continued from worker\n");
  } finally {
    await fixture.cell.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});
