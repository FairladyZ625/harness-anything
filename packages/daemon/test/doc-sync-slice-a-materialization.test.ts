// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeTaskEventStore,
  makeTaskProjection,
} from "../../kernel/src/index.ts";
import { readDocReceipt } from "../src/doc-sync-actions.ts";
import {
  canonicalRoot,
  workspaceId,
} from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";

import {
  actor,
  git,
  initRepo,
  materializeReport,
  rows,
  write,
} from "./doc-sync-slice-a.fixtures.ts";
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
    await cell.run(
      { kind: "task-create", taskId: "task-pending", title: "Pending" },
      binding,
    );
    write(rootDir, "context/pending.md", "# Pending\n");
    const applied = await cell.run(
      { kind: "doc-submit", paths: ["context/pending.md"] },
      binding,
    );
    assert.equal(applied.outcome, "applied");
    await cell.close();
    const store = makeTaskEventStore({ repoId, rootDir }),
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
    assert.equal(pending.proof?.canonicalVisible, false);
    assert.match(
      pending.nextAction ?? "",
      new RegExp(`receipt show ${event.opId}`, "u"),
    );
    projection.close();
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("materialize restores task-bootstrap and doc-event files and is idempotent", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-materialize-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
      repoId: workspaceId("materialize"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "materialize-daemon",
    }),
    binding = { actor, source: "local" as const };
  try {
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-create",
            taskId: "task-materialize",
            title: "Materialize",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    const packagePath = "tasks/task-materialize-materialize",
      taskRoot = path.join(rootDir, "harness", packagePath),
      prosePaths = [
        `${packagePath}/task_plan.md`,
        `${packagePath}/closeout.md`,
      ];
    for (const logical of prosePaths)
      write(
        rootDir,
        logical,
        `${readFileSync(path.join(rootDir, "harness", logical), "utf8")}\n## Project Extension\n\nCanonical prose update.\n`,
      );
    const prose = await cell.run(
      { kind: "doc-submit", paths: prosePaths },
      binding,
    );
    assert.equal(prose.outcome, "applied", JSON.stringify(prose));
    const proseEvent = makeTaskEventStore({
      repoId: "materialize",
      rootDir,
    }).readEvent(prose.opId);
    assert.equal(proseEvent?.schema, "doc-event/v1");
    if (proseEvent?.schema === "doc-event/v1")
      assert.deepEqual(
        proseEvent.payload.changes.map(({ path: target }) => target).sort(),
        [...prosePaths].sort(),
      );
    write(rootDir, "context/notes.md", "# Notes\n\ncanonical\n");
    assert.equal(
      (
        await cell.run(
          { kind: "doc-submit", paths: ["context/notes.md"] },
          binding,
        )
      ).outcome,
      "applied",
    );
    const cut = git(rootDir, "rev-parse", "HEAD"),
      count = git(rootDir, "rev-list", "--count", "HEAD");
    rmSync(taskRoot, { recursive: true, force: true });
    rmSync(path.join(rootDir, "harness/context/notes.md"));
    const first = await cell.run({ kind: "doc-materialize" }, binding),
      firstReport = materializeReport(first.evidence);
    assert.equal(first.outcome, "applied", JSON.stringify(first));
    assert.equal(firstReport.changed.includes("context/notes.md"), true);
    assert.equal(
      firstReport.changed.some((value) => value.startsWith(`${packagePath}/`)),
      true,
    );
    assert.equal(existsSync(taskRoot), true);
    for (const logical of prosePaths)
      assert.match(
        readFileSync(path.join(rootDir, "harness", logical), "utf8"),
        /Canonical prose update/u,
      );
    assert.equal(git(rootDir, "diff", "--name-only"), "");
    const second = await cell.run({ kind: "doc-materialize" }, binding),
      secondReport = materializeReport(second.evidence);
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

test("materialize preserves a divergent local edit in one ignored deterministic conflict scratch", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-a-conflict-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
      repoId: workspaceId("conflict"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "conflict-daemon",
    }),
    binding = { actor, source: "local" as const },
    canonical = "# Notes\n\ncanonical\n",
    local = "# Notes\n\nlocal draft\n";
  try {
    write(rootDir, "context/notes.md", canonical);
    assert.equal(
      (
        await cell.run(
          { kind: "doc-submit", paths: ["context/notes.md"] },
          binding,
        )
      ).outcome,
      "applied",
    );
    write(rootDir, "context/notes.md", local);
    const first = materializeReport(
      (await cell.run({ kind: "doc-materialize" }, binding)).evidence,
    );
    assert.deepEqual(first.changed, ["context/notes.md"]);
    assert.equal(first.conflicts.length, 1);
    assert.equal(
      readFileSync(path.join(rootDir, first.conflicts[0]!), "utf8"),
      local,
    );
    assert.equal(
      readFileSync(path.join(rootDir, "harness/context/notes.md"), "utf8"),
      canonical,
    );
    assert.equal(
      git(rootDir, "status", "--porcelain", "-uall").includes("conflict-"),
      false,
    );
    const conflicted = await cell.run(
      { kind: "doc-status", paths: ["context/notes.md"] },
      binding,
    );
    assert.equal(rows(conflicted.evidence)[0]?.state, "conflict");
    assert.match(
      conflicted.detail?.nextAction ?? "",
      /listed conflict scratch/u,
    );
    assert.doesNotMatch(
      conflicted.detail?.nextAction ?? "",
      /doc retire|blocked candidates/iu,
    );
    const second = materializeReport(
      (await cell.run({ kind: "doc-materialize" }, binding)).evidence,
    );
    assert.deepEqual(second, { changed: [], conflicts: [] });
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
      result = await cell.run(
        { kind: "doc-submit", paths: ["context/notes.md"] },
        binding,
      );
    assert.equal(result.outcome, "applied");
    assert.equal(result.commitSha, null);
    assert.equal(cell.status().state, "attached");
    await cell.close();
    assert.equal(
      git(rootDir, "merge-base", "--is-ancestor", external, "HEAD") === "",
      true,
    );
    assert.equal(
      git(rootDir, "log", "-1", "--format=%s"),
      "harness WAL flush 1-1",
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
