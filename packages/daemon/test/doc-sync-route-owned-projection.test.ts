// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { git, initRepo, rows, write } from "./doc-sync-slice-a.fixtures.ts";

// Route-owned documents (progress.md, INDEX.md, …) are projections of their owning event routes.
// A local rewrite must never wedge the doc channel: the scanner rebuilds the worktree copy from
// the canonical projection and the submit carries on without an owner restoring the file by hand.
test("a hand-edited or deleted progress projection is rebuilt from the canonical document", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-owned-proj-"));
  initRepo(rootDir);
  const repoId = workspaceId("owned-proj"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "owned-proj-daemon",
    }),
    person = withPolicyGroup(
      {
        actor: {
          principal: { personId: "person-owner" },
          executor: { kind: "agent", id: "codex" },
        },
        source: "local" as const,
      },
      "admin",
    ),
    taskId = "task-owned-projection";
  try {
    const created = (await cell.run(
        { kind: "task-create", taskId, title: "hand-edited progress projection" },
        person,
      )) as { packagePath?: string; opId?: string },
      packagePath = created.packagePath!;
    await waitForWorktree(cell, { opId: String(created.opId) }, person);
    await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
      cell.run({ kind: "doc-submit", paths: [planPath] }, person),
    );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId, executionId: "exec-owned-proj" }, person)).outcome,
      "applied",
    );
    const appended = (await cell.run({ kind: "task-progress-append", taskId, text: "canonical entry" }, person)) as {
      opId?: string;
    };
    await waitForWorktree(cell, { opId: String(appended.opId) }, person);
    const progressFile = path.join(rootDir, "harness", packagePath, "progress.md"),
      canonical = readFileSync(progressFile, "utf8");

    // The worker's hand edit: notes that belong in `ha task progress`, written straight into the file.
    writeFileSync(progressFile, "worker scribbles that belong in ha task progress\n");
    const synced = (await cell.run({ kind: "doc-submit", taskId }, person)) as {
      outcome?: string;
      code?: string;
      summary?: string;
    };
    assert.equal(synced.outcome, "no_changes", JSON.stringify(synced));
    assert.equal(readFileSync(progressFile, "utf8"), canonical, "the projection is rebuilt, not compared");
    assert.equal(
      git(rootDir, "status", "--porcelain=v1", "--", `harness/${packagePath}/progress.md`),
      "",
      "no owner-side git checkout is left to do",
    );
    assert.match(
      String(synced.summary),
      new RegExp(`rebuilt \\(route-owned projections[\\s\\S]*${packagePath}/progress\\.md`, "u"),
    );
    // The rebuilt file is no longer dirty, so an explicit selection is how the next scan sees it.
    const status = await cell.run({ kind: "doc-status", paths: [`${packagePath}/progress.md`] }, person),
      row = rows(status.evidence).find((candidate) => candidate.path === `${packagePath}/progress.md`);
    assert.equal(row?.state, "clean");

    // The same drift as a deletion heals identically: the canonical body comes back.
    rmSync(progressFile);
    const restored = (await cell.run({ kind: "doc-submit", taskId }, person)) as { outcome?: string };
    assert.equal(restored.outcome, "no_changes", JSON.stringify(restored));
    assert.equal(readFileSync(progressFile, "utf8"), canonical);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// The 2026-10-19 friction (W2): after every real deliverable was already synced, a hand-edited
// progress.md was the only dirty path, so `ha task submit`'s internal doc-submit reported
// preview_blocked and the cut could not land without the owner restoring the file.
test("task submit lands without owner recovery after a worker hand-edits progress.md", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-owned-submit-"));
  initRepo(rootDir);
  const repoId = workspaceId("owned-submit"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "owned-submit-daemon",
    }),
    person = withPolicyGroup(
      {
        actor: {
          principal: { personId: "person-owner" },
          executor: { kind: "agent", id: "codex" },
        },
        source: "local" as const,
      },
      "admin",
    ),
    taskId = "task-owned-submit";
  try {
    const created = (await cell.run(
        { kind: "task-create", taskId, title: "submit past a hand-edited projection" },
        person,
      )) as { packagePath?: string; opId?: string },
      packagePath = created.packagePath!;
    await waitForWorktree(cell, { opId: String(created.opId) }, person);
    await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
      cell.run({ kind: "doc-submit", paths: [planPath] }, person),
    );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId, executionId: "exec-owned-submit" }, person)).outcome,
      "applied",
    );
    const appended = (await cell.run({ kind: "task-progress-append", taskId, text: "canonical entry" }, person)) as {
      opId?: string;
    };
    await waitForWorktree(cell, { opId: String(appended.opId) }, person);
    const progressFile = path.join(rootDir, "harness", packagePath, "progress.md"),
      canonical = readFileSync(progressFile, "utf8"),
      prBody = `${packagePath}/artifacts/pr-body.md`;
    write(rootDir, prBody, "# PR body\n");
    const artifactSync = (await cell.run({ kind: "doc-submit", paths: [prBody] }, person)) as {
      opId?: string;
      outcome?: string;
      revision?: number;
    };
    assert.equal(artifactSync.outcome, "applied", JSON.stringify(artifactSync));
    await waitForWorktree(cell, { opId: String(artifactSync.opId) }, person);
    write(
      rootDir,
      `${packagePath}/closeout.md`,
      `# Closeout\n\n## Summary\n\nDelivered artifact:${prBody}@${artifactSync.revision}\n\n` +
        "## Verification\n\nIntegration assertions exercise the submit path.\n\n" +
        "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNot applicable to this fixture.\n",
    );
    assert.equal(
      (await cell.run({ kind: "doc-submit", paths: [`${packagePath}/closeout.md`] }, person)).outcome,
      "applied",
    );
    // The worker's hand edit is now the only dirty path in the package.
    writeFileSync(progressFile, "notes for the owner\n");
    const submitted = (await cell.run({ kind: "task-submit", taskId }, person)) as {
      outcome?: string;
      code?: string;
    };
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.equal(readFileSync(progressFile, "utf8"), canonical);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function waitForWorktree(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  receipt: { readonly opId: string },
  binding: Parameters<Awaited<ReturnType<typeof openRepoCell>>["run"]>[1],
) {
  const shown = await cell.run(
    { kind: "receipt-show", opId: receipt.opId, waitFor: ["accepted_durable", "worktree_visible"], timeoutMs: 5_000 },
    binding,
  );
  assert.equal(shown.status, "accepted_durable", JSON.stringify(shown));
  assert.equal(shown.wait?.state, "satisfied", JSON.stringify(shown));
  return shown;
}
