// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRealizedTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { resolveRepoBootstrap, type RepoBootstrapRequest } from "../src/repo-bootstrap.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";

const repoId = "ledger-guard";
const auth = {
  transportKind: "unix-socket",
  unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0, source: "unix-socket-filesystem-owner-boundary" },
} as unknown as DaemonAuthenticationContext;
const workerBinding = withRoleBinding(
  { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" as const },
  "repo-write",
);
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
/** A commit as a person would run it: no daemon writer marker, identity supplied inline. */
function personCommit(rootDir: string, message: string) {
  return spawnSync(
    "git",
    ["-C", rootDir, "-c", "user.name=Manual", "-c", "user.email=manual@example.com", "commit", "-m", message],
    { encoding: "utf8" },
  );
}

test("the ledger commit guard protects the ledger repository and leaves the project repository alone", async () => {
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-ledger-guard-"))),
    ledgerRoot = path.join(rootDir, "harness"),
    stateRoot = path.join(rootDir, "writer-epochs"),
    normalizedRepoId = workspaceId(repoId),
    authority = openPersistentWriterEpoch({ stateRoot, holderId: "ledger-guard-test" }),
    lease = authority.acquire(normalizedRepoId),
    writerEpochFence = {
      schema: "harness-writer-epoch-fence/v1" as const,
      stateRoot,
      repoId: normalizedRepoId,
      epoch: lease.epoch,
      holderId: lease.holderId,
    };
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.name", "Ledger Guard Test");
    git(rootDir, "config", "user.email", "ledger-guard@example.invalid");
    writeFileSync(path.join(rootDir, "README.md"), "# Project\n");
    git(rootDir, "add", "README.md");
    git(rootDir, "commit", "-qm", "project base");

    // The full `ha init` shape: bootstrap creates the ledger as its own repository, then attach.
    const request: RepoBootstrapRequest = { rootDir, repoId, personId: "owner", displayName: "Owner" };
    cell = await openRepoCell({
      repoId: normalizedRepoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "ledger-guard-test",
      bootstrap: resolveRepoBootstrap(request, auth),
      defaultWriterEpochFence: writerEpochFence,
    });
    assert.match(
      readFileSync(path.join(ledgerRoot, ".git", "hooks", "pre-commit"), "utf8"),
      /harness-ledger-commit-guard\/v1/u,
    );

    // Drop the hook bootstrap installed, then attach again: the attach path itself must
    // reinstall it in the ledger repository, never in the project repository.
    rmSync(path.join(ledgerRoot, ".git", "hooks", "pre-commit"));
    await cell.close();
    cell = await openRepoCell({
      repoId: normalizedRepoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "ledger-guard-test",
      defaultWriterEpochFence: writerEpochFence,
    });
    assert.match(
      readFileSync(path.join(ledgerRoot, ".git", "hooks", "pre-commit"), "utf8"),
      /harness-ledger-commit-guard\/v1/u,
    );

    // Negative control 1: a project commit passes untouched, with no guard installed there.
    assert.equal(existsSync(path.join(rootDir, ".git", "hooks", "pre-commit")), false);
    writeFileSync(path.join(rootDir, "delivery.md"), "# Delivered\n");
    git(rootDir, "add", "delivery.md");
    const projectCommit = personCommit(rootDir, "docs: fixture delivery");
    assert.equal(projectCommit.status, 0, projectCommit.stderr);
    assert.doesNotMatch(projectCommit.stderr, /Refusing a manual commit/u);

    // Positive control: a manual commit in the ledger repository is refused with a way out.
    writeFileSync(path.join(ledgerRoot, "note.md"), "manual\n");
    git(ledgerRoot, "add", "note.md");
    const ledgerCommit = personCommit(ledgerRoot, "manual ledger edit");
    assert.notEqual(ledgerCommit.status, 0);
    assert.match(ledgerCommit.stderr, /Refusing a manual commit in the Harness ledger repository/u);
    assert.match(ledgerCommit.stderr, /ha doc sync --submit --task <task-id>/u);

    // Negative control 2: the daemon's own ledger write goes through the coordinator untouched.
    const taskId = "task_ledger_guard",
      title = "Ledger Guard";
    await createRealizedTaskPlanFixture(
      rootDir,
      async () => {
        const created = await cell!.run({ kind: "task-create", taskId, title, presetId: "docs-task" }, workerBinding);
        const shown = await cell!.run(
          { kind: "receipt-show", opId: created.opId, waitFor: ["worktree_visible"], timeoutMs: 5_000 },
          workerBinding,
        );
        assert.equal(shown.wait?.state, "satisfied", JSON.stringify(shown));
        return created;
      },
      (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, workerBinding),
      title,
    );
  } finally {
    await cell?.close();
    authority.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
