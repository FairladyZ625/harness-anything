// harness-test-tier: integration
import assert from "node:assert/strict";
import { removeTempStoreRoot } from "../../kernel/test/store/helpers.ts";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, type TaskProjection } from "@harness-anything/kernel";
import { runDocAction } from "../src/doc-sync-actions.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

// Agenda B13/B22: a dispatched worker updates an artifact that already exists in its own task
// package, and the update reaches the center through the one authorized doc channel. The worktree
// mirror shares hard links with the canonical ledger, so an editor that replaces a file atomically
// leaves the canonical copy stale; `task submit` already read the worktree (#3926), and `doc sync`
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

test("doc sync carries a worker's atomic replacement of an existing own-package artifact", async () => {
  const fixture = await ownPackageFixture("sync"),
    body = "# Worker artifact v2\n\nrewritten in the worktree\n";
  try {
    assert.equal(statSync(fixture.workerArtifact).ino, statSync(fixture.canonicalArtifact).ino);
    // Editors write atomically: the replacement breaks the worktree/center hard link and only the
    // worktree copy holds the authored bytes.
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
    removeTempStoreRoot(fixture.rootDir);
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
    assert.match(String(collision.rejectionExplanation), /ha doc sync --submit --path .*artifacts\/worker-owned\.md/u);

    writeFileSync(fixture.workerArtifact, body);
    const receipt = await fixture.cell.run({ kind: "doc-submit", paths: [`harness/${fixture.artifactPath}`] }, holder);
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    await waitForFixturePublication(fixture.cell, receipt.opId, holder);
    assert.equal(readFileSync(fixture.canonicalArtifact, "utf8"), body);
  } finally {
    await fixture.cell.close();
    removeTempStoreRoot(fixture.rootDir);
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
  } finally {
    removeTempStoreRoot(rootDir);
  }
});
