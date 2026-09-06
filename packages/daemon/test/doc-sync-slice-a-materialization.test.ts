// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, makeTaskProjection } from "../../kernel/src/index.ts";
import { readDocReceipt } from "../src/doc-sync-actions.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

import { actor, git, initRepo, materializeReport, write } from "./doc-sync-slice-a.fixtures.ts";
test("a committed DocEvent reports pending with its stable receipt id until L2 reaches the event cut", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-pending-")),
    repoId = workspaceId("doc-pending"),
    binding = { actor, source: "local" as const };
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId,
    rootDir: canonicalRoot(rootDir),
    ownerId: "doc-pending",
  });
  try {
    await cell.run({ kind: "task-create", taskId: "task-pending", title: "Pending" }, binding);
    write(rootDir, "context/pending.md", "# Pending\n");
    const applied = await cell.run({ kind: "doc-submit", paths: ["context/pending.md"] }, binding);
    assert.equal(applied.outcome, "applied");
    await cell.close();
    const store = makeTaskEventReader({ repoId, rootDir }),
      event = store.readEvent(applied.opId);
    if (event?.schema !== "doc-event/v1") throw new Error("DocEvent missing");
    const projection = makeTaskProjection({
        rootDir,
        eventStore: store,
        projectionPath: path.join(rootDir, ".harness/pending.sqlite"),
        catchUpLimit: 1,
      }),
      pending = readDocReceipt(
        {
          binding,
          workspaceId: repoId,
          rootDir,
          store,
          projection,
          now: () => "2026-08-14T00:00:00.000Z",
        },
        event,
      );
    assert.equal(pending.outcome, "pending");
    assert.equal(pending.opId, event.opId);
    assert.equal(pending.proof?.committedRevision, event.workspaceRevision);
    assert.equal(pending.proof?.durable, true);
    assert.equal(pending.proof?.canonicalVisible, false);
    assert.deepEqual(pending.guidance, [{ kind: "retry-receipt", args: { opId: event.opId } }]);
    projection.close();
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("materialize reports an already settled SQLite follower without inventing acceptance", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-materialize-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
      repoId: workspaceId("materialize"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "materialize-daemon",
    }),
    binding = { actor, source: "local" as const };
  try {
    const created = await cell.run(
      {
        kind: "task-create",
        taskId: "task-materialize",
        title: "Materialize",
      },
      binding,
    );
    assert.equal(created.outcome, "applied");
    await waitForWorktree(cell, created);
    const packagePath = "tasks/task-materialize-materialize",
      taskRoot = path.join(rootDir, "harness", packagePath),
      prosePaths = [`${packagePath}/task_plan.md`, `${packagePath}/closeout.md`];
    for (const logical of prosePaths)
      write(
        rootDir,
        logical,
        `${readFileSync(path.join(rootDir, "harness", logical), "utf8")}\n## Project Extension\n\nCanonical prose update.\n`,
      );
    const prose = await cell.run({ kind: "doc-submit", paths: prosePaths }, binding);
    assert.equal(prose.outcome, "applied", JSON.stringify(prose));
    await waitForWorktree(cell, prose);
    const proseEvent = makeTaskEventReader({
      repoId: "materialize",
      rootDir,
    }).readEvent(prose.opId);
    assert.equal(proseEvent?.schema, "doc-event/v1");
    if (proseEvent?.schema === "doc-event/v1")
      assert.deepEqual(proseEvent.payload.changes.map(({ path: target }) => target).sort(), [...prosePaths].sort());
    write(rootDir, "context/notes.md", "# Notes\n\ncanonical\n");
    const submitted = await cell.run({ kind: "doc-submit", paths: ["context/notes.md"] }, binding);
    assert.equal(submitted.outcome, "applied");
    await waitForWorktree(cell, submitted);
    const cut = git(rootDir, "rev-parse", "HEAD"),
      count = git(rootDir, "rev-list", "--count", "HEAD");
    const first = await cell.run({ kind: "doc-materialize" }, binding),
      firstReport = materializeReport(first.evidence);
    assert.equal(first.outcome, "indeterminate", JSON.stringify(first));
    assert.equal(first.acceptance, null);
    assert.equal(first.proof, undefined);
    assert.deepEqual(firstReport.changed, []);
    assert.deepEqual(firstReport.conflicts, []);
    assert.equal(existsSync(taskRoot), true);
    for (const logical of prosePaths)
      assert.match(readFileSync(path.join(rootDir, "harness", logical), "utf8"), /Canonical prose update/u);
    assert.equal(readFileSync(path.join(rootDir, "harness/context/notes.md"), "utf8"), "# Notes\n\ncanonical\n");
    assert.equal(git(rootDir, "diff", "--name-only"), "");
    const second = await cell.run({ kind: "doc-materialize" }, binding),
      secondReport = materializeReport(second.evidence);
    assert.equal(second.outcome, "indeterminate", JSON.stringify(second));
    assert.equal(second.acceptance, null);
    assert.equal(second.proof, undefined);
    assert.equal(second.opId, first.opId);
    assert.deepEqual(secondReport.changed, []);
    assert.deepEqual(secondReport.conflicts, []);
    assert.equal(git(rootDir, "rev-parse", "HEAD"), cut);
    assert.equal(git(rootDir, "rev-list", "--count", "HEAD"), count);
    assert.equal(git(rootDir, "diff", "--name-only"), "");
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the SQLite worktree follower preserves a caller edit and recovers from its pending state", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-conflict-"));
  initRepo(rootDir);
  let injectLocal = false;
  const canonical = "# Notes\n\ncanonical\n",
    local = "# Notes\n\nlocal draft\n",
    logical = "context/notes.md";
  const cell = await openRepoCell({
      repoId: workspaceId("conflict"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "conflict-daemon",
      killpoint: (point) => {
        if (injectLocal && point === "after_git_ref_update") {
          injectLocal = false;
          write(rootDir, logical, local);
        }
      },
    }),
    binding = { actor, source: "local" as const };
  try {
    write(rootDir, logical, canonical);
    injectLocal = true;
    const submitted = await cell.run({ kind: "doc-submit", paths: [logical] }, binding);
    assert.equal(submitted.outcome, "applied");
    const gitSettled = await waitForReceipt(cell, submitted, [
      "accepted_durable",
      "projection_visible",
      "git_verified",
    ]);
    assert.equal(gitSettled.proof?.durable, true);
    assert.equal(gitSettled.proof?.canonicalVisible, true);
    assert.equal(gitSettled.proof?.worktreeVisible, false);
    assert.equal(gitSettled.worktree.state, "pending");
    assert.equal(readFileSync(path.join(rootDir, "harness", logical), "utf8"), local);

    rmSync(path.join(rootDir, "harness", logical));
    const retried = await cell.run({ kind: "doc-materialize" }, binding);
    assert.equal(retried.acceptance, null);
    assert.equal(retried.proof, undefined);
    const worktreeSettled = await waitForWorktree(cell, submitted);
    assert.equal(worktreeSettled.worktree.state, "verified");
    assert.equal(worktreeSettled.proof?.worktreeVisible, true);
    assert.equal(readFileSync(path.join(rootDir, "harness", logical), "utf8"), canonical);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("an authored branch advanced outside the daemon remains an ancestor of the asynchronously materialized cut", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-diverged-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
      repoId: workspaceId("diverged"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "diverged-daemon",
    }),
    binding = { actor, source: "local" as const };
  try {
    write(rootDir, "context/notes.md", "# Notes\n");
    git(rootDir, "add", "harness/context/notes.md");
    git(rootDir, "commit", "-qm", "external advance");
    const external = git(rootDir, "rev-parse", "HEAD"),
      result = await cell.run({ kind: "doc-submit", paths: ["context/notes.md"] }, binding);
    assert.equal(result.outcome, "applied");
    assert.equal(result.commitSha, null);
    assert.equal(cell.status().state, "attached");
    const settled = await waitForReceipt(cell, result, ["accepted_durable", "projection_visible", "git_verified"]);
    assert.equal(settled.git.state, "verified");
    await cell.close();
    assert.equal(git(rootDir, "merge-base", "--is-ancestor", external, "HEAD") === "", true);
    assert.equal(git(rootDir, "rev-parse", "HEAD"), settled.commitSha);
    assert.match(git(rootDir, "log", "-1", "--format=%s"), /^harness sqlite outbox /u);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function waitForWorktree(cell: Awaited<ReturnType<typeof openRepoCell>>, receipt: { readonly opId: string }) {
  return waitForReceipt(cell, receipt, ["accepted_durable", "projection_visible", "git_verified", "worktree_visible"]);
}

async function waitForReceipt(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  receipt: { readonly opId: string },
  waitFor: readonly ("accepted_durable" | "projection_visible" | "git_verified" | "worktree_visible")[],
) {
  const shown = await cell.run(
    {
      kind: "receipt-show",
      opId: receipt.opId,
      waitFor,
      timeoutMs: 5_000,
    },
    { actor, source: "local" },
  );
  assert.equal(shown.status, "accepted_durable", JSON.stringify(shown));
  assert.equal(shown.wait?.state, "satisfied", JSON.stringify(shown));
  return shown;
}
